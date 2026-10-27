"""Routing check for telegram-feedback-bridge.py. Run: python3 -I scripts/test_bridge_routing.py"""
import importlib.util
import os

spec = importlib.util.spec_from_file_location(
    "bridge", os.path.join(os.path.dirname(os.path.abspath(__file__)), "telegram-feedback-bridge.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

cb = {"update_id": 7, "callback_query": {"id": "x", "data": "fb:save:12"}}
assert b.route(cb) == (b.WEBHOOK_URL, cb["callback_query"], 90)

msg = {"update_id": 8, "message": {"chat": {"id": 5}, "text": "data entry"}}
url, payload, t = b.route(msg)
assert url == b.SEARCH_URL == "http://localhost:5678/webhook/job-search"
assert payload == {"update_id": 8, "message": msg["message"]}
assert t == 1300  # a queued search can wait up to EXECUTIONS_TIMEOUT (1200 s) for n8n's single slot

assert b.route({"update_id": 9, "message": {"chat": {"id": 5}, "sticker": {}}}) is None  # no text
assert b.route({"update_id": 10, "edited_message": {"text": "x"}}) is None
# A switched-off Search workflow (404) must not block button presses forever: give up on a
# message after SEARCH_MISSING_MAX tries. n8n being down, or the Feedback webhook missing, still waits.
missing = b.N8nUnavailable("webhook not registered (workflow inactive?)")
down = b.N8nUnavailable("Connection refused")
assert b.SEARCH_MISSING_MAX * b.WEBHOOK_MISSING_WAIT_S >= 240  # outlasts an n8n restart
assert not b.give_up(b.SEARCH_URL, missing, b.SEARCH_MISSING_MAX - 1)
assert b.give_up(b.SEARCH_URL, missing, b.SEARCH_MISSING_MAX)
assert not b.give_up(b.SEARCH_URL, down, 99)
assert not b.give_up(b.WEBHOOK_URL, missing, 99)
print("ok")
