"""Telegram -> n8n feedback bridge for the Job Hunt Agent.

n8n runs on localhost, so Telegram can never deliver button presses to it directly.
This script long-polls Telegram's getUpdates and forwards each update to a local n8n webhook:
callback_query updates (inline-keyboard presses) go verbatim to "Job Hunt Agent - Feedback",
text messages go as {update_id, message} to "Job Hunt Agent - Search". All logic lives in n8n;
this file only moves bytes.

Guarantees:
  * At-least-once delivery: the Telegram offset is advanced ONLY after n8n returned 2xx.
    If n8n is down (connection refused) or the webhook is not registered (404, workflow
    inactive) the press is retried until it succeeds, never dropped. Exception: a text message
    for a switched-off Search workflow is skipped after SEARCH_MISSING_MAX tries (~5 min, enough
    for an n8n restart) with a one-line reply, so it cannot hold every button press behind it.
  * A press that n8n keeps rejecting with 5xx (a real workflow error) is retried 3 times,
    then logged as ERROR and skipped so one bad update cannot block the queue forever;
    the button spinner is dismissed with an explanatory toast.
  * Single instance: binds 127.0.0.1:MUTEX_PORT as a mutex, so the scheduled task can
    relaunch this every few minutes as a self-heal and only one poller ever runs
    (Telegram rejects concurrent getUpdates callers).

Files (all outside the repo, next to n8n's own data):
  %USERPROFILE%\\.n8n\\telegram_bot_token.txt        the bot token, one line (user-created)
  %USERPROFILE%\\.n8n\\telegram-feedback-offset.txt  last processed update_id + 1
  %USERPROFILE%\\.n8n\\feedback-bridge.log           rotating log, 1 MB x 3
"""
import json
import logging
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from logging.handlers import RotatingFileHandler

N8N_DIR = os.path.join(os.path.expanduser("~"), ".n8n")
TOKEN_FILE = os.path.join(N8N_DIR, "telegram_bot_token.txt")
OFFSET_FILE = os.path.join(N8N_DIR, "telegram-feedback-offset.txt")
LOG_FILE = os.path.join(N8N_DIR, "feedback-bridge.log")
WEBHOOK_URL = "http://localhost:5678/webhook/job-feedback"
SEARCH_URL = "http://localhost:5678/webhook/job-search"
FEEDBACK_TIMEOUT_S = 90
# n8n runs one production execution at a time and a webhook does not answer while queued
# (measured 2026-10-26), so a search sent during the daily run can wait up to
# EXECUTIONS_TIMEOUT (1200 s). Timing out earlier would resend it.
SEARCH_TIMEOUT_S = 1300
MUTEX_PORT = 5681
POLL_TIMEOUT_S = 50          # Telegram long-poll wait; the request itself is cheap
N8N_DOWN_WAIT_S = 30
WEBHOOK_MISSING_WAIT_S = 60
WORKFLOW_ERROR_RETRIES = 3
SEARCH_MISSING_MAX = 5       # x WEBHOOK_MISSING_WAIT_S = ~5 min before a search message is skipped

