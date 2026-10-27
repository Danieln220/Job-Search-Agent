# On-demand job search in Telegram — design

Date: 2026-10-26 · Status: reviewed (builder check done), awaiting the user's approval

## Why

The daily digest is tuned to one profile (AI / automation / LLM work). The user now needs **any
remote job, fast**, and wants to type a request into the same Telegram chat, like "find me jobs
remote no experience" or "customer support part time". The bot should then search the sites it
already watches, plus a few better search sources, and send back **what matches the words he
typed**. It should not grade jobs against his CV or profile.

Success = he types a request and within ~2 minutes gets a short, relevant list of jobs he can actually take,
can page through it, and can save the ones he likes into the same pipeline (Sheet, follow-ups)
the digest's Save button feeds.

## Goals

1. Free-text search from Telegram, in plain words, any job type.
2. Search all current sources, plus Himalayas from day one and JSearch once the user has a key.
3. Only jobs he can be hired for. He is NOT a Thai resident, but he lives in Thailand (UTC+7).
   Region rule (user-approved 2026-10-26):

   | posting says | result | label |
   |---|---|---|
   | worldwide / work from anywhere | keep | 🌍 Worldwide |
   | hiring list includes Israel | keep | 🇮🇱 Israel-friendly |
   | EMEA, "Europe & Middle East" | keep (Israel is in it) | 🇮🇱 Israel-friendly |
   | remote APAC / Southeast Asia | keep (he is located there, often hired as a contractor) | 🌏 APAC |
   | worldwide but must work US / EU hours | keep | 🕐 US hours / 🕐 EU hours (in addition to the region label) |
   | nothing stated | keep | ❔ location unclear |
   | US-only, EU/Europe-only, UK-only, any other country/region list without Israel, Thailand-only residency, on-site/hybrid | **drop** | — |
4. Results as **one compact numbered list** (the user picked style B over per-job cards).
5. Commands on the last result list: `more` (next page), `save N` (records job N as saved).

## Non-goals (first version)

- Searches that re-run automatically (daily alerts for a saved query). User confirmed: later.
- Tailored CV per result. That is the next project (the existing 2026-10-01 tailored-CV design is
  built around the AI profile and needs rethinking for other job types).
- Scoring against the CV / profile. The AI checks only "does this match what he asked + is it
  remote + can he be hired from anywhere/Israel".
- On-site or hybrid jobs.

## Anti-goals (would make it a failure even if it "works")

- Changing the daily digest's behaviour in any way, including its dedup history, scoring or schedule.
- Contacting employers or applying for anything. The bot only lists and saves.
- Using Upwork in any form. Its API & MCP terms forbid continuous monitoring and agent
  scoring; see CLAUDE.md 2026-10-26. No LinkedIn scraping either.
- Spamming the chat: no per-job messages, 10 lines per message.
- A duplicated search (the same message processed twice) producing two result lists.

## How a search behaves (decided with the user)

1. User sends any text message to the bot that isn't a command.
2. Within seconds the bot replies with what it understood: search terms including similar words
   (e.g. "customer support · customer service · help desk · chat support"), level ("entry / no
   experience"), "remote only", and an expected wait (~1–2 min). If another run (the daily
   digest) is in progress, this reply simply arrives later, when the search actually starts
   (see "my call" below).
3. Search:
   - **Search sources** get the query sent to them: Himalayas (`/jobs/api/search?q=…&country=Israel`,
     plus `seniority=Entry-level` when the request implies no experience), Freelancer.com (its API
     already takes `query=`), and JSearch once keyed.
   - **Feed sources** are fetched fresh and matched locally against the terms. These are RemoteOK,
     Remotive, WWR, HN, n8n board, Working Nomads, Jobicy, Arbeitnow, Reddit and LinkedIn alert
     mails. Where a feed has a category or industry that fits the request, use it as well:
     WWR category feeds (e.g. `remote-customer-support-jobs.rss`) and Jobicy `industry=` (e.g. `supporting`).
4. An AI pass checks the candidates: does it match the request, is it remote, does the
   region rule hold, and does "no experience" (if asked) hold up. Duplicates across sites are merged by url
   / title+company.
5. Only postings from the **last 30 days** are shown.
6. Reply = one message, newest first, **10 lines per message**. Each line: number, linked title, company,
   region label (see the table in Goals, incl. 🕐 hours label), post age, and source.
   Himalayas results credit Himalayas and link via its `applicationLink` (their terms).
   Footer: how many listings were checked, plus "reply `more` or `save 3`".
7. Nothing found → say so and suggest broader wording.

## Probe results the design relies on (2026-10-26, query "customer support")

| source | result |
|---|---|
| Himalayas `country=Israel` | 109 total; page 1 = 16 worldwide + 4 Israel-inclusive. `+seniority=Entry-level` → 30. Free, no key (shared allowance; a free key gives 60/min, 10k/day). Terms: personal use OK, must credit Himalayas + link back, use `applicationLink`, don't redistribute to other boards. 20 per page. |
| WWR `remote-customer-support-jobs.rss` | 69 items, 26 support titles |
| Jobicy `industry=supporting` | 50 items, 24 support titles |
| RemoteOK `?tag=` | the tag looks mostly ignored (14 support titles of 99) |
| Remotive, The Muse, Arbeitnow search, Careerjet, Adzuna | weak / blocked / no Thailand-Israel coverage. Not used |
| JSearch (OpenWeb Ninja) | not tested, needs a key. Docs claim Google-for-Jobs coverage (LinkedIn, Indeed, Glassdoor, ZipRecruiter) and remote / no-experience filters; free plan ~100–200 requests/month |

