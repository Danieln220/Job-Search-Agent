// Cheap, no-AI narrowing of everything fetched: term match, level, 30-day window, dedupe,
// then up to 40 (newest first, shared across sources) in batches of 10 for the AI check. Always emits at least one item.
const MAX_AGE_DAYS = 30;
const MAX_CANDIDATES = 40;
const BATCH = 10;
const TEXT_CHARS = 600;
const SENIOR_RX = /\b(senior|sr\.?|lead|principal|staff|head of|director|manager|vp)\b/i;
// Region/hours rules often sit at the END of a long post; sentences matching this go to the AI
// along with the opening TEXT_CHARS, capped at EXTRA_CHARS.
const EXTRA_CHARS = 400;
const WHERE_RX = /\b(based in|located|location|residen\w*|reside|eligib\w*|authori[sz]\w* to work|work authori[sz]ation|visa|time ?zones?|hours|EST|EDT|PST|PDT|CET|CEST|GMT|UTC|BST|AEST|US[- ]only|U\.S\.|USA|united states|canada|europe\w*|EU|EMEA|APAC|LATAM|UK|worldwide|anywhere|globally|countr(y|ies)|israel|asia)\b/i;
const brief = (desc) => {
  const d = String(desc || '');
  const head = d.slice(0, TEXT_CHARS);
  const extra = d.slice(TEXT_CHARS).split(/(?<=[.!?])\s+|\n+/)
    .map((s) => { const m = s.match(WHERE_RX); return m ? s.slice(Math.max(0, m.index - 80)).slice(0, 200).trim() : ''; })
    .filter(Boolean).join(' ').slice(0, EXTRA_CHARS);
  return extra ? head + ' … ' + extra : head;
};

const { terms, level } = $('Build Plan').first().json;
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRx = terms.map((t) => new RegExp('(^|[^\\p{L}\\p{N}])' + escRx(t) + '($|[^\\p{L}\\p{N}])', 'iu'));
const now = DateTime.now().toMillis();
const time = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? null : t; };

const jobs = $input.all().map((i) => i.json).filter((j) => j && !j.error && j.title && j.url);
const seen = new Set();
const kept = [];
for (const j of jobs) {
  const hay = [j.title, j.description, j.company].join(' ');
  if (termRx.length && !termRx.some((rx) => rx.test(hay))) continue;
  if (level === 'entry' && SENIOR_RX.test(j.title)) continue;
  const t = time(j.posted_at);
  if (t !== null && now - t > MAX_AGE_DAYS * 86400000) continue;
  const keys = [String(j.url).trim().toLowerCase().replace(/\/+$/, '')];
  if (j.company) keys.push((j.title + '|' + j.company).trim().toLowerCase());
  if (keys.some((k) => seen.has(k))) continue;
  keys.forEach((k) => seen.add(k));
  kept.push({ ...j, _t: t });
}

const newest = (a, b) => (b._t ?? -Infinity) - (a._t ?? -Infinity);
kept.sort(newest);
// Fill the cap in turns across sources (newest first within each): Freelancer gigs are often minutes
// old, and a plain "40 newest" would let them push every WWR / Himalayas / Jobicy job out.
const bySource = new Map();
for (const j of kept) bySource.set(j.source, [...(bySource.get(j.source) || []), j]);
const picked = [];
for (let i = 0; picked.length < Math.min(MAX_CANDIDATES, kept.length); i++) {
  for (const list of bySource.values()) if (i < list.length && picked.length < MAX_CANDIDATES) picked.push(list[i]);
}
const candidates = picked.sort(newest).map((j, cid) => ({
  cid, title: j.title, company: j.company || '', url: j.url, source: j.source, posted_at: j.posted_at || '',
  location: j.location || '', region_hint: j.region_hint || '', text: brief(j.description),
}));

if (!candidates.length) {
  return [{ json: { batch_no: 0, empty: true, checked_total: jobs.length, candidates: [], jobs_json: '[]' } }];
}
const out = [];
for (let i = 0; i < candidates.length; i += BATCH) {
  const batch = candidates.slice(i, i + BATCH);
  out.push({ json: {
    batch_no: out.length + 1, empty: false, checked_total: jobs.length, candidates: batch,
    jobs_json: JSON.stringify(batch.map(({ cid, title, company, location, text }) => ({ cid, title, company, location, text }))),
  } });
}
return out;
