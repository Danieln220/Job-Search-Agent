# Tailored CV per pitched job — design

Date: 2026-10-01 · Status: approved in chat, not built
Workflow: "Job Hunt Agent" (main, apply-assist chain)

## Goal

When the apply-assist chain sends a pitch (score >= 80, not region-restricted, max 3/day),
the attached CV is rewritten for that job instead of the same fixed PDF every time.
It must never claim anything Daniel can't back up. Reliability rule: a tailoring failure
must never block the pitch — the job falls back to the fixed PDF.

## 1. Master CV (single source of truth)

File `~/.n8n-files/cv/master-cv.json` (inside n8n's file sandbox; NOT in the repo — it holds
the phone number). The repo gets `cv/master-cv.example.json` with fake data.

Fixed fields, never written by the LLM: name, phone (054-329-2555, unchanged), email, GitHub,
LinkedIn, location line **"Worldwide · remote"**, education, languages, the Japan
volunteering entry, project names and dates.

Projects (each bullet carries a stable id; numbers are copied verbatim from the source):

| id | project | evidence |
|---|---|---|
| `job_hunt_agent` | Job Hunt Agent (n8n) | this repo, public `Job-Search-Agent` |
| `lead_to_crm` | Lead-to-CRM Automation (n8n, HubSpot) | `~/code/lead-to-crm-automation`, M1–M9 tested |
| `doc_qa` | Document Q&A Assistant (RAG) | `~/code/document-qa-assistant`, public |
| `hundo` | Hundo — self-correcting agentic AI analyst | current CV |
| `doc_search_hackathon` | AI-Powered Document Search & Summarization | current CV |
| `mcp_dev_assistant` | Agentic Dev Assistant (smolagents + custom MCP server) | `GEN_AI_172/week19/MCPagent` |
| `rag_chatbot` | RAG Chatbot (LangChain + Pinecone) | `GEN_AI_172/week15/Chatbot` |
| `football` | Football Match Outcome Prediction (+ Tableau) | public `football-match-prediction` |
| `flower_cnn` | Flower Image Classifier (CNN) | current CV |

Dropped by the user: Expat Lead Finder, used-car website.
Not backed by any code, therefore excluded: Make.com, WhatsApp chatbots.
Football wording rule: never say "predicts matches before kickoff" (halftime score is the
top feature).

Skills: a flat list of skill labels (the LLM returns labels; matched case-insensitively,
unknown labels dropped) = current CV skills + n8n, JavaScript,
TypeScript/React, SQLite, Docker, REST APIs/webhooks, HubSpot API, Google APIs, Telegram Bot
API, ChromaDB, BM25/hybrid search, OCR (Tesseract), Groq, Gemini, DeepSeek, LangChain,
Pinecone, smolagents, MCP, LiteLLM, Streamlit, Tableau, Claude Code.

## 2. LLM step "Groq: Tailor CV"

Model `openai/gpt-oss-120b`, temperature 0.2, JSON only. Input: master CV (compact) + job
(title, company, source, description sliced to ~1200 chars, untrusted-text warning as in the
other prompts). Output:

```json
{ "headline": "AI Automation Engineer",
  "summary": "2-3 sentences",
  "skills": ["n8n", "python", "..."],
  "projects": [ { "id": "job_hunt_agent",
                  "bullets": [ { "id": "jha_1", "text": "possibly reworded" } ] } ] }
```

3–4 projects, 2–4 bullets each. Rewording allowed (user chose both: selection + rewording).

## 3. Guardrails ("Build Tailored CV" Code node, no LLM)

1. Unknown project / bullet / skill ids → dropped.
2. Per reworded bullet, compared with ITS original bullet:
   - every number in the new text must occur in the original;
   - every tech/product term in the new text must occur in the original or the skills list;
   - length within 60–140% of the original.
   Any failure → that bullet reverts to the original text (per bullet, not whole CV).
3. Summary: same number + term checks against the whole master; failure → master's base summary.
4. Unparseable JSON, < 2 valid projects, or Groq error → whole job uses the fixed PDF.
5. Log per job: `CV tailored for <company>: P projects, B bullets (R reworded, V reverted: <reasons>), summary OK|reverted|fallback`.

## 4. Workflow wiring

```
Apply Prep → Groq: Draft Pitch → Prep CV Send → Read Master CV (executeOnce)
  → Groq: Tailor CV (batchSize 1, batchInterval ~60s) → Build Tailored CV
  → Render CV PDF (HTTP POST 127.0.0.1:5682, response = file, timeout 30s, onError continue)
  → Has PDF? ─ yes → Telegram: Send CV
              └ no  → Read CV (fixed PDF) → Telegram: Send CV
```

- Caption and `reply_to_message_id` (threading under the job card) unchanged.
- Filename `Daniel_Novitzki_CV_<Company>.pdf`.
- Rate limit: ~5–6k tokens/call vs 8,000 TPM → ~60 s spacing; +~3 min per run with 3 pitches
  (longest observed run ~11 min, `EXECUTIONS_TIMEOUT` 1200 s).
- `Groq: Draft Pitch` loses its hardcoded project list; it gets a short summary built from the
  master file, so pitch and CV make the same claims.
- Sanitized export keeps `CV_READY=false`; master file path placeholdered.

## 5. Renderer service

`scripts/cv-renderer.py` (stdlib only), launchd agent `com.jobhunt.cv-renderer`,
listens on `127.0.0.1:5682` (5681 is the feedback bridge's mutex).
- POST HTML (+ filename) → headless Chrome `--print-to-pdf` → PDF bytes.
- One-page enforcement: count pages; if > 1, re-render with a compact stylesheet; still > 1 → HTTP error → fallback.
- Saves a copy to `~/.n8n-files/cv/tailored/<date>_<company>.pdf`.
- HTML template `cv/template.html` (repo), shared by tailored CVs and the base CV.
- Base CV: rendered once from the master file (no LLM) and replaces
  `~/.n8n-files/cv/Daniel_Novitzki_CV.pdf` (old PDF backed up first), so the fallback also
  says "Worldwide · remote".

## 6. Testing and rollout

1. Offline node unit tests for the guardrails: changed number, added tech term, length
   out of range, unknown ids, malformed JSON, Groq error item.
2. Renderer alone: base CV renders to exactly 1 page; visual check of the PDF.
3. User review gate: temp workflow tailors CVs for 3 real archived >= 80 jobs and sends them
   only to the user's own Telegram chat; prompt adjusted until the user is happy; temp workflow deleted.
4. Deploy: backup → one atomic update → diff vs backup (only the intended nodes) →
   validate 0 errors → ACTIVE, versionId == activeVersionId.
5. Observe on the next real digest: the log line, the PDF filenames, run time.

## Sequencing

The LinkedIn source (built 09-24, not deployed) also edits the main workflow. One behavioural
change per observed run: deploy and observe LinkedIn and this change on different runs.
Steps 1–3 above don't touch the live workflow and can be built in parallel.

## Out of scope

Cover letters, DOCX output, tailoring for jobs below the pitch threshold, sending anything
to employers (forwarding stays manual).
