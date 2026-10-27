# Job Hunt Agent (n8n)

An autonomous job-scouting **pipeline** built in n8n. Every morning it collects fresh remote job postings from eleven sources, scores them against a specific candidate profile with an LLM, and delivers each qualifying job to Telegram as its own card with **Apply / Save / Skip** buttons. Presses flow back into the system — a status table, a Google Sheet, and (next) the scoring prompt itself — so the bot tracks the search instead of just feeding it. The same chat also takes on-demand searches: type what you're looking for and get a numbered list back.

![Workflow canvas](docs/canvas.png)
*(canvas screenshot placeholder)*

🎥 **90-second demo:** *(video link placeholder)*

## Sources

| Source | Method |
|---|---|
| RemoteOK | Public API |
| Remotive | API, `ai` + `automation` searches, URL-deduplicated |
| We Work Remotely | Programming, full-stack and all-jobs RSS feeds, URL-deduplicated |
| HN "Who is Hiring" | Algolia API → newest monthly thread → REMOTE comments, HTML entities decoded, prose-style posts get a capped title |
| n8n community job board | Discourse API, 15 newest topics |
| Working Nomads | Public API |
| Jobicy | Public API (general + `geo=anywhere`), geo/type/level folded into the description |
| Arbeitnow | Public API, remote-flagged postings only |
| Freelancer.com | Public projects API, one query per search term, budget + skills folded into the description |
| Reddit | Subreddit RSS (no API key), hiring intent decided from the title before any LLM call |
| LinkedIn | Job-alert emails read from Gmail (read-only OAuth), parsed into postings |
| Himalayas | Search API, worldwide + Israel-inclusive roles (on-demand search only) |

Every source is normalized to a single data contract (`title, company, description, url, source, posted_at`), merged, and deduplicated **across runs** against the job archive by URL — a posting is scored at most once, and a run that crashes before scoring loses nothing, because nothing is marked seen until it has been scored.

## Scoring

A word-boundary keyword filter runs before any LLM call. A posting must contain a **strong** term anywhere (`llm`, `rag`, `langchain`, `n8n`, `chatbot`, `mcp`, `ai agent`, `openai`, …) or a **weak** one in the *title* (`ai`, `automation`, `python`, `agent`, …) — weak terms in a 1,500-character body ("we use AI") were the biggest source of wasted scoring calls. Titles that announce seniority (`senior`, `staff`, `principal`, `lead`, …) are dropped here: across 250 archived jobs the LLM had agreed with that title read 100% of the time, so it was pure cost. So are job-*seeker* posts that community boards mix in with real offers — both by phrase ("available for hire") and by the forum convention of a `[For Hire]` title prefix, which alone accounted for 11% of all scoring spend before it was filtered.

Survivors are scored in batches of 5 by Groq (`openai/gpt-oss-120b`, temperature 0), which returns strict JSON per job: category, region lock, seniority fit, a 0–100 score, stated compensation, a one-line verdict, and red flags. The gate is **score ≥ 60, open to applicants worldwide** (US-only, EU-only and "must be based in X" roles are dropped; time-zone-overlap requirements are fine), not senior-only, not category `other`, and no on-site/hybrid flag. The top 15 by score are sent.

Every scored job — not just the delivered ones — is written to an n8n data table with its full LLM verdict, so the funnel can be measured after the fact instead of guessed at. That archive is how each threshold was set: the original ≥ 40 came from a histogram showing the first model never emitted 41–59; the move to ≥ 60 came from re-measuring after the model swap, when 36 of 136 delivered jobs sat in the 40–59 band and none had been worth applying to.

**Hard scoring rules in the prompt:** posts by people advertising *themselves* for hire score under 10; roles requiring a working language other than the candidate's score under 40 with a red flag naming the language; roles restricted to a country or region score under 40 with a red flag naming the restriction.

## The digest and the feedback loop

