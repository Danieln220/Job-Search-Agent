const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./harness');

const F = 'normalize-himalayas.js';
const job = (o) => ({
  title: 'Customer Support Agent', companyName: 'Acme', applicationLink: 'https://himalayas.app/a/1',
  guid: 'https://himalayas.app/g/1', excerpt: 'short', description: '<h3>Remote &amp; global</h3><p>Help  customers.</p>',
  pubDate: 1792297863, locationRestrictions: [], seniority: ['Entry-level'], ...o,
});

test('maps fields to the shared job shape', () => {
  const [j] = run(F, { items: [{ jobs: [job({})] }] });
  assert.deepEqual(j, {
    title: 'Customer Support Agent', company: 'Acme', url: 'https://himalayas.app/a/1',
    description: 'Remote & global Help customers.', source: 'himalayas',
    posted_at: new Date(1792297863000).toISOString(), location: 'Worldwide', region_hint: 'worldwide',
  });
});

test('israel in restrictions -> israel hint', () => {
  const [j] = run(F, { items: [{ jobs: [job({ locationRestrictions: ['Israel', 'Germany'] })] }] });
  assert.equal(j.region_hint, 'israel');
  assert.equal(j.location, 'Israel, Germany');
});

test('restriction list without Israel is dropped', () =>
  assert.deepEqual(run(F, { items: [{ jobs: [job({ locationRestrictions: ['Germany'] })] }] }), []));

test('dedupes urls across pages, skips error items', () => {
  const out = run(F, { items: [{ jobs: [job({}), job({ title: 'Other', applicationLink: 'https://himalayas.app/a/2' })] }, { jobs: [job({})] }, { error: 'x' }] });
  assert.deepEqual(out.map((j) => j.url), ['https://himalayas.app/a/1', 'https://himalayas.app/a/2']);
});

test('guid used when applicationLink missing; description capped at 4000', () => {
  const [j] = run(F, { items: [{ jobs: [job({ applicationLink: '', description: 'x'.repeat(5000) })] }] });
  assert.equal(j.url, 'https://himalayas.app/g/1');
  assert.equal(j.description.length, 4000);
});
