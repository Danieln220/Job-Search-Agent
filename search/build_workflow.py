"""Assemble the "Job Hunt Agent — Search" workflow from search/nodes/*.js, search/prompts/*.md and
copies of the live main workflow's fetch + normalize nodes. The main workflow is only read.

Run from the repo root:
  python3 -I search/build_workflow.py            # writes search/dist/search.workflow.json
  python3 -I search/build_workflow.py --deploy   # also creates/updates it in n8n, never activates

Instance ids come from the git-ignored sanitize.config.json (looked up by export filename) and
credentials from the live nodes, so this file carries none of them.
"""
import copy
import json
import os
import re
import subprocess
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
N8N = "http://localhost:5678"
NAME = "Job Hunt Agent — Search"
EXPORT = "job-hunt-agent.search.workflow.json"
SEARCH_MODEL = "openai/gpt-oss-20b"
CHECK_BATCH_INTERVAL_MS = 35000  # ~4,400 tokens per AI Check batch vs gpt-oss-20b's 8,000 TPM
EXCLUDE = {"Reddit Subs", "Fetch Reddit", "Normalize Reddit", "Merge Social"}  # 60 s spacing, ~1 job/month
UA = {"parameters": [{"name": "User-Agent", "value": "Mozilla/5.0 (personal job digest)"}]}
RETRY = {"retryOnFail": True, "maxTries": 2, "waitBetweenTries": 5000}
SOFT = {**RETRY, "onError": "continueRegularOutput"}
NS = uuid.UUID("5d0c3e2a-7b1f-4c8e-9a64-3f2b8d1e0c55")


def uid(name, kind="node"):
    # Stable ids: a rebuild + PUT keeps the same node ids and webhook registration.
    return str(uuid.uuid5(NS, f"{kind}:{name}"))


def read(*parts):
    return open(os.path.join(HERE, *parts), encoding="utf-8").read()


def js_str(s):
    # JS string literal with braces escaped, so no "}}" can end the n8n {{ }} expression early.
    return json.dumps(s).replace("{", "\\u007b").replace("}", "\\u007d")


def groq_body(system, user_expr):
    return ("={{ JSON.stringify({ model: '" + SEARCH_MODEL + "', reasoning_effort: 'low', temperature: 0, "
            "response_format: { type: 'json_object' }, messages: [ { role: 'system', content: " + js_str(system) +
            " }, { role: 'user', content: " + user_expr + " } ] }) }}")


def by_filename(cfg_section, filename):
    return next(k for k, v in cfg_section.items() if v == filename)


def replace_once(s, old, new, where):
    assert s.count(old) == 1, f"{where}: expected exactly one {old!r}"
    return s.replace(old, new)


def condition(left, op_type, op, right=""):
    single = op in ("true", "false", "empty", "notEmpty", "exists", "notExists")
    return {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                           "combinator": "and",
                           "conditions": [{"id": uid(left, "cond"), "leftValue": left, "rightValue": right,
                                           "operator": {"type": op_type, "operation": op, **({"singleValue": True} if single else {})}}]},
            "looseTypeValidation": True, "options": {}}


