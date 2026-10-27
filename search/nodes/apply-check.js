// Joins the AI verdicts to the Prefilter candidates, applies the region rule, and stores the
// result list in static data for Format Page / more / save. A candidate without a usable
// verdict (failed or garbled batch) is dropped and counted, never shown unchecked.
const MAX_RESULTS = 50;
const REGION = { worldwide: '🌍 Worldwide', israel: '🇮🇱 Israel-friendly', apac: '🌏 APAC', unclear: '❔ location unclear' };
const HOURS = { us: '🕐 US hours', eu: '🕐 EU hours' };

const plan = $('Build Plan').first().json;
const pre = $('Prefilter').all().map((i) => i.json);
const batches = pre.filter((b) => !b.empty);
const responses = $input.all().map((i) => i.json);

const verdicts = (r) => {
  try {
    const content = String(r.choices[0].message.content).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
    const parsed = JSON.parse(content);
    const list = Array.isArray(parsed) ? parsed : parsed.results;
    return new Map((Array.isArray(list) ? list : []).map((v) => [Number(v.cid), v]));
  } catch (e) {
    return new Map();
  }
};

let unverified = 0;
const kept = [];
batches.forEach((b, i) => {
  const vs = verdicts(responses[i] || {});
  for (const c of b.candidates) {
    const v = vs.get(c.cid);
    if (!v) { unverified++; continue; }
    const region = c.region_hint || v.region;
    if (v.match !== true || v.remote === false || !REGION[region]) continue;
    if (plan.level === 'entry' && v.entry_ok === false) continue;
    kept.push({ c, region, hours: v.hours });
  }
});

const time = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? -Infinity : t; };
kept.sort((a, b) => time(b.c.posted_at) - time(a.c.posted_at));
const results = kept.slice(0, MAX_RESULTS).map(({ c, region, hours }, i) => ({
  rank: i + 1, title: c.title, company: c.company, url: c.url, source: c.source,
  region_label: REGION[region], hours_label: HOURS[hours] || '', posted_at: c.posted_at,
}));

$getWorkflowStaticData('global').lastSearch = {
  search_id: plan.search_id, query: plan.query, chat_id: plan.chat_id,
  created_at: DateTime.now().toISO(), checked_total: (pre[0] || {}).checked_total || 0,
  unverified, page: -1, results,
};
return [{ json: { chat_id: plan.chat_id, search_id: plan.search_id } }];
