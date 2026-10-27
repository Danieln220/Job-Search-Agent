const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./harness');

const F = 'add-locations.js';
const job = (url, o = {}) => ({ title: 'T', company: 'C', url, description: 'd', source: 's', posted_at: '2026-10-25T00:00:00Z', ...o });
const raw = {
  'Fetch RemoteOK': [{ legal: 'notice' }, { url: 'https://r/1', location: 'Seattle, Washington' }, { url: 'https://r/2', location: '' }],
  'Fetch Remotive (ai)': [{ jobs: [{ url: 'https://m/1', candidate_required_location: 'USA, Canada' }] }],
  'Fetch Remotive (automation)': [{ error: { message: 'timeout' } }],
  'Fetch Working Nomads': [{ url: 'https://w/1', location: 'Global' }],
  'Fetch Arbeitnow': [{ data: [{ url: 'https://a/1', location: 'Berlin' }] }],
};
const go = (items, nodes = raw) => run(F, { items, nodes });

test('fills location from each raw source by url', () => {
  const out = go([job('https://r/1'), job('https://m/1'), job('https://w/1'), job('https://a/1')]);
  assert.deepEqual(out.map((j) => j.location), ['Seattle, Washington', 'USA, Canada', 'Global', 'Berlin']);
  assert.equal(out[0].title, 'T');
});

test('keeps an existing location and leaves unknown urls alone', () => {
  const out = go([job('https://r/1', { location: 'Worldwide' }), job('https://x/9'), job('https://r/2')]);
  assert.equal(out[0].location, 'Worldwide');
  assert.equal(out[1].location, undefined);
  assert.equal(out[2].location, undefined);
});

test('a fetch node that did not run is skipped', () => {
  const { 'Fetch Arbeitnow': _, ...partial } = raw;
  assert.equal(go([job('https://r/1')], partial)[0].location, 'Seattle, Washington');
});