def build(main_wf, feedback_wf, cfg):
    main = {n["name"]: n for n in main_wf["nodes"]}
    fb = {n["name"]: n for n in feedback_wf["nodes"]}
    MC = main_wf["connections"]
    chat_id = str(main["Telegram"]["parameters"]["chatId"])
    tg_cred, groq_cred = main["Telegram"]["credentials"], main["Groq: Score Jobs"]["credentials"]

    # 1. Copy every node reachable from Schedule Guard up to and including Merge, minus Reddit.
    heads = [t["node"] for out in MC["Schedule Guard"]["main"] for t in out if t["node"] not in EXCLUDE]
    order, queue = [], list(heads)
    while queue:
        name = queue.pop(0)
        if name in order or name in EXCLUDE:
            continue
        order.append(name)
        if name != "Merge":
            queue += [t["node"] for out in MC.get(name, {}).get("main", []) for t in out or []]
    xs = [main[n]["position"][0] for n in order]
    ys = [main[n]["position"][1] for n in order]
    dx, y0, y1 = 1320 - min(xs), min(ys), max(ys)
    ymid = (y0 + y1) // 2

    nodes, conns = {}, {}

    def add(name, type_, params, pos, version=None, **extra):
        nodes[name] = {"id": uid(name), "name": name, "type": type_, "typeVersion": version,
                       "position": pos, "parameters": params, **extra}

    def code(name, js, pos, **extra):
        add(name, "n8n-nodes-base.code", {"jsCode": js}, pos, 2, **extra)

    def link(src, dst, idx=0, out=0):
        outs = conns.setdefault(src, {"main": []})["main"]
        while len(outs) <= out:
            outs.append([])
        outs[out].append({"node": dst, "type": "main", "index": idx})

    for name in order:
        n = copy.deepcopy(main[name])
        n["id"] = uid(name)
        n["position"] = [n["position"][0] + dx, n["position"][1]]
        if "webhookId" in n:
            n["webhookId"] = uid(name, "webhook")
        nodes[name] = n
    for name in order:
        if name == "Merge":
            continue
        for out_i, out in enumerate(MC.get(name, {}).get("main", [])):
            for t in out or []:
                if t["node"] in EXCLUDE:
                    continue
                link(name, t["node"], t["index"], out_i)
    link("Normalize LinkedIn", "Merge", 9)

    # 2. Patches on the copies.
    p = nodes["Freelancer Queries"]["parameters"]
    p["jsCode"] = ("// Search version: Freelancer.com terms come from the user's request (Build Plan).\n"
                   "return $('Build Plan').first().json.freelancer_queries.map(q => ({ json: { q, qe: encodeURIComponent(q) } }));\n")
    p = nodes["Normalize Freelancer"]["parameters"]
    p["jsCode"] = replace_once(p["jsCode"], "MAX_AGE_DAYS = 3;", "MAX_AGE_DAYS = 30;", "Normalize Freelancer")
    for name in order:
        if name.startswith("Normalize ") and "jsCode" in nodes[name]["parameters"]:
            nodes[name]["parameters"]["jsCode"] = nodes[name]["parameters"]["jsCode"].replace("slice(0, 1500)", "slice(0, 4000)")
    f = nodes["Fetch LinkedIn Alerts"]["parameters"]["filters"]
    f["q"] = replace_once(f["q"], "newer_than:3d", "newer_than:30d", "Fetch LinkedIn Alerts")
    nodes["Merge WWR"]["parameters"]["numberInputs"] += 1
    nodes["Merge Jobicy"]["parameters"]["numberInputs"] += 1
    wwr_idx = nodes["Merge WWR"]["parameters"]["numberInputs"] - 1
    jobicy_idx = nodes["Merge Jobicy"]["parameters"]["numberInputs"] - 1

    # 3. Entry: webhook -> parse -> route -> interpret -> plan.
    add("Search Webhook", "n8n-nodes-base.webhook",
        {"httpMethod": "POST", "path": "job-search", "responseMode": "onReceived", "options": {}},
        [0, ymid], 2, webhookId=uid("Search Webhook", "webhook"))
    code("Parse Message", read("nodes", "parse-message.js").replace("__CHAT_ID__", chat_id), [220, ymid])
    rules = [{"outputKey": k, "renameOutput": True,
              "conditions": condition("={{ $json.kind }}", "string", "equals", k)["conditions"]}
             for k in ("search", "more", "save", "help")]
    add("Route", "n8n-nodes-base.switch", {"rules": {"values": rules}, "options": {}}, [440, ymid], 3.4)
    http_groq = {"method": "POST", "url": "https://api.groq.com/openai/v1/chat/completions",
                 "authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth",
                 "sendBody": True, "specifyBody": "json"}
    add("Interpret Query", "n8n-nodes-base.httpRequest",
        {**http_groq, "jsonBody": groq_body(read("prompts", "interpret.md"), "$json.query"), "options": {"timeout": 45000}},
        [660, ymid - 200], 4.4, credentials=copy.deepcopy(groq_cred), **SOFT)
    code("Build Plan", read("nodes", "build-plan.js"), [880, ymid - 200])
    tg_params = {"chatId": "={{ $json.chat_id }}", "text": "={{ $json.text }}",
                 "additionalFields": {"appendAttribution": False, "disable_web_page_preview": True, "parse_mode": "HTML"}}
    # The ack must never stop the search, so a failed ack is swallowed.
    add("Telegram: Ack", "n8n-nodes-base.telegram", copy.deepcopy(tg_params), [1100, y0 - 200], 1.2,
        webhookId=uid("Telegram: Ack", "webhook"), credentials=copy.deepcopy(tg_cred), **SOFT)
    link("Search Webhook", "Parse Message")
    link("Parse Message", "Route")
    link("Route", "Interpret Query", out=0)
    link("Interpret Query", "Build Plan")
    link("Build Plan", "Telegram: Ack")  # first, so the ack goes out before any fetch (v1 order)
    for h in heads:
        link("Build Plan", h)

    # 4. Request-specific feeds and Himalayas.
    add("Fetch WWR Category", "n8n-nodes-base.rssFeedRead",
        {"url": "={{ $('Build Plan').first().json.wwr_category_url }}", "options": {}}, [1320, y1 + 200], 1.2, **SOFT)
    add("Fetch Jobicy Industry", "n8n-nodes-base.httpRequest",
        {"url": "={{ $('Build Plan').first().json.jobicy_industry_url }}", "sendHeaders": True,
         "headerParameters": copy.deepcopy(UA), "options": {"timeout": 30000}}, [1320, y1 + 350], 4.4, **SOFT)
    code("Himalayas Search Terms", "return $('Build Plan').first().json.himalayas_urls.map(url => ({ json: { url } }));\n",
         [1320, y1 + 550])
    add("Fetch Himalayas", "n8n-nodes-base.httpRequest",
        {"url": "={{ $json.url }}", "sendHeaders": True, "headerParameters": copy.deepcopy(UA),
         "options": {"timeout": 30000}}, [1540, y1 + 550], 4.4, **SOFT)
    code("Normalize Himalayas", read("nodes", "normalize-himalayas.js"), [1760, y1 + 550])
    for n in ("Fetch WWR Category", "Fetch Jobicy Industry", "Himalayas Search Terms"):
        link("Build Plan", n)
    link("Fetch WWR Category", "Merge WWR", wwr_idx)
    link("Fetch Jobicy Industry", "Merge Jobicy", jobicy_idx)
    link("Himalayas Search Terms", "Fetch Himalayas")
    link("Fetch Himalayas", "Normalize Himalayas")

    # 5. Filter, AI check, page.
    mx = nodes["Merge"]["position"][0]
    add("Merge Search Sources", "n8n-nodes-base.merge", {"numberInputs": 2}, [mx + 220, ymid], 3.2)
    code("Add Locations", read("nodes", "add-locations.js"), [mx + 330, ymid + 200])
    code("Prefilter", read("nodes", "prefilter.js"), [mx + 440, ymid])
    add("Has Candidates", "n8n-nodes-base.if", condition("={{ $json.empty }}", "boolean", "false"), [mx + 660, ymid], 2.3)
    plan = "$('Build Plan').first().json"
    check_user = f"'Request: ' + {plan}.query + '\\nLevel: ' + {plan}.level + '\\nJobs: ' + $json.jobs_json"
    add("AI Check", "n8n-nodes-base.httpRequest",
        {**http_groq, "jsonBody": groq_body(read("prompts", "check.md"), check_user),
         "options": {"batching": {"batch": {"batchSize": 1, "batchInterval": CHECK_BATCH_INTERVAL_MS}}, "timeout": 45000}},
        [mx + 880, ymid - 100], 4.4, credentials=copy.deepcopy(groq_cred), **SOFT)
    code("Apply Check", read("nodes", "apply-check.js"), [mx + 1100, ymid])
    code("Format Page", read("nodes", "format-page.js"), [mx + 1320, ymid])
    add("Telegram: Send", "n8n-nodes-base.telegram", copy.deepcopy(tg_params), [mx + 1540, ymid], 1.2,
        webhookId=uid("Telegram: Send", "webhook"), credentials=copy.deepcopy(tg_cred), **RETRY)
    link("Merge", "Merge Search Sources", 0)
    link("Normalize Himalayas", "Merge Search Sources", 1)
    link("Merge Search Sources", "Add Locations")
    link("Add Locations", "Prefilter")
    link("Prefilter", "Has Candidates")
    link("Has Candidates", "AI Check", out=0)
    link("Has Candidates", "Apply Check", out=1)
    link("AI Check", "Apply Check")
    link("Apply Check", "Format Page")
    link("Format Page", "Telegram: Send")
    link("Route", "Format Page", out=1)
    link("Route", "Telegram: Send", out=3)

    # 6. save N -> archive row + feedback event + sheet row, like the digest's Save button.
    sy = y1 + 900
    code("Prep Save", read("nodes", "prep-save.js"), [660, sy])
    add("Has Jobs", "n8n-nodes-base.if", condition("={{ $json.reply_only === true }}", "boolean", "false"), [880, sy], 2.3)
    archive_cols = ("url", "title", "company", "source", "posted_at", "first_seen", "delivered")
    add("Insert Archive", "n8n-nodes-base.dataTable",
        {"resource": "row", "operation": "insert",
         "dataTableId": {"__rl": True, "mode": "id", "value": by_filename(cfg["tables"], "YOUR_JOB_ARCHIVE_TABLE_ID")},
         "columns": {"mappingMode": "defineBelow", "value": {c: "={{ $json.%s }}" % c for c in archive_cols},
                     "matchingColumns": [], "schema": []},
         "options": {}}, [1100, sy], fb["Record Feedback"]["typeVersion"])
    code("Feedback Event", read("nodes", "feedback-event.js"), [1320, sy])
    for name, x in (("Record Feedback", 1540), ("Append to Sheet", 1980)):
        n = copy.deepcopy(fb[name])
        n.update(id=uid(name), position=[x, sy])
        nodes[name] = n
    code("Sheet Row", "return $('Feedback Event').all();\n", [1760, sy])
    code("Save Reply", read("nodes", "save-reply.js"), [2200, sy])
    link("Route", "Prep Save", out=2)
    link("Prep Save", "Has Jobs")
    link("Has Jobs", "Insert Archive", out=0)
    link("Has Jobs", "Telegram: Send", out=1)
    for a, b in (("Insert Archive", "Feedback Event"), ("Feedback Event", "Record Feedback"),
                 ("Record Feedback", "Sheet Row"), ("Sheet Row", "Append to Sheet"),
                 ("Append to Sheet", "Save Reply"), ("Save Reply", "Telegram: Send")):
        link(a, b)

    settings = {"executionOrder": "v1", "timezone": "Asia/Bangkok", "saveDataErrorExecution": "all",
                "saveDataSuccessExecution": "all", "saveManualExecutions": True,
                "errorWorkflow": by_filename(cfg["workflows"], "job-hunt-agent.error-alert.workflow.json")}
    return {"name": NAME, "nodes": list(nodes.values()), "connections": conns, "settings": settings}


