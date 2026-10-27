"""Checks search/build_workflow.py's build() against fresh backups of the live workflows.
Run from the repo root: python3 -I search/test_build_workflow.py
Needs backups/job-hunt-agent-*.json and backups/feedback-*.json (git-ignored, taken before a build)."""
import glob
import importlib.util
import json
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("bw", os.path.join(HERE, "build_workflow.py"))
bw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bw)


def newest(pattern):
    return json.load(open(sorted(glob.glob(os.path.join(REPO, "backups", pattern)))[-1], encoding="utf-8"))


main_wf, feedback_wf = newest("job-hunt-agent-2*.json"), newest("feedback-2*.json")
cfg = {"workflows": {"MAINID": "job-hunt-agent.workflow.json", "ERRID": "job-hunt-agent.error-alert.workflow.json"},
       "tables": {"ARCHIVEID": "YOUR_JOB_ARCHIVE_TABLE_ID", "FEEDBACKID": "YOUR_JOB_FEEDBACK_TABLE_ID"}}
wf = bw.build(main_wf, feedback_wf, cfg)
nodes = {n["name"]: n for n in wf["nodes"]}
C = wf["connections"]
blob = json.dumps(wf, ensure_ascii=False)
chat_id = next(n["parameters"]["chatId"] for n in main_wf["nodes"] if n["name"] == "Telegram")


def targets(name, out=0):
    outs = C.get(name, {}).get("main", [])
    return [(t["node"], t["index"]) for t in (outs[out] if out < len(outs) else []) or []]


# every node of the planned graph exists; Reddit is left out
NEW = ["Search Webhook", "Parse Message", "Route", "Interpret Query", "Build Plan", "Telegram: Ack",
       "Fetch WWR Category", "Fetch Jobicy Industry", "Himalayas Search Terms", "Fetch Himalayas",
       "Normalize Himalayas", "Merge Search Sources", "Add Locations", "Prefilter", "Has Candidates", "AI Check",
       "Apply Check", "Format Page", "Telegram: Send", "Prep Save", "Has Jobs", "Insert Archive",
       "Feedback Event", "Record Feedback", "Sheet Row", "Append to Sheet", "Save Reply"]
COPIED = ["Fetch RemoteOK", "Fetch Freelancer", "Freelancer Queries", "Normalize Freelancer",
          "Fetch LinkedIn Alerts", "Normalize LinkedIn", "Merge WWR", "Merge Jobicy", "Normalize HN", "Merge"]
for name in NEW + COPIED:
    assert name in nodes, name
assert not [n for n in nodes if "Reddit" in n or n == "Merge Social"]
assert len(nodes) == len(wf["nodes"]), "duplicate node names"

# wiring
assert ("Merge", 9) in targets("Normalize LinkedIn")
assert targets("Build Plan")[0] == ("Telegram: Ack", 0)
assert ("Freelancer Queries", 0) in targets("Build Plan") and ("Himalayas Search Terms", 0) in targets("Build Plan")
assert [t for t, _ in targets("Route", 0)] == ["Interpret Query"]
assert [t for t, _ in targets("Route", 1)] == ["Format Page"]
assert [t for t, _ in targets("Route", 2)] == ["Prep Save"]
assert [t for t, _ in targets("Route", 3)] == ["Telegram: Send"]
assert targets("Has Candidates", 0) == [("AI Check", 0)] and targets("Has Candidates", 1) == [("Apply Check", 0)]
assert targets("Has Jobs", 0) == [("Insert Archive", 0)] and targets("Has Jobs", 1) == [("Telegram: Send", 0)]
assert ("Merge WWR", 3) in targets("Fetch WWR Category") and nodes["Merge WWR"]["parameters"]["numberInputs"] == 4
assert ("Merge Jobicy", 2) in targets("Fetch Jobicy Industry") and nodes["Merge Jobicy"]["parameters"]["numberInputs"] == 3
assert targets("Merge Search Sources") == [("Add Locations", 0)] and targets("Add Locations") == [("Prefilter", 0)]
assert targets("Merge") == [("Merge Search Sources", 0)] and targets("Normalize Himalayas") == [("Merge Search Sources", 1)]
fed = {(t, i) for src in C for out in C[src]["main"] for t, i in ((x["node"], x["index"]) for x in out or [])}
assert all(("Merge", i) in fed for i in range(10)), "a Merge input is unwired"
for src, outs in C.items():  # every connection names real nodes
    assert src in nodes, src
    assert all(x["node"] in nodes for out in outs["main"] for x in out or []), src

# every $('X') points at a node that exists
for ref in set(re.findall(r"\$\('([^']+)'\)", blob)):
    assert ref in nodes, f"$('{ref}') has no node"

# patches on the copies
assert "MAX_AGE_DAYS = 30" in nodes["Normalize Freelancer"]["parameters"]["jsCode"]
assert "newer_than:30d" in nodes["Fetch LinkedIn Alerts"]["parameters"]["filters"]["q"]
assert "$('Build Plan')" in nodes["Freelancer Queries"]["parameters"]["jsCode"]
for name, n in nodes.items():
    if name.startswith("Normalize "):
        assert "slice(0, 1500)" not in json.dumps(n), name
assert "slice(0, 4000)" in nodes["Normalize RemoteOK"]["parameters"]["jsCode"]

# Groq + data-table settings
assert nodes["AI Check"]["parameters"]["options"]["batching"]["batch"] == {"batchSize": 1, "batchInterval": 35000}
for g in ("Interpret Query", "AI Check"):
    assert nodes[g]["credentials"] == next(n for n in main_wf["nodes"] if n["name"] == "Groq: Score Jobs")["credentials"]
    assert "gpt-oss-20b" in nodes[g]["parameters"]["jsonBody"] and "}}" not in nodes[g]["parameters"]["jsonBody"][3:-2]
assert nodes["Insert Archive"]["parameters"]["dataTableId"]["value"] == "ARCHIVEID"
assert nodes["Search Webhook"]["parameters"]["path"] == "job-search"
assert wf["settings"]["errorWorkflow"] == "ERRID" and wf["settings"]["timezone"] == "Asia/Bangkok"

# chat id: substituted in the output, absent from every file git would track under search/
assert "__CHAT_ID__" not in blob
assert f"ALLOWED_CHAT_ID = '{chat_id}'" in nodes["Parse Message"]["parameters"]["jsCode"]
tracked = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "search"],
                         cwd=REPO, capture_output=True, text=True, check=True).stdout.split()
assert tracked and not any(chat_id in open(os.path.join(REPO, f), encoding="utf-8", errors="ignore").read() for f in tracked)

# a rebuild is byte-identical (stable ids, so a redeploy keeps the webhook)
assert json.dumps(bw.build(main_wf, feedback_wf, cfg)) == json.dumps(wf)
print("ok")
