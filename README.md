# Job Hunt Agent (n8n)

An autonomous daily job-scouting pipeline built in n8n. Every morning at 09:30 (Asia/Jerusalem) it collects fresh remote job postings from eight sources, scores them against a specific candidate profile with an LLM, and delivers a ranked digest to Telegram.

![Workflow canvas](docs/canvas.png)
*(canvas screenshot placeholder)*

🎥 **90-second demo:** *(video link placeholder)*

## Sources

| Source | Method |
|---|---|
| RemoteOK | Public API |
| Remotive | API, `ai` + `automation` searches, URL-deduplicated |
| We Work Remotely | Programming-jobs RSS feed |
| HN "Who is Hiring" | Algolia API → newest monthly thread → REMOTE comments |
| n8n community job board | Discourse API, 15 newest topics |
| Working Nomads | Public API |
| Jobicy | Public API, geo/type/level folded into the description |
| Arbeitnow | Public API, remote-flagged postings only |

Every source is normalized to a single data contract (`title, company, description, url, source, posted_at`), merged, and deduplicated **across runs** by URL (10,000-entry history) — a posting is delivered at most once, ever.

## Scoring

A cheap word-boundary keyword filter (include/exclude lists) trims the daily haul to the plausible subset — and drops job-*seeker* self-promotion posts that community boards mix in with real offers. Survivors are scored in batches of 5 by Groq (`llama-3.3-70b-versatile`, temperature 0), which returns strict JSON per job: category, region lock, seniority fit, a 0–100 score, stated compensation, a one-line verdict, and red flags. A truncated LLM response is salvaged up to the last complete object, so a bad batch loses at most a few jobs. Jobs scoring ≥ 50 that aren't senior-only reach the digest; the top 15 by score are sent.

**Hard scoring rules in the prompt:** posts by people advertising *themselves* for hire score under 10; roles requiring a working language other than the candidate's score under 40 with a red flag naming the language. Region restrictions are classified and surfaced as red flags (e.g. "US-only hiring") but deliberately don't gate delivery — that judgment stays with the human.

## Resilience

- Every fetch node continues on error — one dead source never kills the run.
- If *every* source returns nothing (in practice: the machine woke without network), the run fails fast instead of delivering a false "nothing new" — the hourly catch-up retries once connectivity is back.
- A malformed LLM response drops only its own batch of 5 (usually less, via truncation salvage), logged, never thrown.
- Telegram sends retry 3× — a delivery blip doesn't cost the day's digest.
- Zero-job days still deliver a "nothing new" message: a silent day means something is broken, a message means the pipeline is healthy.
- A dedicated error workflow pushes a Telegram alert (failing node + error) whenever a run crashes.
- Missed-run catch-up: an hourly guarded trigger re-attempts the digest if the 08:30 run didn't happen (machine was off), at most once per day.
- Long digests split across multiple Telegram messages at job boundaries instead of truncating.

## Prompt-injection awareness

Job postings are untrusted external text passed to an LLM. The scoring prompt explicitly instructs the model to treat posting content as data to evaluate and to ignore any instructions embedded inside it.

## Setup

1. Import `job-hunt-agent.workflow.json` into n8n.
2. Create two credentials, named exactly: **`Telegram Job Bot`** (Telegram API, bot token from @BotFather) and **`Groq API`** (Header Auth: name `Authorization`, value `Bearer <key>`).
3. Replace `YOUR_TELEGRAM_CHAT_ID` in the Telegram node with your numeric chat id.
4. Activate. The workflow file contains no secrets — credentials are referenced by name only.