The digest is a header message (date, count, per-section tally) followed by **one message per job** in three sections — 🎯 Apply now (80+), 👀 Worth a look, 💼 Gigs & side income — each with a linked title, the verdict, posting age in calendar days, compensation, red flags, and an inline keyboard: ✅ Apply · 🔖 Save · ⏭️ Skip. Jobs scoring 80+ additionally get a drafted pitch and the CV sent to the user's *own* chat, ready to forward — the bot never contacts an employer.

Button presses are the interesting part. n8n runs on a laptop with no public URL, so Telegram cannot call it; instead a 150-line Python bridge (`scripts/telegram-feedback-bridge.py`) long-polls Telegram's `getUpdates` and forwards each press to a local n8n webhook. Delivery is at-least-once by construction: the bridge advances Telegram's offset only after n8n has acknowledged the press, so an n8n outage delays a press rather than losing it, and a single-instance lock lets a scheduled task relaunch the bridge every ten minutes as a self-heal. The Feedback workflow then records an append-only status event in a `job_feedback` table **and** appends the same row to a Google Sheet, answers the callback so the button stops spinning, and redraws the card with a status line — keeping the buttons, so a mis-press is corrected by pressing again (latest event wins). The user sees the redraw in about a second; the slow Google Sheets write is deliberately sequenced after it.

A follow-ups workflow runs every evening: any job marked *applied* and untouched for seven days gets a "any reply yet?" nudge (💬 Got a reply · ❌ Rejected · 🔕 Nothing yet); a *saved* job gets "still interested?" (✅ Apply · ⏭️ Skip · 🔖 Remind me later). Each nudge is itself recorded, so the clock restarts and nothing nags daily. A weekly stats workflow (Sunday) reports the scoring funnel, week-over-week deltas, per-source hit rates, the best delivered jobs, near misses (scored 40+ but not sent) so the gate stays falsifiable — and now the pipeline the buttons produce: applied, saved, replies, rejections, and how many applications are still waiting on an answer.

## Search from Telegram

