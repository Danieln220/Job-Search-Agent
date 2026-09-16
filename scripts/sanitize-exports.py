"""Regenerate the public, sanitized workflow exports from the LIVE n8n instance.

Whitelist sanitizer: only known-safe fields survive, instance-specific ids become
placeholders, and the result is scanned for anything secret-shaped before it is written.
Run from the repo root:  python scripts/sanitize-exports.py

Reads the n8n API key from .mcp.json (git-ignored). Fetches via curl because Python's
urllib gets its connection reset by this n8n build on the 100 KB+ main-workflow payload.
"""
import json, os, re, subprocess, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N8N = "http://localhost:5678"
# Instance-specific ids live in the git-ignored sanitize.config.json next to .mcp.json:
#   {"workflows": {"<workflow id>": "<export filename>", ...},
#    "tables":    {"<data table id>": "YOUR_..._TABLE_ID", ...}}
# so this script carries none of them. The chat id and sheet id are discovered from the live
# workflow (Telegram node chatId, Google Sheets documentId) rather than configured.
_cfg = json.load(open(os.path.join(REPO, "sanitize.config.json"), encoding="utf-8"))
WORKFLOWS = _cfg["workflows"]
TABLE_PLACEHOLDERS = _cfg["tables"]
NODE_KEEP = {"id", "name", "type", "typeVersion", "position", "parameters", "credentials",
             "disabled", "notes", "notesInFlow", "retryOnFail", "maxTries", "waitBetweenTries",
             "onError", "alwaysOutputData", "executeOnce", "webhookId"}
SETTINGS_DROP = {"errorWorkflow", "callerPolicy", "executionTimeout"}

SECRET_SHAPES = [
    (r"\b\d{8,12}:[A-Za-z0-9_-]{30,}\b", "telegram bot token"),
    (r"\bgsk_[A-Za-z0-9]{20,}\b", "groq key"),
    (r"\bsk-[A-Za-z0-9_-]{20,}\b", "openai-style key"),
    (r"\bBearer\s+[A-Za-z0-9._-]{20,}", "bearer token"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private key"),
    (r"\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}", "JWT"),
    (r"[A-Za-z0-9_-]{24,}@[a-z0-9-]+\.iam\.gserviceaccount\.com", "service account email"),
]


def fetch(wid):
    key = json.load(open(os.path.join(REPO, ".mcp.json"), encoding="utf-8"))["mcpServers"]["n8n-mcp"]["env"]["N8N_API_KEY"]
    out = subprocess.run(["curl", "-s", "-m", "90", "-H", f"X-N8N-API-KEY: {key}", "-H", "Accept: application/json",
                          f"{N8N}/api/v1/workflows/{wid}"], capture_output=True, check=True).stdout
    return json.loads(out.decode("utf-8"))


def discover_literals(wfs):
    """Chat id from any Telegram node's chatId; sheet id from any Google Sheets documentId."""
    chat_ids, sheet_ids = set(), set()
    for wf in wfs.values():
        for n in wf["nodes"]:
            p = n.get("parameters", {})
            if n["type"] == "n8n-nodes-base.telegram" and str(p.get("chatId", "")).isdigit():
                chat_ids.add(str(p["chatId"]))
            if n["type"] == "n8n-nodes-base.googleSheets":
                for k in ("documentId", "sheetName"):
                    v = str((p.get(k) or {}).get("value", ""))
                    m = re.search(r"/spreadsheets/d/([A-Za-z0-9_-]{20,})", v) or re.fullmatch(r"([A-Za-z0-9_-]{25,})", v)
                    if m: sheet_ids.add(m.group(1))
    return chat_ids, sheet_ids


def sanitize(wf, chat_ids, sheet_ids):
    out = {"name": wf["name"], "nodes": [], "connections": wf["connections"],
           "settings": {k: v for k, v in (wf.get("settings") or {}).items() if k not in SETTINGS_DROP}}
    for n in wf["nodes"]:
        node = {k: v for k, v in n.items() if k in NODE_KEEP}
        if "credentials" in node:  # names only, never ids
            node["credentials"] = {t: {"name": c["name"]} for t, c in node["credentials"].items()}
        out["nodes"].append(node)
    blob = json.dumps(out, ensure_ascii=False, indent=2)
    for cid in chat_ids:
        blob = blob.replace(f'"{cid}"', '"YOUR_TELEGRAM_CHAT_ID"').replace(f"'{cid}'", "'YOUR_TELEGRAM_CHAT_ID'")
    for sid in sheet_ids:
        blob = blob.replace(sid, "YOUR_GOOGLE_SHEET_ID")
    for tid, ph in TABLE_PLACEHOLDERS.items():
        blob = blob.replace(tid, ph)
    # Never let a fresh import auto-send a CV: force the flag off and blank the path.
    blob = re.sub(r"CV_READY\s*=\s*true", "CV_READY = false", blob)
    blob = re.sub(r'"fileSelector":\s*"[^"]*"', '"fileSelector": "REPLACE_WITH_CV_PATH"', blob)
    return blob


def scan(blob, chat_ids, sheet_ids, name):
    problems = []
    for pat, label in SECRET_SHAPES:
        for m in re.finditer(pat, blob):
            problems.append(f"{label}: ...{blob[max(0, m.start()-20):m.end()+10]}...")
    for cid in chat_ids:
        if cid in blob: problems.append(f"chat id {cid} still present")
    for sid in sheet_ids:
        if sid in blob: problems.append("sheet id still present")
    for tid in TABLE_PLACEHOLDERS:
        if tid in blob: problems.append(f"table id {tid} still present")
    if re.search(r'"id":\s*"[A-Za-z0-9]{16}"', blob):  # n8n credential/workflow ids are 16 chars
        problems.append("16-char instance id survived (credential id?)")
    if problems:
        print(f"  SCAN FAILED for {name}:"); [print("   -", p) for p in problems]
        return False
    return True


def main():
    wfs = {wid: fetch(wid) for wid in WORKFLOWS}
    chat_ids, sheet_ids = discover_literals(wfs)
    ok = True
    for wid, fn in WORKFLOWS.items():
        blob = sanitize(wfs[wid], chat_ids, sheet_ids)
        if not scan(blob, chat_ids, sheet_ids, fn):
            ok = False; continue
        with open(os.path.join(REPO, fn), "w", encoding="utf-8", newline="\n") as f:
            f.write(blob + "\n")
        n = len(wfs[wid]["nodes"])
        ph = sorted(set(re.findall(r"YOUR_[A-Z_]+|REPLACE_WITH_[A-Z_]+", blob)))
        print(f"  wrote {fn}: {n} nodes, scan CLEAN, placeholders {ph}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