def api(method, path, body=None):
    key = json.load(open(os.path.join(REPO, ".mcp.json"), encoding="utf-8"))["mcpServers"]["n8n-mcp"]["env"]["N8N_API_KEY"]
    cmd = ["curl", "-s", "-m", "90", "-X", method, "-H", f"X-N8N-API-KEY: {key}", "-H", "Accept: application/json",
           "-H", "Content-Type: application/json", f"{N8N}/api/v1{path}"]
    data = None
    if body is not None:
        cmd += ["--data-binary", "@-"]
        data = json.dumps(body).encode("utf-8")
    out = json.loads(subprocess.run(cmd, input=data, capture_output=True, check=True).stdout.decode("utf-8"))
    if "id" not in out:
        sys.exit(f"n8n API {method} {path} failed: {out.get('message', out)}")
    return out


def main():
    cfg_path = os.path.join(REPO, "sanitize.config.json")
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    wfs = cfg["workflows"]
    main_wf = api("GET", "/workflows/" + by_filename(wfs, "job-hunt-agent.workflow.json"))
    feedback_wf = api("GET", "/workflows/" + by_filename(wfs, "job-hunt-agent.feedback.workflow.json"))
    wf = build(main_wf, feedback_wf, cfg)
    os.makedirs(os.path.join(HERE, "dist"), exist_ok=True)
    out = os.path.join(HERE, "dist", "search.workflow.json")
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(wf, fh, indent=1, ensure_ascii=False)
    print(f"wrote {os.path.relpath(out, REPO)}: {len(wf['nodes'])} nodes")
    if "--deploy" not in sys.argv:
        return
    existing = next((k for k, v in wfs.items() if v == EXPORT), None)
    res = api("PUT", f"/workflows/{existing}", wf) if existing else api("POST", "/workflows", wf)
    if not existing:
        wfs[res["id"]] = EXPORT
        with open(cfg_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(cfg, fh, indent=2)
            fh.write("\n")
    print(f"{'updated' if existing else 'created'} workflow {res['id']} ({len(res['nodes'])} nodes, active={res.get('active')})")


if __name__ == "__main__":
    main()
