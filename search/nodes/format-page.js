// Renders one page (10 lines) of the last search as a Telegram HTML message.
// A new search shows page 0; kind 'more' shows the next page.
const PAGE = 10;
const TZ = 'Asia/Bangkok';
// Some sources send text already HTML-encoded ("Aisles &amp; Abroad"): decode first, escape once.
const esc = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|#0?39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[e] || "'")
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const input = $input.first().json;
const ls = $getWorkflowStaticData('global').lastSearch;
const reply = (text) => [{ json: { chat_id: input.chat_id, text } }];
if (!ls) return reply('No search yet - type what kind of job you want.');

const q = esc(String(ls.query).slice(0, 60));
const total = ls.results.length;
if (!total) {
  // An empty list can be an outage, not a bad query: don't tell the user to change their words then.
  if (ls.unverified) return reply(`Couldn't check ${ls.unverified} listings for "${q}" (AI error) - try again in a minute.`);
  if (!ls.checked_total) return reply(`Couldn't reach the job sources for "${q}" - try again later.`);
  return reply(`No matches for "${q}" in ${ls.checked_total} listings.\nTry broader words, e.g. just the kind of work without the level.`);
}
const page = input.kind === 'more' ? ls.page + 1 : 0;
if (page * PAGE >= total) return reply(`That's all ${total} results for "${q}". Type a new search any time.`);
ls.page = page;

const today = DateTime.now().setZone(TZ).startOf('day');
const age = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = Math.round(today.diff(DateTime.fromMillis(t).setZone(TZ).startOf('day'), 'days').days);
  return d <= 0 ? 'today' : d + 'd';
};

const from = page * PAGE;
const shown = ls.results.slice(from, from + PAGE);
const lines = shown.map((r) => {
  const link = `${r.rank}. <a href="${esc(r.url)}">${esc(String(r.title).slice(0, 80))}</a>` +
    (r.company ? ' — ' + esc(String(r.company).slice(0, 40)) : '');
  const tags = [r.region_label, r.hours_label, age(r.posted_at), r.source === 'himalayas' ? 'via Himalayas' : esc(r.source)];
  return [link, ...tags.filter(Boolean)].join(' · ');
});
const to = from + shown.length;
const footer = `Checked ${ls.checked_total} listings · showing ${from + 1}–${to} of ${total}` +
  (ls.unverified ? ` (${ls.unverified} couldn't be checked)` : '');
const hint = to < total ? 'Reply <b>more</b> or <b>save 3</b>' : 'Reply <b>save 3</b> to save a job';

return reply([`🔎 Found ${total} matches for "${q}"`, '', ...lines, '', footer, hint].join('\n'));