log = logging.getLogger("bridge")
log.setLevel(logging.INFO)
_h = RotatingFileHandler(LOG_FILE, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
_h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
log.addHandler(_h)


def single_instance():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", MUTEX_PORT))
        s.listen(1)
        return s
    except OSError:
        return None


def read_token():
    with open(TOKEN_FILE, encoding="utf-8") as f:
        return f.read().strip().strip('"').strip("'")


def load_offset():
    try:
        with open(OFFSET_FILE, encoding="utf-8") as f:
            return int(f.read().strip() or 0)
    except (FileNotFoundError, ValueError):
        return 0


def save_offset(n):
    tmp = OFFSET_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(str(n))
    os.replace(tmp, OFFSET_FILE)


def post_json(url, payload, timeout):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


class N8nUnavailable(Exception):
    """n8n is down or the feedback webhook is not registered - wait, do not skip."""


def route(upd):
    """(webhook_url, payload, timeout_s) for an update, or None when it is not forwarded."""
    cq = upd.get("callback_query")
    if cq is not None:
        return WEBHOOK_URL, cq, FEEDBACK_TIMEOUT_S
    msg = upd.get("message")
    if msg is not None and msg.get("text"):
        return SEARCH_URL, {"update_id": upd["update_id"], "message": msg}, SEARCH_TIMEOUT_S
    return None


def give_up(url, err, tries):
    """True when an update n8n cannot take should be skipped instead of retried forever:
    only a search message whose webhook stays unregistered (Search workflow switched off)."""
    return url == SEARCH_URL and "registered" in str(err) and tries >= SEARCH_MISSING_MAX


def forward(url, payload, timeout):
    """Returns True on 2xx. Raises N8nUnavailable when the update must NOT be skipped."""
    try:
        status, _ = post_json(url, payload, timeout=timeout)
        return 200 <= status < 300
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise N8nUnavailable("webhook not registered (workflow inactive?)")
        body = e.read()[:300].decode("utf-8", "replace")
        log.error("n8n returned HTTP %s for update: %s", e.code, body)
        return False
    except urllib.error.URLError as e:
        raise N8nUnavailable(str(e.reason))
    except (ConnectionError, TimeoutError, OSError) as e:
        # A reset mid-response (n8n dying while handling the request) surfaces as a raw
        # socket error, not a URLError. Same meaning: n8n is not healthy, keep the update.
        raise N8nUnavailable(type(e).__name__ + ": " + str(e))


def main():
    mutex = single_instance()
    if mutex is None:
        # Another poller already holds the port: the scheduled task's periodic relaunch
        # landing on a healthy instance. Exit quietly.
        return 0
    token = read_token()
    api = f"https://api.telegram.org/bot{token}/"
    offset = load_offset()
    log.info("bridge started, offset=%s, pid=%s", offset, os.getpid())
    misses = {}  # update_id -> times n8n was unavailable for it

    while True:
        try:
            _, raw = post_json(api + "getUpdates", {
                "offset": offset, "timeout": POLL_TIMEOUT_S,
                "allowed_updates": ["callback_query", "message"]}, timeout=POLL_TIMEOUT_S + 15)
            updates = json.loads(raw).get("result", [])
        except Exception as e:  # network blip, Telegram hiccup, laptop just woke
            log.warning("getUpdates failed: %s", e)
            time.sleep(15)
            continue

        for upd in updates:
            uid = upd["update_id"]
            r = route(upd)
            if r is not None:
                url, payload, timeout = r
                cq = upd.get("callback_query")
                what = "data=%s" % cq.get("data") if cq is not None else "message"  # never log message text
                delivered = False
                for attempt in range(1, WORKFLOW_ERROR_RETRIES + 1):
                    try:
                        delivered = forward(url, payload, timeout)
                    except N8nUnavailable as e:
                        misses[uid] = misses.get(uid, 0) + 1
                        if give_up(url, e, misses[uid]):
                            log.error("search webhook still missing after %s tries; skipping update %s", misses[uid], uid)
                            try:
                                post_json(api + "sendMessage", {"chat_id": payload["message"]["chat"]["id"],
                                          "text": "Search is unavailable right now (the search workflow is off). Try again later."}, 20)
                            except Exception as e2:
                                log.warning("sendMessage failed: %s", e2)
                            delivered = True  # skip
                            break
                        wait = WEBHOOK_MISSING_WAIT_S if "registered" in str(e) else N8N_DOWN_WAIT_S
                        log.warning("n8n unavailable (%s); keeping update %s, retry in %ss", e, uid, wait)
                        time.sleep(wait)
                        break  # leave the for-updates loop WITHOUT advancing the offset
                    if delivered:
                        log.info("update %s -> n8n ok (%s)", uid, what)
                        break
                    time.sleep(5 * attempt)
                else:
                    # n8n rejected it every time: a workflow bug, not an outage. Skip it
                    # so the queue keeps moving, but tell the user on the phone.
                    log.error("giving up on update %s after %s attempts (%s)",
                              uid, WORKFLOW_ERROR_RETRIES, what)
                    if cq is not None:
                        try:
                            post_json(api + "answerCallbackQuery", {
                                "callback_query_id": cq["id"], "show_alert": True,
                                "text": "Could not record this - n8n rejected it. See feedback-bridge.log."}, 20)
                        except Exception as e:
                            log.warning("answerCallbackQuery failed: %s", e)
                    delivered = True  # skip
                if not delivered:
                    break  # n8n unavailable: stop here, same offset next round
            offset = uid + 1
            save_offset(offset)
            misses.pop(uid, None)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        log.exception("bridge crashed")
        raise
