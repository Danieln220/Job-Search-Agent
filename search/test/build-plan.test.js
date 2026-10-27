const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./harness');

const F = 'build-plan.js';
const groq = (o) => [{ choices: [{ message: { content: typeof o === 'string' ? o : JSON.stringify(o) } }] }];
const pm = { 'Parse Message': [{ kind: 'search', chat_id: '111', update_id: 9, query: 'remote customer support no experience' }] };

test('uses model terms', () => {
  const [p] = run(F, {
    items: groq({ terms: ['customer support', 'help desk'], level: 'entry', wwr_category: 'remote-customer-support-jobs', jobicy_industry: 'supporting' }),
    nodes: pm,
  });
  assert.equal(p.search_id, 's9');
  assert.equal(p.chat_id, '111');
  assert.equal(p.query, 'remote customer support no experience');
  assert.deepEqual(p.terms, ['customer support', 'help desk']);
  assert.equal(p.level, 'entry');
  assert.equal(p.wwr_category_url, 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss');
  assert.equal(p.jobicy_industry_url, 'https://jobicy.com/api/v2/remote-jobs?count=50&industry=supporting');
  assert.deepEqual(p.himalayas_urls, [
    'https://himalayas.app/jobs/api/search?q=customer%20support&country=Israel&seniority=Entry-level&sort=recent',
    'https://himalayas.app/jobs/api/search?q=help%20desk&country=Israel&seniority=Entry-level&sort=recent',
  ]);
  assert.deepEqual(p.freelancer_queries, ['customer support', 'help desk']);
  assert.match(p.text, /customer support · help desk/);
});

test('level any has no seniority filter', () => {
  const [p] = run(F, { items: groq({ terms: ['designer'], level: 'any' }), nodes: pm });
  assert.deepEqual(p.himalayas_urls, ['https://himalayas.app/jobs/api/search?q=designer&country=Israel&sort=recent']);
});

test('fenced json accepted', () =>
  assert.equal(run(F, { items: groq('```json\n{"terms":["data entry"],"level":"any"}\n```'), nodes: pm })[0].terms[0], 'data entry'));

test('non-JSON falls back to own words', () => {
  const [p] = run(F, { items: groq('sorry'), nodes: pm });
  assert.deepEqual(p.terms, ['customer', 'support']);
  assert.equal(p.level, 'entry');
});

test('failed Groq call falls back to own words', () =>
  assert.deepEqual(run(F, { items: [{ error: { message: 'timeout' } }], nodes: pm })[0].terms, ['customer', 'support']));

test('unknown slugs -> generic feeds', () => {
  const [p] = run(F, { items: groq({ terms: ['x'], level: 'any', wwr_category: 'bogus', jobicy_industry: 'bogus' }), nodes: pm });
  assert.equal(p.wwr_category_url, 'https://weworkremotely.com/remote-jobs.rss');
  assert.equal(p.jobicy_industry_url, 'https://jobicy.com/api/v2/remote-jobs?count=50');
});

test('all filler -> empty terms, still searches', () => {
  const nodes = { 'Parse Message': [{ ...pm['Parse Message'][0], query: 'remote job no matter what' }] };
  const [p] = run(F, { items: groq('nope'), nodes });
  assert.deepEqual(p.terms, []);
  assert.deepEqual(p.himalayas_urls, ['https://himalayas.app/jobs/api/search?country=Israel&sort=recent']);
  assert.deepEqual(p.freelancer_queries, []);
  assert.match(p.text, /the newest remote jobs/);
});

test('ack text is html-escaped', () =>
  assert.match(run(F, { items: groq({ terms: ['r&d <lab>'], level: 'any' }), nodes: pm })[0].text, /r&amp;d &lt;lab&gt;/));
