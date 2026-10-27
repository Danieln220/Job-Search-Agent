// Turns `save 3 5` into new job_archive rows taken from the last search, one per valid rank.
// No valid rank (or no search yet) -> one reply_only item, which the IF after this routes
// straight to the Telegram reply, so nothing is written.
const input = $input.first().json;
const ls = $getWorkflowStaticData('global').lastSearch;
const reply = (text) => [{ json: { reply_only: true, chat_id: input.chat_id, text } }];
if (!ls) return reply('No search yet - type what kind of job you want.');

const byRank = new Map(ls.results.map((r) => [r.rank, r]));
const ranks = [...new Set(input.save_ranks)];
const invalid = ranks.filter((n) => !byRank.has(n));
const missing = invalid.length ? `No #${invalid.join(', #')} in your last search (${ls.results.length} results).` : '';
const valid = ranks.filter((n) => byRank.has(n));
if (!valid.length) return reply(missing);

const now = DateTime.now().setZone('Asia/Bangkok').toISO();
return valid.map((n) => {
  const r = byRank.get(n);
  return { json: {
    url: r.url, title: r.title, company: r.company, source: 'search:' + r.source,
    posted_at: r.posted_at, first_seen: now, delivered: true,
    _rank: n, _query: ls.query, _chat_id: input.chat_id, _invalid: invalid, _missing: missing,
  } };
});
