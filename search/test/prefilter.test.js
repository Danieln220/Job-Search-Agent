const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./harness');

const F = 'prefilter.js';
const NOW = '2026-10-26T12:00:00Z';
const daysAgo = (d) => new Date(Date.parse(NOW) - d * 86400000).toISOString();
const job = (o) => ({ title: 'Customer Support Agent', company: 'Acme', url: 'https://x/' + Math.random(), description: 'Help customers by chat.',
  source: 'remoteok', posted_at: daysAgo(1), location: '', ...o });
const plan = (terms = ['customer support'], level = 'any') => ({ 'Build Plan': [{ terms, level }] });
const go = (items, nodes = plan()) => run(F, { items, nodes, now: NOW });
const titles = (out) => out.flatMap((b) => b.candidates).map((c) => c.title);

test('term match over title, description and company', () => {
  const out = go([
    job({ title: 'Customer Support Agent' }),
    job({ title: 'Backend Engineer', description: 'Go and Postgres' }),
    job({ title: 'Agent', description: 'Our CUSTOMER SUPPORT team' }),
    job({ title: 'Specialist', company: 'Customer Support Inc' }),
  ]);
  assert.deepEqual(titles(out).sort(), ['Agent', 'Customer Support Agent', 'Specialist']);
});

test('term match respects word boundaries', () =>
  assert.deepEqual(titles(go([job({ title: 'Maintainer', description: 'maintain things' })], plan(['ai']))), []));

test('entry level drops senior titles', () => {
  const out = go([job({ title: 'Senior Support Lead' }), job({ title: 'Support Manager' }), job({ title: 'Support Associate' })],
    plan(['support'], 'entry'));
  assert.deepEqual(titles(out), ['Support Associate']);
});

test('level any keeps senior titles', () =>
  assert.equal(titles(go([job({ title: 'Senior Support Lead' })], plan(['support'], 'any'))).length, 1));

test('30-day window; unparseable date kept', () => {
  const out = go([job({ title: 'Old', description: 'customer support', posted_at: daysAgo(31) }),
    job({ title: 'Fresh', description: 'customer support', posted_at: daysAgo(29) }),
    job({ title: 'Undated', description: 'customer support', posted_at: 'sometime' })]);
  assert.deepEqual(titles(out).sort(), ['Fresh', 'Undated']);
});

test('dedupe by url and by title+company', () => {
  const out = go([job({ url: 'https://a/1' }), job({ url: 'https://a/1/' }),
    job({ url: 'https://b/2', source: 'jobicy' }), job({ url: 'https://c/3', company: '', title: 'Customer Support' }),
    job({ url: 'https://c/4', company: '', title: 'Customer Support' })]);
  assert.deepEqual(out.flatMap((b) => b.candidates).map((c) => c.url).sort(), ['https://a/1', 'https://c/3', 'https://c/4']);
});

test('cap and order: 40 newest in 4 batches of 10', () => {
  const out = go(Array.from({ length: 55 }, (_, i) => job({ title: 'Customer Support ' + i, url: 'https://x/' + i, posted_at: daysAgo(i / 4) })));
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((b) => b.candidates.length), [10, 10, 10, 10]);
  assert.deepEqual(out.map((b) => b.batch_no), [1, 2, 3, 4]);
  const all = out.flatMap((b) => b.candidates);
  assert.deepEqual(all.map((c) => c.cid), [...Array(40).keys()]);
  assert.equal(all[0].title, 'Customer Support 0');
  assert.equal(all[39].title, 'Customer Support 39');
  assert.equal(out[0].checked_total, 55);
  assert.deepEqual(JSON.parse(out[0].jobs_json).map((j) => j.cid), [...Array(10).keys()]);
});

test('jobs_json carries a 600-char text slice and no url', () => {
  const [b] = go([job({ description: 'customer support ' + 'x'.repeat(2000) })]);
  const [j] = JSON.parse(b.jobs_json);
  assert.deepEqual(Object.keys(j), ['cid', 'title', 'company', 'location', 'text']);
  assert.equal(j.text.length, 600);
});

test('location/hours sentences from deep in the post reach the AI', () => {
  const desc = 'Customer support role. ' + 'x '.repeat(1000) + 'Applicants must be based in the United States. ' +
    'We love dogs. ' + 'You must work EST hours. ' + 'y '.repeat(500);
  const [j] = JSON.parse(go([job({ description: desc })])[0].jobs_json);
  assert.ok(j.text.startsWith(desc.slice(0, 600)));
  assert.match(j.text, /Applicants must be based in the United States\./);
  assert.match(j.text, /You must work EST hours\./);
  assert.doesNotMatch(j.text, /We love dogs/);
  assert.ok(j.text.length <= 600 + 5 + 400, 'extra capped at ~400 chars: ' + j.text.length);
});

test('empty terms keep everything (newest 40)', () =>
  assert.equal(titles(go(Array.from({ length: 45 }, (_, i) => job({ title: 'Whatever ' + i, description: 'x', url: 'https://x/' + i })), plan([]))).length, 40));

test('zero candidates -> one empty marker', () => {
  const out = go([job({ title: 'Chef', description: 'cook' }), { error: 'fetch failed' }, { title: 'no url' }]);
  assert.deepEqual(out, [{ batch_no: 0, empty: true, checked_total: 1, candidates: [], jobs_json: '[]' }]);
});

test('region_hint passes through', () =>
  assert.equal(go([job({ region_hint: 'israel' })])[0].candidates[0].region_hint, 'israel'));

test('cap is shared across sources: fresh gigs cannot crowd out older jobs', () => {
  const gigs = Array.from({ length: 60 }, (_, i) => job({ title: 'Customer Support gig ' + i, source: 'freelancer', url: 'https://f/' + i, posted_at: daysAgo(i / 1000) }));
  const wwr = Array.from({ length: 10 }, (_, i) => job({ title: 'Customer Support wwr ' + i, source: 'weworkremotely', url: 'https://w/' + i, posted_at: daysAgo(2 + i / 10) }));
  const him = Array.from({ length: 5 }, (_, i) => job({ title: 'Customer Support him ' + i, source: 'himalayas', url: 'https://h/' + i, posted_at: daysAgo(3 + i / 10) }));
  const all = go([...gigs, ...wwr, ...him]).flatMap((b) => b.candidates);
  const count = (s) => all.filter((c) => c.source === s).length;
  assert.equal(all.length, 40);
  assert.deepEqual([count('freelancer'), count('weworkremotely'), count('himalayas')], [25, 10, 5]);
  assert.ok(all.every((c, i) => i === 0 || Date.parse(all[i - 1].posted_at) >= Date.parse(c.posted_at)), 'newest first');
  assert.deepEqual(all.map((c) => c.cid), [...Array(40).keys()]);
});
