const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./harness');

const NOW = '2026-10-26T12:00:00Z';
const res = (rank) => ({ rank, title: 'Job ' + rank, company: 'Co ' + rank, url: 'https://x/' + rank,
  source: rank % 2 ? 'himalayas' : 'remoteok', region_label: '🌍 Worldwide', hours_label: '', posted_at: '2026-10-25T10:00:00Z' });
const ls = (n = 9) => ({ search_id: 's9', query: 'customer support', chat_id: '111', checked_total: 480,
  unverified: 0, page: 0, results: Array.from({ length: n }, (_, i) => res(i + 1)) });
const prep = (ranks, sd = { lastSearch: ls() }) =>
  run('prep-save.js', { items: [{ kind: 'save', chat_id: '111', save_ranks: ranks }], staticData: sd, now: NOW });
const events = (rows) => run('feedback-event.js', {
  items: rows.map((r, i) => ({ id: 2000 + i, ...r })), nodes: { 'Prep Save': rows }, now: NOW });
const reply = (rows) => run('save-reply.js', { nodes: { 'Feedback Event': events(rows), 'Prep Save': rows } })[0];

test('valid ranks', () => {
  const rows = prep([3, 5]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r._rank), [3, 5]);
  assert.equal(rows[0].source, 'search:himalayas');
  assert.equal(rows[0].url, 'https://x/3');
  assert.equal(rows[0].delivered, true);
  assert.equal(rows[0]._query, 'customer support');
  assert.equal(rows[0]._chat_id, '111');
  assert.deepEqual(rows[0]._invalid, []);
  assert.match(rows[0].first_seen, /^2026-10-26T19:00:00\.000\+07:00$/);
  assert.match(reply(rows).text, /^⭐ Saved 2: #3 Job 3, #5 Job 5$/);
  assert.equal(reply(rows).chat_id, '111');
});

test('invalid only', () => {
  const out = prep([12]);
  assert.equal(out.length, 1);
  assert.equal(out[0].reply_only, true);
  assert.equal(out[0].chat_id, '111');
  assert.match(out[0].text, /No #12 in your last search \(9 results\)/);
});

test('mixed', () => {
  const rows = prep([3, 12]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]._invalid, [12]);
  const t = reply(rows).text;
  assert.match(t, /⭐ Saved 1: #3 Job 3/);
  assert.match(t, /No #12 in your last search \(9 results\)/);
});

test('no search yet', () => {
  const out = prep([3], {});
  assert.equal(out[0].reply_only, true);
  assert.match(out[0].text, /No search yet/);
});

test('duplicate ranks', () => assert.equal(prep([3, 3]).length, 1));

test('feedback event shape', () => {
  const ev = events(prep([3, 5]));
  assert.equal(ev.length, 2);
  assert.deepEqual(Object.keys(ev[0]), ['date', 'status', 'score', 'title', 'company', 'source', 'url', 'archive_id', 'note']);
  assert.equal(ev[0].status, 'saved');
  assert.equal(ev[0].score, '');
  assert.equal(ev[0].archive_id, 2000);
  assert.equal(ev[1].archive_id, 2001);
  assert.equal(ev[1].url, 'https://x/5');
  assert.equal(ev[0].source, 'search:himalayas');
  assert.equal(ev[0].note, 'search: customer support #3');
  assert.ok(!Number.isNaN(Date.parse(ev[0].date)));
});

test('reply escapes html in titles', () => {
  const sd = { lastSearch: { ...ls(), results: [{ ...res(1), title: 'A<b> & co' }] } };
  assert.match(reply(prep([1], sd)).text, /#1 A&lt;b&gt; &amp; co/);
});