## Constraints (existing system, must hold)

- **Telegram reaches n8n only through the bridge** (`scripts/telegram-feedback-bridge.py`, live
  copy `~/.n8n/telegram-feedback-bridge.py`, identical today). It long-polls `getUpdates` with
  `allowed_updates: ["callback_query"]` and POSTs each update to
  `http://localhost:5678/webhook/job-feedback`, advancing the offset only after a 2xx
  (at-least-once). Only one `getUpdates` consumer can exist per bot, so text messages must come
  through this same bridge (add `message`, route to a new webhook). Only accept messages from the
  user's own chat id. The chat id stays inside n8n / the token file, never in the repo.
- **At-least-once delivery means duplicates are possible.** The search must be idempotent per
  Telegram `update_id` (e.g. remember processed ids), and the bridge must not wait for the
  whole search before getting its 2xx, or it will time out (90 s today) and resend.
- **n8n runs one production execution at a time** (`N8N_CONCURRENCY_PRODUCTION_LIMIT=1`,
  `EXECUTIONS_TIMEOUT=1200`). A search queues behind a running daily digest (~6 min) and vice
  versa. Keep a search well under 20 min. Target ~2 min.
- **Groq limits are shared with the daily run**: `openai/gpt-oss-120b` = 8,000 TPM, 200,000 TPD.
  It's a reasoning model (~3× completion tokens). The daily run uses ~47k/day. A search must
  stay small: send title + a short description slice per candidate, and cap how many candidates
  get the AI check. A smaller Groq model is acceptable for the check if its limits are better.
  Groq credential = "Groq API" (Header Auth).
- **Laptop-local**: if the Mac is asleep, the bridge isn't polling. Telegram keeps updates for
  24 h, so the search runs when the Mac wakes. No action needed; just don't treat late
  delivery as an error.
- **Separate workflow.** A bug in search must never take down the daily digest (same rule as
  Weekly Stats / Follow-ups). Set errorWorkflow = the alert workflow. Re-fetch + back up any
  existing workflow before editing it (standing rule).
- Telegram node: `parse_mode` HTML with `& < >` escaped (legacy Markdown 400s on underscores).
- Code-node `console.log` doesn't reach n8n's log under the task runner. Put counters in
  output items if they need to be inspectable.
- A data-table node runs once per input item → `executeOnce: true` when it should run once.

## Decisions that are my call (flag if wrong)

- **Search results are kept apart from `job_archive`.** The archive is the daily digest's "already
  seen" list. Writing every search hit into it would hide jobs from future digests and pollute
  Weekly Stats. Only the LAST search's results are kept, in the search workflow's static data
  (`lastSearch`), so `more` / `save N` can refer back to the list. No new data table: `more` and
  `save N` only ever refer to the latest list. (Changed from "new data table" while planning.)
- **`save N` INSERTS that one job as a new `job_archive` row** (source e.g. `search:himalayas`,
  delivered=true, no score) to give it an `archive_id`. Always an insert, never an upsert:
  upserting by url would overwrite a digest-scored row's source/first_seen. A url can therefore
  appear twice in the archive (digest row + search row). That's harmless. then records a `saved` event in
  `job_feedback` + the Google Sheet like the Save button does. Reason: Follow-ups and Weekly
  Stats group by `archive_id`, so a saved search job then gets nudges and shows in the funnel with no
  changes. Side effect (intended): a job he saved won't reappear in a digest. The builder
  must check Weekly Stats' score-spread code copes with score-less rows.
- **No instant "waiting" notice.** `N8N_CONCURRENCY_PRODUCTION_LIMIT=1` also queues webhook
  runs, so a search started during the daily run can't reply until that run ends (a few minutes,
  rare). Accept the late first reply. The bridge stays a plain pass-through with no n8n API
  key. Raising the limit to 2 is ruled out: it brings back the 07-28 task-runner pile-up and
  the 09-16 duplicate-digest race.
- The query can be in any language. The AI interprets it.
- Results kept per search are capped at 50.

## Left to the builder

- Exact node layout, and whether the feed fetch/normalize code is copied from the main workflow
  or shared via a sub-workflow. Copying is acceptable; the main workflow must not change.
- How the webhook acknowledges fast while the search continues (e.g. respond immediately, then
  run). Verify the behaviour when the execution is queued behind the daily run.
- The prompt(s), candidate cap, batch sizes, and the model for the check, within the Groq limits above.
- Command parsing details (`more`, `save 3`, maybe `save 3 5`, `help`).
- JSearch wiring once the user creates the account (credential in n8n only).
- Tests: offline unit tests for the region rule, command parsing and list formatting, plus one
  real end-to-end search from Telegram before calling it done.

## Related, separate follow-up (not part of this build)

The daily digest currently lets **on-site Thailand jobs** through as "local" (and SEA ≥75) on
the assumption the user could work there. He is not a Thai resident, so that rule likely needs
reversing. Raise it after this ships.
