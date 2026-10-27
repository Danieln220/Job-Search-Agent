# On-demand Telegram Job Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user types any job request into the bot's Telegram chat and gets back one numbered list of matching remote jobs (worldwide / Israel-friendly / APAC) from all current sources plus Himalayas, with `more` and `save N` commands.

**Architecture:** The existing Python bridge also forwards text messages to a new n8n webhook. A new, separate n8n workflow "Job Hunt Agent — Search" does the work: Groq turns the request into search terms, the main workflow's fetch+normalize nodes (copied, not shared) fetch live, a Code prefilter narrows the candidates, Groq checks them, and the result list goes into the workflow's static data. Each Code node's JS lives in `search/nodes/*.js`, is unit-tested offline with `node --test`, and is injected into the workflow by one build script.

**Tech Stack:** n8n 2.35.7 (local, runs on node@22), n8n Code nodes (JS, run-once-for-all-items), Groq chat completions, Telegram Bot API, Python 3 stdlib (bridge + build script), `node --test` + luxon from n8n's node_modules.

**Spec:** `docs/superpowers/specs/2026-10-26-telegram-job-search-design.md`

## Global Constraints

- **Before every task, explain it to the user in plain beginner-friendly words (what and why) and wait for their go** (user's standing rule).
- **Never commit.** The user does all git. End each task by listing the changed files.
- Never put the bot token, Telegram chat id, Groq key, sheet id or n8n instance ids in a repo file. Code uses placeholders (`__CHAT_ID__` etc.) that `search/build_workflow.py` fills from the live workflows into git-ignored `search/dist/`.
- The main workflow `pHVU4dlb9jdbXjFy` (69 nodes, versionId `62d31f52…`) must not change. Before editing any existing workflow: re-fetch it, save a backup to `backups/<name>-<YYYYMMDD-HHMM>.json`, and diff afterwards (only the intended nodes may differ).
- Region rule (spec Goals 3): keep worldwide → `🌍 Worldwide`; Israel listed, EMEA, or "Europe & Middle East" → `🇮🇱 Israel-friendly`; remote APAC/SEA → `🌏 APAC`; nothing stated → `❔ location unclear`; extra label for "worldwide but must work US/EU hours" → `🕐 US hours` / `🕐 EU hours`. Drop: US-only, EU/Europe-only, UK-only, any list without Israel, Thailand-only residency, on-site/hybrid.
- Show only postings ≤ 30 days old. Keep ≤ 50 results per search. 10 lines per message.
- Telegram messages: `parse_mode` HTML, escape `& < >` in every interpolated string, `disable_web_page_preview: true`, credential "Telegram Job Bot".
- Groq credential "Groq API" (Header Auth). Search uses its own model (`openai/gpt-oss-20b`, confirmed in Task 1) so it never spends the daily run's `openai/gpt-oss-120b` budget (8,000 TPM / 200,000 TPD).
- n8n runs one production execution at a time (`N8N_CONCURRENCY_PRODUCTION_LIMIT=1`, `EXECUTIONS_TIMEOUT=1200`). A search must finish in < 5 min (target ~2).
- Himalayas terms: results credit Himalayas and link via `applicationLink`.
- Search workflow: timezone `Asia/Bangkok`, errorWorkflow = alert workflow `Zkz7P1gVJtFFK7rC`.
- A data-table node runs once per input item. Set `executeOnce: true` wherever it must run once.
- **Out of scope here:** JSearch, which gets its own small follow-up once the user has created the free OpenWeb Ninja account (one more fetch head + normalizer, credential in n8n only). Also out of scope: the digest's Thailand-on-site rule (spec "Related follow-up").

## Review Focus

1. **The same Telegram message delivered twice** (bridge resend after a timeout) → exactly one result list. Pinned in Task 3 (`duplicate update_id is ignored`).
2. **`save 12` when the last list has 9 jobs, `more` past the end, `more`/`save` before any search ever ran** → a clear one-line reply, no crash, nothing saved. Pinned in Tasks 8 and 9.
3. **Job titles/companies containing `<`, `&`, or urls with `&`** → escaped, Telegram doesn't 400. Pinned in Task 8 (`escapes html`).
4. **Groq returns non-JSON, a fenced ```json block, missing cids, or a batch fails** → no crash. Interpretation falls back to the user's own words, and unchecked jobs are dropped but counted in the footer. Pinned in Tasks 4 and 7.
5. **A request that is all filler ("remote job no matter what", "find me a job")** → no term filter, so the newest remote listings go to the AI check, instead of zero results. Pinned in Tasks 4 and 6.

---

### Task 1: Verify three platform assumptions (no code)

Three things the later tasks depend on cannot be checked offline. Use temporary workflows (create → run → delete; never activate on the main one).

**Files:** none in the repo. Record results in `CLAUDE.md` under the "On-demand Telegram job search" section.

**Interfaces:**
- Produces: `SEARCH_MODEL` (default `openai/gpt-oss-20b`), `CHECK_BATCH_INTERVAL_MS` (default `20000`), `ACK_OK` (bool: webhook answers while queued), `INSERT_RETURNS_ID` (bool).

- [ ] **Step 1: Groq limits for the search model.** Temp workflow: Webhook → HTTP Request POST `https://api.groq.com/openai/v1/chat/completions` (credential "Groq API", option `response.fullResponse: true`), body `{"model":"openai/gpt-oss-20b","reasoning_effort":"low","messages":[{"role":"user","content":"say ok"}]}`. Read headers `x-ratelimit-limit-tokens` (TPM) and `x-ratelimit-limit-requests` (per day).
Expected: 200. Set `CHECK_BATCH_INTERVAL_MS = ceil(60000 × 3000 / TPM)` rounded up to the next 5000 (3,000 ≈ tokens per 10-job batch). If gpt-oss-20b isn't available, use `llama-3.1-8b-instant` and record that.

- [ ] **Step 2: Webhook acknowledgement while another execution holds the slot.** Temp workflow A: Webhook `probe-busy` → Wait 40 s. Temp workflow B: Webhook `probe-ack`, `responseMode: onReceived`. Activate both, `curl -X POST localhost:5678/webhook/probe-busy &`, then 2 s later `time curl -X POST localhost:5678/webhook/probe-ack`.
Expected: record whether probe-ack returned in < 2 s (`ACK_OK=true`) or only after ~40 s. Task 2 picks the bridge timeout from this.

- [ ] **Step 3: Data-table insert returns the new row id.** Temp workflow: Webhook → dataTable `row.insert` into `job_feedback` (`0lDIZxRU3OvWaWkO`) with `{archive_id: -1, url: "probe", title: "probe", rating: "probe", rated_at: "probe"}`.
Expected: output item contains `id`. Then delete that row (dataTable `row.delete` filter id) and confirm `job_feedback` has no `probe` row left. If no `id` comes back, set `INSERT_RETURNS_ID=false`. Task 9 then adds a `get` by url after the insert.

- [ ] **Step 4: Delete all temp workflows; list the results in CLAUDE.md.**

---

### Task 2: Bridge forwards text messages

**Files:**
- Modify: `scripts/telegram-feedback-bridge.py`
- Create: `scripts/test_bridge_routing.py`

**Interfaces:**
- Produces: `route(update: dict) -> tuple[str, dict, int] | None` returning `(webhook_url, payload, timeout_s)`. `SEARCH_URL = "http://localhost:5678/webhook/job-search"`. Payload for messages = `{"update_id": <int>, "message": <message dict>}`. For callbacks it's the bare `callback_query` dict, unchanged.
- Consumed by Task 3: the webhook body has this shape.

- [ ] **Step 1: Write the failing test** (`python3 -I scripts/test_bridge_routing.py`, stdlib asserts; load the module with `importlib.util.spec_from_file_location` because of the hyphen):
```python
cb = {"update_id": 7, "callback_query": {"id": "x", "data": "fb:save:12"}}
assert b.route(cb) == (b.WEBHOOK_URL, cb["callback_query"], 90)
msg = {"update_id": 8, "message": {"chat": {"id": 5}, "text": "data entry"}}
url, payload, t = b.route(msg)
assert url == b.SEARCH_URL and payload == {"update_id": 8, "message": msg["message"]}
assert b.route({"update_id": 9, "message": {"chat": {"id": 5}, "sticker": {}}}) is None   # no text
assert b.route({"update_id": 10, "edited_message": {"text": "x"}}) is None
print("ok")
```
- [ ] **Step 2: Run it.** Expected: `AttributeError: ... no attribute 'route'`.
- [ ] **Step 3: Implement.** Add `route()`. `forward(url, payload, timeout)` replaces `forward(cq)`. Search timeout = 600 if `ACK_OK` is false (covers a queued daily run), else 90. `getUpdates` `allowed_updates: ["callback_query", "message"]`. Updates where `route()` returns None advance the offset without forwarding. The give-up path calls `answerCallbackQuery` only for callbacks; for messages it only logs. Update the module docstring (it now forwards messages too).
- [ ] **Step 4: Run it.** Expected: `ok`.
- [ ] **Step 5: Do NOT copy it to `~/.n8n/` or restart the bridge yet.** A message forwarded to a missing webhook gets a 404, which the bridge treats as "n8n unavailable" and retries forever, blocking button presses. It goes live in Task 12.

---

### Task 3: Test harness + `Parse Message` node

**Files:**
- Create: `search/test/harness.js`, `search/nodes/parse-message.js`, `search/test/parse-message.test.js`

**Interfaces:**
- Produces (harness): `run(file, { items = [], nodes = {}, staticData = {}, now }) -> object[]`. It reads the file, replaces `__CHAT_ID__` with `'111'`, and wraps the source in `new Function('$input','$','$getWorkflowStaticData','DateTime','console', src)`. `$input.all()/first()` wrap `items` as `{json}`. `$(name).all()/first()` read `nodes[name]`. `$getWorkflowStaticData('global')` returns the same `staticData` object (tests inspect it after the run). `DateTime` is luxon from `/opt/homebrew/lib/node_modules/n8n/node_modules/luxon`, with `Settings.now` pinned when `now` is given. Returns the plain `json` objects.
- Produces (node): input `$input.first().json.body = {update_id, message}`. Output `[]` (ignored) or one item `{kind: 'search'|'more'|'save'|'help', chat_id: string, update_id: number, text: string, query?: string, save_ranks?: number[]}`. `help` items carry the help message in `text`. `search` items have `query` = the trimmed message text. Static data: `processedUpdateIds: number[]` (keep the last 200).

- [ ] **Step 1: Write the failing tests:**
```js
const body = (text, update_id = 1, chat = 111) => [{ body: { update_id, message: { chat: { id: chat }, text } } }];
test('search text', () => { const [o] = run(F, { items: body('remote customer support no experience') });
  assert.equal(o.kind, 'search'); assert.equal(o.query, 'remote customer support no experience'); assert.equal(o.chat_id, '111'); });
test('more', () => assert.equal(run(F, { items: body(' More ') })[0].kind, 'more'));
test('save list', () => assert.deepEqual(run(F, { items: body('save 3, 5 7') })[0].save_ranks, [3, 5, 7]));
test('help and /start', () => { for (const t of ['help', '/start', 'hi']) assert.equal(run(F, { items: body(t) })[0].kind, 'help'); });
test('other chat ignored', () => assert.deepEqual(run(F, { items: body('data entry', 1, 999) }), []));
test('duplicate update_id is ignored', () => { const sd = {};
  assert.equal(run(F, { items: body('data entry', 42), staticData: sd }).length, 1);
  assert.deepEqual(run(F, { items: body('data entry', 42), staticData: sd }), []); });
test('keeps 200 ids', () => { const sd = { processedUpdateIds: [...Array(200).keys()] };
  run(F, { items: body('x y z', 500), staticData: sd }); assert.equal(sd.processedUpdateIds.length, 200); assert.equal(sd.processedUpdateIds.at(-1), 500); });
```
Messages under 3 characters, or with no letters, count as `help`.
- [ ] **Step 2: Run** `node --test search/test/`. Expected: FAIL (file missing).
- [ ] **Step 3: Implement** `search/nodes/parse-message.js` with `const ALLOWED_CHAT_ID = '__CHAT_ID__';`. Write the help text so it explains: type a request; `more`; `save 3`.
- [ ] **Step 4: Run** `node --test search/test/`. Expected: all pass.

---

### Task 4: Interpret prompt + `Build Plan` node

**Files:**
- Create: `search/prompts/interpret.md`, `search/nodes/build-plan.js`, `search/test/build-plan.test.js`

**Interfaces:**
- Consumes: `Parse Message` item (Task 3).
- Produces: one item `{search_id: 's' + update_id, chat_id, query, terms: string[], level: 'entry'|'any', freelancer_queries: string[] (≤3), himalayas_urls: string[] (≤2), wwr_category_url: string, jobicy_industry_url: string, text: string}`. Downstream fetch heads and `Telegram: Ack` read these fields.
- Groq reply contract (`interpret.md` asks for exactly this JSON): `{"terms": [...], "level": "entry"|"any", "wwr_category": <slug>|null, "jobicy_industry": <slug>|null}`.

- [ ] **Step 1: Pin the category enums.** `curl -s https://jobicy.com/api/v2/remote-jobs?get=industries` for Jobicy slugs. For WWR, check each candidate feed `https://weworkremotely.com/categories/<slug>.rss` returns 200 with items: `remote-customer-support-jobs`, `remote-design-jobs`, `remote-sales-and-marketing-jobs`, `remote-management-and-finance-jobs`, `remote-product-jobs`, `remote-devops-sysadmin-jobs`, `remote-full-stack-programming-jobs`, `remote-back-end-programming-jobs`, `remote-front-end-programming-jobs`, `all-other-remote-jobs`. Put the verified lists in `interpret.md` and in `build-plan.js` (`WWR_CATEGORIES`, `JOBICY_INDUSTRIES`), and drop any slug the model returns that isn't in the list.
- [ ] **Step 2: Write `interpret.md`.** The system prompt says: the user wants any remote job, so don't steer toward AI work. `terms` = 3–8 lowercase search phrases: the user's own core words first, then close synonyms (e.g. "customer support" → "customer service", "help desk", "chat support"). Leave out filler (remote, job, find, me, worldwide, no experience). `level` = "entry" when the request implies no or little experience. Any input language; terms in English. Reply JSON only.
- [ ] **Step 3: Write the failing tests:**
```js
const groq = (o) => [{ choices: [{ message: { content: typeof o === 'string' ? o : JSON.stringify(o) } }] }];
const pm = { 'Parse Message': [{ kind: 'search', chat_id: '111', update_id: 9, query: 'remote customer support no experience' }] };
test('uses model terms', () => { const [p] = run(F, { items: groq({ terms: ['customer support', 'help desk'], level: 'entry', wwr_category: 'remote-customer-support-jobs', jobicy_industry: 'supporting' }), nodes: pm });
  assert.equal(p.search_id, 's9'); assert.deepEqual(p.terms, ['customer support', 'help desk']);
  assert.equal(p.wwr_category_url, 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss');
  assert.match(p.jobicy_industry_url, /industry=supporting/);
  assert.match(p.himalayas_urls[0], /q=customer%20support.*country=Israel.*seniority=Entry-level/);
  assert.deepEqual(p.freelancer_queries, ['customer support', 'help desk']); assert.match(p.text, /customer support · help desk/); });
test('fenced json accepted', () => assert.equal(run(F, { items: groq('```json\n{"terms":["data entry"],"level":"any"}\n```'), nodes: pm })[0].terms[0], 'data entry'));
test('non-JSON falls back to own words', () => { const [p] = run(F, { items: groq('sorry'), nodes: pm });
  assert.deepEqual(p.terms, ['customer', 'support']); assert.equal(p.level, 'entry'); });
test('unknown slugs -> generic feeds', () => { const [p] = run(F, { items: groq({ terms: ['x'], level: 'any', wwr_category: 'bogus', jobicy_industry: 'bogus' }), nodes: pm });
  assert.equal(p.wwr_category_url, 'https://weworkremotely.com/remote-jobs.rss'); assert.equal(p.jobicy_industry_url, 'https://jobicy.com/api/v2/remote-jobs?count=50'); });
test('all filler -> empty terms, still searches', () => { const nodes = { 'Parse Message': [{ ...pm['Parse Message'][0], query: 'remote job no matter what' }] };
  const [p] = run(F, { items: groq('nope'), nodes }); assert.deepEqual(p.terms, []);
  assert.match(p.himalayas_urls[0], /country=Israel/); assert.deepEqual(p.freelancer_queries, []); });
```
Fallback stopwords: `remote, job, jobs, find, me, a, an, for, the, any, no, experience, matter, what, worldwide, anywhere, work, from, home, please, i, want, need`. `level: 'entry'` when the query matches `/no experience|entry|junior|beginner|trainee|intern/i`. Himalayas: one url per term for the first 2 terms. With no terms, one url without `q=`. Always include `country=Israel&sort=recent`, plus `seniority=Entry-level` when level is entry.
- [ ] **Step 4: Run** `node --test search/test/`. Expected: new tests FAIL.
- [ ] **Step 5: Implement `build-plan.js`.** The ack `text` has the terms joined with ` · ` (or "the newest remote jobs" when empty), the level line, "remote only", and "Takes about 1–2 minutes.", all HTML-escaped.
- [ ] **Step 6: Run.** Expected: all pass.

---

### Task 5: `Normalize Himalayas` node

**Files:**
- Create: `search/nodes/normalize-himalayas.js`, `search/test/normalize-himalayas.test.js`

**Interfaces:**
- Input: items = Himalayas responses `{jobs: [{title, companyName, applicationLink, guid, excerpt, description, pubDate (unix s), locationRestrictions: string[], seniority: string[]}]}`. Error items (`{error}`) are skipped.
- Produces: the normalized job shape every source emits, `{title, company, url, description, source, posted_at, location}`, plus `region_hint: 'worldwide'|'israel'`. `source: 'himalayas'`, `url` = `applicationLink || guid`, `posted_at` ISO, `location` = restrictions joined or `'Worldwide'`, `description` = tags stripped, ≤1000 chars. Deduped by url.

- [ ] **Step 1: Write the failing tests** with a synthetic 3-job fixture: one with `[]` restrictions → `region_hint: 'worldwide'`; one with `['Israel','Germany']` → `'israel'`; one duplicate url → output length 2; one `{error: 'x'}` item → ignored; `pubDate: 1792297863` → `posted_at === new Date(1792297863000).toISOString()`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** A restriction list without Israel can't occur with `country=Israel`, but if one appears, drop the job.
- [ ] **Step 4: Run.** Expected: all pass.

---

### Task 6: `Prefilter` node

**Files:**
- Create: `search/nodes/prefilter.js`, `search/test/prefilter.test.js`

**Interfaces:**
- Consumes: merged normalized jobs (`$input.all()`) and `$('Build Plan').first().json` (`terms`, `level`).
- Produces: ≥1 batch item `{batch_no, empty: boolean, checked_total: number, candidates: Candidate[], jobs_json: string}`. `Candidate = {cid, title, company, url, source, posted_at, location, region_hint, text}`. `text` = the description's first 600 chars. `jobs_json` = JSON of `[{cid, title, company, location, text}]`. With zero candidates: exactly one item `{batch_no: 0, empty: true, candidates: [], jobs_json: '[]', checked_total}`.
- Constants: `MAX_AGE_DAYS = 30`, `MAX_CANDIDATES = 40`, `BATCH = 10`, `TEXT_CHARS = 600`.

- [ ] **Step 1: Write the failing tests:**
  - `term match`: terms `['customer support']` → keeps "Customer Support Agent", drops "Backend Engineer" whose description lacks the term. Matching is case-insensitive over title + description + company.
  - `entry level drops senior titles`: level entry drops "Senior Support Lead" and "Support Manager", keeps "Support Associate".
  - `30-day window`: posted 31 days before `now` → dropped; unparseable `posted_at` → kept.
  - `dedupe`: same url twice → one; same lowercased title+company from two sources → one.
  - `cap and order`: 55 matching jobs → `candidates` total 40, newest first, split into 4 batches of 10, cids 0–39 unique.
  - `empty terms keep everything` (Review Focus 5): terms `[]` → no term filter, the 40 newest kept.
  - `zero candidates`: one item, `empty: true`, `checked_total` = number of input jobs with title+url.
  - Items lacking title or url, or carrying `error`, are skipped and not counted.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Senior-title regex: `/\b(senior|sr\.?|lead|principal|staff|head of|director|manager|vp)\b/i`.
- [ ] **Step 4: Run.** Expected: all pass.

---

### Task 7: Check prompt + `Apply Check` node

**Files:**
- Create: `search/prompts/check.md`, `search/nodes/apply-check.js`, `search/test/apply-check.test.js`

**Interfaces:**
- Consumes: `$('Prefilter').all()`, `$('Build Plan').first().json`, and `$input.all()`: Groq responses (one per batch, `{choices:[{message:{content}}]}`), the empty marker, or error items.
- Groq reply contract (`check.md`): `{"results":[{"cid":0,"match":true,"remote":true,"region":"worldwide|israel|apac|unclear|restricted","hours":"us|eu|none","entry_ok":true}]}`. The prompt contains the user's request (from the user message), the Global Constraints region table, and "EMEA / Europe & Middle East counts as israel; Thailand-only residency is restricted".
- Produces: writes `$getWorkflowStaticData('global').lastSearch = {search_id, query, chat_id, created_at, checked_total, unverified, page: -1, results: Result[]}`. `Result = {rank, title, company, url, source, region_label, hours_label, posted_at}`. Outputs one item `{chat_id, search_id}`.

- [ ] **Step 1: Write `check.md`.** Groq body for the "AI Check" node: `model` = `SEARCH_MODEL`, `reasoning_effort: "low"`, `temperature: 0`, `response_format: {type: "json_object"}`, system = check.md, user = `"Request: <query>\nLevel: <level>\nJobs: <jobs_json>"`.
- [ ] **Step 2: Write the failing tests:**
  - `region mapping`: verdicts worldwide/israel/apac/unclear → labels `🌍 Worldwide` / `🇮🇱 Israel-friendly` / `🌏 APAC` / `❔ location unclear`; `restricted` → absent; `hours:'us'` → `hours_label: '🕐 US hours'`.
  - `himalayas hint wins`: candidate `region_hint:'israel'`, AI says `restricted` → kept as `🇮🇱 Israel-friendly`.
  - `drops non-matches`: `match:false` or `remote:false` dropped. With `level:'entry'`, `entry_ok:false` is dropped; with `level:'any'` it's kept.
  - `missing verdicts counted` (Review Focus 4): batch 2's response is an error item → its 10 candidates absent, `lastSearch.unverified === 10`.
  - `garbage content`: content `'not json'` and ```` ```json {...} ``` ```` → the first counts as unverified, the second parses.
  - `empty marker`: input `[{empty:true}]` → `lastSearch.results` = `[]`, one output item.
  - `order and cap`: 60 kept → 50 results, newest first, ranks 1..50, unknown dates last.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement.** Pair responses to batches by position in `$input.all()` against the non-empty Prefilter items. Tolerate a bare array instead of `{results}`.
- [ ] **Step 5: Run.** Expected: all pass.

---

### Task 8: `Format Page` node

**Files:**
- Create: `search/nodes/format-page.js`, `search/test/format-page.test.js`

**Interfaces:**
- Consumes: input item `{chat_id, kind?}`, from Apply Check (new search) or Parse Message (`kind: 'more'`). Reads and updates `lastSearch.page`.
- Produces: `{chat_id, text}`.

- [ ] **Step 1: Write the failing tests:**
  - `first page`: 23 results → `text` has lines `1.`–`10.`, header `Found 23 matches for "…"`, footer `Checked <checked_total> listings · showing 1–10 of 23` and `Reply <b>more</b> or <b>save 3</b>`. `lastSearch.page === 0`.
  - `more pages`: next call with `kind:'more'` → lines `11.`–`20.`, page 1. Third call → `21.`–`23.`. Fourth → `That's all 23 results` and page stays at 2.
  - `line format`: `3. <a href="URL">Title</a> — Company · 🌍 Worldwide · 🕐 US hours · 2d · himalayas`. Himalayas lines show `via Himalayas`. Age: `today` / `Nd` (calendar days in Asia/Bangkok, `now` pinned).
  - `escapes html` (Review Focus 3): title `A<b> & co` and url `https://x/?a=1&b=2` → `A&lt;b&gt; &amp; co`, `href="https://x/?a=1&amp;b=2"`.
  - `unverified note`: `unverified: 10` → footer contains `(10 couldn't be checked)`.
  - `no results`: `results: []` → `No matches for "…" in <checked_total> listings` plus a hint to try broader words.
  - `no search yet` (Review Focus 2): no `lastSearch`, `kind:'more'` → `No search yet - type what kind of job you want.`
  - `length`: 10 results with 300-char titles and companies → `text.length < 4096` (titles cut to 80 chars, companies to 40).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: all pass.

---

### Task 9: Save path: `Prep Save`, `Feedback Event`, `Save Reply`

**Files:**
- Create: `search/nodes/prep-save.js`, `search/nodes/feedback-event.js`, `search/nodes/save-reply.js`, `search/test/save.test.js`

**Interfaces:**
- `prep-save.js`: input Parse Message `{save_ranks, chat_id}`. Reads `lastSearch`. Outputs one archive row per valid rank: `{url, title, company, source: 'search:' + source, posted_at, first_seen: <now ISO, Asia/Bangkok>, delivered: true, _rank, _query, _chat_id, _invalid: number[]}`. If no rank is valid, it outputs one item `{reply_only: true, chat_id, text}` instead.
- `feedback-event.js`: input = the `Insert Archive` output rows (each has `id`, or see Task 1 `INSERT_RETURNS_ID`), paired by index with `$('Prep Save').all()`. Outputs events in the Sheet header order `{date: new Date().toISOString(), status: 'saved', score: '', title, company, source, url, archive_id: id, note: 'search: <query> #<rank>'}`.
- `save-reply.js`: reads `$('Feedback Event').all()` and `$('Prep Save').first().json`. Outputs `{chat_id, text}` like `⭐ Saved 2: #3 Title, #5 Title`, plus `No #12 in your last search (9 results).` when some ranks were invalid.

- [ ] **Step 1: Write the failing tests:**
  - `valid ranks`: 9 results, `save_ranks [3, 5]` → 2 rows, `source` like `search:himalayas`, `delivered === true`, `_rank` 3 and 5.
  - `invalid only` (Review Focus 2): `[12]` → `[{reply_only: true, text: /No #12 in your last search \(9 results\)/}]`.
  - `mixed`: `[3, 12]` → 1 row with `_invalid: [12]`. The save reply mentions both.
  - `no search yet`: no `lastSearch` → `reply_only` with `No search yet`.
  - `duplicate ranks`: `[3, 3]` → one row.
  - `feedback event shape`: keys in exactly this order: `date,status,score,title,company,source,url,archive_id,note`. `archive_id` comes from the insert output's `id`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement the three nodes.**
- [ ] **Step 4: Run** `node --test search/test/`. Expected: everything passes.

---

### Task 10: Build script: assemble, validate, deploy inactive

**Files:**
- Create: `search/build_workflow.py`, `search/test_build_workflow.py`
- Modify: `.gitignore` (add `search/dist/`)

**Interfaces:**
- Consumes: every `search/nodes/*.js` and `search/prompts/*.md`, plus the live main and Feedback workflows (fetched with curl, API key from `.mcp.json`, same pattern as `scripts/sanitize-exports.py`'s `fetch()`).
- Produces: `search/dist/search.workflow.json`. `--deploy` creates the workflow (or PUTs it when `sanitize.config.json` already has a `search` workflow id) and stores the new id under `workflows` in `sanitize.config.json`. It never activates.

Graph (node names are the interface for `$('…')` references):
```
Search Webhook (POST job-search, responseMode onReceived) → Parse Message → Route (Switch on kind)
  search → Interpret Query (Groq) → Build Plan → [Telegram: Ack FIRST, then every fetch head]
  copied sources … → Merge ─┐
  Himalayas Search Terms → Fetch Himalayas → Normalize Himalayas ─┴→ Merge Search Sources → Prefilter
  Prefilter → Has Candidates (IF empty is false) → true: AI Check (Groq) → Apply Check ; false: Apply Check
  Apply Check → Format Page → Telegram: Send
  more → Format Page
  save → Prep Save → Has Jobs (IF reply_only is not true) → true: Insert Archive → Feedback Event → Record Feedback → Sheet Row → Append to Sheet → Save Reply → Telegram: Send
                                                          false → Telegram: Send
  help → Telegram: Send
```
- Copy from the live main workflow every node reachable from `Schedule Guard`'s outputs up to and including `Merge`, with their connections. **Exclude** `Reddit Subs`, `Fetch Reddit`, `Normalize Reddit` and `Merge Social`: Reddit's 60 s batch spacing would add a minute to every search for about one job a month. Rewire `Normalize LinkedIn → Merge` input 9.
- Patches on the copies: `Freelancer Queries` jsCode → `return $('Build Plan').first().json.freelancer_queries.map(q => ({ json: { q, qe: encodeURIComponent(q) } }));`. `Normalize Freelancer`: `MAX_AGE_DAYS = 3` → `MAX_AGE_DAYS = 30`. Every copied `Normalize *` node: `slice(0, 1500)` → `slice(0, 4000)`, so the location rules at the end of long posts survive (user decision 2026-10-26). Prefilter only sends the AI the opening plus location/hours sentences. `Fetch LinkedIn Alerts` q: `newer_than:3d` → `newer_than:30d`. `Merge WWR` numberInputs +1 with new `Fetch WWR Category` (rssFeedRead, url `={{ $('Build Plan').first().json.wwr_category_url }}`). `Merge Jobicy` numberInputs +1 with new `Fetch Jobicy Industry` (HTTP, url from `jobicy_industry_url`). Both new nodes: onError continue, retry 2×5 s, like the copies.
- `Himalayas Search Terms` jsCode → `return $('Build Plan').first().json.himalayas_urls.map(url => ({ json: { url } }));`. `Fetch Himalayas`: HTTP, url `={{ $json.url }}`, timeout 30000, onError continue, retry 2×5 s.
- `Interpret Query` and `AI Check`: HTTP POST to Groq, credential "Groq API", timeout 45000, retry 2×5 s, onError continue. AI Check also gets `options.batching.batch = {batchSize: 1, batchInterval: CHECK_BATCH_INTERVAL_MS}`.
- `Insert Archive`: dataTable `row.insert` into job_archive (id read from `sanitize.config.json` `tables`), mapping url, title, company, source, posted_at, first_seen, delivered. `Record Feedback` and `Append to Sheet`: copy the parameters and credentials from the live Feedback workflow nodes of the same names. `Append to Sheet` is onError continue with 3 retries. `Sheet Row` = `return $('Feedback Event').all();`.
- Telegram nodes: chatId `={{ $json.chat_id }}`, text `={{ $json.text }}`, parse_mode HTML, disable preview, retry 2×5 s.
- Substitute `__CHAT_ID__` with the chatId of the live main workflow's `Telegram` node. Settings: `timezone: Asia/Bangkok`, `errorWorkflow: Zkz7P1gVJtFFK7rC`, `executionOrder: v1`.

- [ ] **Step 1: Write the failing test** `search/test_build_workflow.py`. It calls `build(main_wf, feedback_wf, cfg) -> dict` on fresh backups of the live main workflow (69 nodes, LinkedIn included; save it to `backups/job-hunt-agent-<YYYYMMDD-HHMM>.json` first) and of the Feedback workflow, plus a fake cfg, and asserts:
  - every node in the graph above exists, and no node named `*Reddit*` or `Merge Social` exists;
  - `Normalize LinkedIn → Merge[9]`, and `Build Plan`'s first connection is `Telegram: Ack`;
  - every `$('X')` referenced in any Code node or expression names a node that exists;
  - the patched strings are present (`MAX_AGE_DAYS = 30`, `newer_than:30d`), and no copied `Normalize *` still has `slice(0, 1500)`;
  - no `__CHAT_ID__` remains in the output, and no repo file under `search/` contains the real chat id.
- [ ] **Step 2: Run** `python3 -I search/test_build_workflow.py`. Expected: FAIL (no `build`).
- [ ] **Step 3: Implement** `build()`, a `main()` writing `search/dist/search.workflow.json`, and `--deploy`.
- [ ] **Step 4: Run the test.** Expected: `ok`.
- [ ] **Step 5: Deploy inactive and validate:** `python3 -I search/build_workflow.py --deploy`, then `n8n_validate_workflow` on the new id.
Expected: 0 errors (known-benign: Groq jsonBody expression warnings). Re-fetch the main workflow and confirm its versionId is still `62d31f52-c868-47cb-a615-a708cf9873c5`.

---

### Task 11: Make Weekly Stats and the Feedback card cope with search rows

**Files:** live workflows `obspSGXFJsKl2fTf` (Weekly Stats) and `LwXVQqqOpQtA6Ued` (Feedback). Back up both first. Test: `search/test/compat.test.js`, which runs the patched code taken from the fresh backup.

- [ ] **Step 1: Write the failing tests:**
  - Weekly Stats `Build Stats` with one normal row plus one `source: 'search:himalayas', score: null` row this week → output contains `scored: 1`, and no `search:` source line.
  - Feedback `Render Message` with a job `{score: null, category: null, source: 'search:himalayas'}` → no line starting with `⭐`. With `score: 85` the `⭐ 85 · …` line is still there.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Patch with `n8n_update_partial_workflow` `patchNodeField` (find/replace).** Build Stats: `const rows = $('Read Archive').all().map(i => i.json).filter(r => r && r.url);` gains `&& !String(r.source || '').startsWith('search:')`. Render Message: wrap the `lines.push('⭐ ' …)` in `if (j.score !== null && j.score !== undefined && j.score !== '')`.
- [ ] **Step 4: Run the tests on the re-fetched live code.** Expected: pass. Diff each workflow against its backup: exactly one node changed in each.

---

### Task 12: Go live + end-to-end check with the user

**Files:**
- Modify: `~/.n8n/telegram-feedback-bridge.py` (copy from the repo), `CLAUDE.md`, `README.md` (sources + a short "Search from Telegram" section), `sanitize.config.json` (search workflow + `job_feedback`/`job_archive` already listed)

- [ ] **Step 1: Activate the search workflow** and confirm `curl -s -o /dev/null -w "%{http_code}" -X POST localhost:5678/webhook/job-search -d '{}' -H 'Content-Type: application/json'` returns 200. The workflow ignores the empty body because Parse Message returns `[]`.
- [ ] **Step 2: Install the bridge:** copy the repo file over the live copy, `launchctl kickstart -k gui/$UID/com.jobhunt.feedback-bridge`, and check `feedback-bridge.log` shows `bridge started` with the old offset preserved.
- [ ] **Step 3: Ask the user to press any button on an old digest card.** Expected: it's recorded as before (Feedback execution success). This proves callbacks still work.
- [ ] **Step 4: Ask the user to type `remote customer support no experience`.** Expected within ~2 min: the ack, then the list. Check the execution: success, run time recorded, Prefilter `checked_total`, AI Check batches all answered, every listed job ≤30 days old, and no restricted region in the list. Open 3 links to confirm each is remote and hires worldwide or from Israel.
- [ ] **Step 5: Ask the user to send `more`, then `save 2`, then `save 99`.** Expected: page 2; `⭐ Saved 1: #2 …` plus a new job_archive row (source `search:…`), a job_feedback row and a Sheet row; then `No #99 …`.
- [ ] **Step 6: Ask the user to try one more request of their own.** Record the run time, the number of results, and anything that looked wrong.
- [ ] **Step 7: Update CLAUDE.md** (what shipped, ids, verification numbers, Task 1 results), README, and `sanitize.config.json`. Tell the user which repo files changed. They commit.
