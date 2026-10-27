const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./harness');

const F = 'apply-check.js';
const NOW = '2026-10-26T12:00:00Z';
const daysAgo = (d) => new Date(Date.parse(NOW) - d * 86400000).toISOString();
const cand = (cid, o = {}) => ({ cid, title: 'Job ' + cid, company: 'Co', url: 'https://x/' + cid, source: 'remoteok',
  posted_at: daysAgo(cid), location: '', region_hint: '', text: 't', ...o });
const batchesOf = (cands) => {
  const out = [];
  for (let i = 0; i < cands.length; i += 10) out.push({ batch_no: out.length + 1, empty: false, checked_total: 500, candidates: cands.slice(i, i + 10), jobs_json: '[]' });
  return out;
};
const ok = (cid, o = {}) => ({ cid, match: true, remote: true, region: 'worldwide', hours: 'none', entry_ok: true, ...o });
const groq = (results) => ({ choices: [{ message: { content: JSON.stringify({ results }) } }] });
const plan = (level = 'any') => ({ search_id: 's9', query: 'customer support', chat_id: '111', level });

function go(cands, responses, level = 'any') {
  const sd = {};
  const out = run(F, { items: responses, nodes: { Prefilter: batchesOf(cands), 'Build Plan': [plan(level)] }, staticData: sd, now: NOW });
  return { out, ls: sd.lastSearch, byTitle: Object.fromEntries((sd.lastSearch.results || []).map((r) => [r.title, r])) };
}

test('region mapping and hours label', () => {
  const c = [0, 1, 2, 3, 4].map((i) => cand(i));
  const { ls, byTitle, out } = go(c, [groq([ok(0), ok(1, { region: 'israel' }), ok(2, { region: 'apac' }),
    ok(3, { region: 'unclear', hours: 'us' }), ok(4, { region: 'restricted' })])]);
  assert.equal(byTitle['Job 0'].region_label, '🌍 Worldwide');
  assert.equal(byTitle['Job 1'].region_label, '🇮🇱 Israel-friendly');
  assert.equal(byTitle['Job 2'].region_label, '🌏 APAC');
  assert.equal(byTitle['Job 3'].region_label, '❔ location unclear');
  assert.equal(byTitle['Job 3'].hours_label, '🕐 US hours');
  assert.equal(byTitle['Job 0'].hours_label, '');
  assert.equal(byTitle['Job 4'], undefined);
  assert.deepEqual(out, [{ chat_id: '111', search_id: 's9' }]);
  assert.equal(ls.query, 'customer support');
  assert.equal(ls.checked_total, 500);
  assert.equal(ls.page, -1);
  assert.equal(ls.unverified, 0);
});

test('eu hours label; unknown region value dropped', () => {
  const { byTitle } = go([cand(0), cand(1)], [groq([ok(0, { hours: 'eu' }), ok(1, { region: 'us_only' })])]);
  assert.equal(byTitle['Job 0'].hours_label, '🕐 EU hours');
  assert.equal(byTitle['Job 1'], undefined);
});

test('himalayas hint wins over the AI region', () => {
  const { byTitle } = go([cand(0, { region_hint: 'israel', source: 'himalayas' })], [groq([ok(0, { region: 'restricted' })])]);
  assert.equal(byTitle['Job 0'].region_label, '🇮🇱 Israel-friendly');
});

test('drops non-matches, non-remote, and experience-required when entry', () => {
  const c = [0, 1, 2].map((i) => cand(i));
  const r = [groq([ok(0, { match: false }), ok(1, { remote: false }), ok(2, { entry_ok: false })])];
  assert.deepEqual(Object.keys(go(c, r, 'entry').byTitle), []);
  assert.deepEqual(Object.keys(go(c, r, 'any').byTitle), ['Job 2']);
});

test('missing verdicts counted as unverified', () => {
  const c = Array.from({ length: 20 }, (_, i) => cand(i));
  const { ls } = go(c, [groq(c.slice(0, 10).map((x) => ok(x.cid))), { error: { message: 'timeout' } }]);
  assert.equal(ls.results.length, 10);
  assert.equal(ls.unverified, 10);
});

test('garbage content unverified; fenced json and bare array parse', () => {
  const c = Array.from({ length: 30 }, (_, i) => cand(i));
  const { ls } = go(c, [
    { choices: [{ message: { content: 'not json' } }] },
    { choices: [{ message: { content: '```json\n' + JSON.stringify({ results: c.slice(10, 20).map((x) => ok(x.cid)) }) + '\n```' } }] },
    { choices: [{ message: { content: JSON.stringify(c.slice(20, 30).map((x) => ok(x.cid))) } }] },
  ]);
  assert.equal(ls.unverified, 10);
  assert.equal(ls.results.length, 20);
});

test('empty marker -> no results, one output item', () => {
  const sd = {};
  const out = run(F, { items: [{ batch_no: 0, empty: true, checked_total: 7, candidates: [], jobs_json: '[]' }],
    nodes: { Prefilter: [{ batch_no: 0, empty: true, checked_total: 7, candidates: [], jobs_json: '[]' }], 'Build Plan': [plan()] }, staticData: sd, now: NOW });
  assert.deepEqual(sd.lastSearch.results, []);
  assert.equal(sd.lastSearch.checked_total, 7);
  assert.equal(out.length, 1);
});

test('order and cap: newest first, 50 max, ranks 1..50, undated last', () => {
  const c = Array.from({ length: 60 }, (_, i) => cand(i, { posted_at: i === 0 ? 'unknown' : daysAgo(i) }));
  const responses = batchesOf(c).map((b) => groq(b.candidates.map((x) => ok(x.cid))));
  const { ls } = go(c, responses);
  assert.equal(ls.results.length, 50);
  assert.deepEqual(ls.results.map((r) => r.rank), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(ls.results[0].title, 'Job 1');
  assert.equal(ls.results[49].title, 'Job 50');
  assert.deepEqual(Object.keys(ls.results[0]), ['rank', 'title', 'company', 'url', 'source', 'region_label', 'hours_label', 'posted_at']);
});