Typing a request into the same chat — "remote customer support no experience" — runs an on-demand search across the same sources plus Himalayas. It is deliberately *not* graded against the CV: it answers whatever was asked. A small model (`openai/gpt-oss-20b`, rate limits separate from the digest's) turns the request into search terms, a level, and request-specific feeds (a WWR category, a Jobicy industry, Freelancer and Himalayas queries). Postings from the last 30 days are matched on those terms, and the newest 40 go to the model in batches of 10 for a verdict on the kind of work, remoteness, experience and **where they hire from**: worldwide, Israel-listed/EMEA, APAC or unstated are kept and labeled (🌍 / 🇮🇱 / 🌏 / ❔, plus 🕐 for required US/EU hours); anything country- or region-restricted is dropped. The model sees the opening of each posting plus the sentences that mention location or hours wherever they sit, since region rules usually live at the end of a post.

Results come back as one numbered list, ten per message. `more` pages through it; `save 3` writes the job into the same archive, status table and sheet as the digest's Save button, so follow-up nudges and the weekly pipeline pick it up with no extra code. The search workflow is generated by `search/build_workflow.py`, which copies the digest's live fetch nodes instead of duplicating them by hand, and every Code node in it is unit-tested offline against stubbed n8n globals. The first live run caught two restricted jobs labeled worldwide: the copied normalizers drop each source's location field, so the model never saw "Seattle, Washington". A join step now restores it by URL.

## Resilience

- Every fetch node continues on error — one dead source never kills the run.
- If *every* source returns nothing (in practice: the machine woke without network), the run fails fast instead of delivering a false "nothing new" — the catch-up retries once connectivity is back.
- LLM requests are spaced to stay under the provider's tokens-per-minute limit. This was measured, not assumed: batches were silently vanishing, and the stored execution data showed every response that *arrived* parsed perfectly while the missing ones were HTTP 429s. Retry settings can't fix that — n8n caps retry backoff below the length of a rate-limit window — so the fix is throughput, not retries.
- A malformed LLM response drops only its own batch of 5, logged, never thrown; an LLM that echoes a mangled URL (the only join key) is repaired or dropped, never archived as a blank row.
- Telegram sends retry 3× — a delivery blip doesn't cost the day's digest.
- Zero-job days still deliver a "nothing new" message: a silent day means something is broken, a message means the pipeline is healthy.
- The archive write is chained *ahead* of the digest rather than run as a parallel branch, so a crash in the delivery path can't lose the day's scored data — and the "delivered" flag updates rows that are guaranteed to exist.
- A dedicated error workflow pushes a Telegram alert (failing node + error) whenever a run crashes, throttled to one per hour so a persistent fault can't flood the chat.
- Missed-run catch-up: a guarded trigger every 15 minutes re-attempts the digest if the morning run didn't happen (machine was off), at most once per day, and only inside a clock window enforced in code — because the cron library replays missed ticks on wake, which once delivered a digest at 00:38.
- Only one production execution runs at a time, and executions are hard-capped at 20 minutes; overlapping or sleeping runs previously saturated n8n's code-execution runner and wedged the instance.
- A 21:30 watchdog reports if no digest went out that day. It exists because the error workflow needs the *same* network whose absence usually caused the failure — so it can't be the only alarm.
- All schedules and date logic use one explicit workflow time zone, so the laptop's own zone (which changes when its owner travels) cannot shift the digest.

## Prompt-injection awareness

Job postings are untrusted external text passed to an LLM. The scoring prompt explicitly instructs the model to treat posting content as data to evaluate and to ignore any instructions embedded inside it.

## Files

| File | What |
|---|---|
| `job-hunt-agent.workflow.json` | Main pipeline (69 nodes) |
| `job-hunt-agent.feedback.workflow.json` | Button-press handler (webhook → table + sheet → redraw card) |
| `job-hunt-agent.error-alert.workflow.json` | Error-trigger workflow with hourly throttle |
| `job-hunt-agent.follow-ups.workflow.json` | Daily 18:00 nudges for applications that went quiet |
| `job-hunt-agent.weekly-stats.workflow.json` | Sunday funnel / hit-rate report, now including the button-derived pipeline |
| `scripts/telegram-feedback-bridge.py` | Telegram → local n8n long-polling bridge (button presses → Feedback, text messages → Search) |
| `search/` | On-demand search: `build_workflow.py` (assembles + deploys the workflow), Code-node sources, prompts, offline tests |
| `scripts/sanitize-exports.py` | Regenerates the exports above from a live instance, whitelist-sanitized and secret-scanned |

The exports contain no secrets: credentials are referenced by name only, and the chat id, sheet id and data-table ids are placeholders.

## Setup

1. Import the five workflow files into n8n.
2. Create the credentials, named exactly: **`Telegram Job Bot`** (Telegram API, bot token from @BotFather), **`Groq API`** (Header Auth: name `Authorization`, value `Bearer <key>`), and **`google sheets(job hunt)`** (Google Service Account; share your sheet with the service-account email).
3. Create two data tables and put their ids in place of `YOUR_JOB_ARCHIVE_TABLE_ID` / `YOUR_JOB_FEEDBACK_TABLE_ID`: `job_archive` (url, title, company, source, score, category, region_lock, seniority_fit, comp, one_liner, red_flags, posted_at, first_seen, delivered) and `job_feedback` (archive_id, url, title, rating, rated_at).
4. Replace `YOUR_TELEGRAM_CHAT_ID` (Telegram nodes and the Feedback workflow's `Parse Callback` code) and `YOUR_GOOGLE_SHEET_ID`; give the sheet a header row `date, status, score, title, company, source, url, archive_id, note`.
5. Optional apply-assist: set `CV_READY = true` in `Apply Prep` and point `Read CV` at a PDF inside n8n's allowed file directory.
6. In the main workflow's settings, select the error workflow; set the workflow time zone to yours.
7. For the buttons: put the bot token in a file the bridge can read, run `scripts/telegram-feedback-bridge.py` under a scheduled task, and activate the Feedback workflow.
8. For search: list your workflow and data-table ids in a git-ignored `sanitize.config.json` (the format is in `scripts/sanitize-exports.py`), run `python3 -I search/build_workflow.py --deploy` (it reads the live main and Feedback workflows), then activate "Job Hunt Agent — Search".
