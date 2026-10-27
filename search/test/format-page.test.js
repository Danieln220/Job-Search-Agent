const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./harness');

const F = 'format-page.js';
const NOW = '2026-10-26T12:00:00Z'; // 19:00 in Bangkok
const res = (rank, o = {}) => ({ rank, title: 'Job ' + rank, company: 'Co', url: 'https://x/' + rank, source: 'remoteok',
  region_label: '🌍 Worldwide', hours_label: '', posted_at: '2026-10-25T10:00:00Z', ...o });
const search = (n, o = {}) => ({ search_id: 's9', query: 'customer support', chat_id: '111', checked_total: 480,
  unverified: 0, page: -1, results: Array.from({ length: n }, (_, i) => res(i + 1)), ...o });
const page = (sd, kind) => run(F, { items: [{ chat_id: '111', ...(kind ? { kind } : {}) }], staticData: sd, now: NOW })[0];
const lines = (text) => text.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => Number(l.split('.')[0]));

test('first page', () => {
  const sd = { lastSearch: search(23) };
  const o = page(sd);
  assert.equal(o.chat_id, '111');
  assert.match(o.text, /Found 23 matches for "customer support"/);
  assert.deepEqual(lines(o.text), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(o.text, /Checked 480 listings · showing 1–10 of 23/);
  assert.match(o.text, /Reply <b>more<\/b> or <b>save 3<\/b>/);
  assert.equal(sd.lastSearch.page, 0);
});

test('more pages, then the end', () => {
  const sd = { lastSearch: search(23) };
  page(sd);
  assert.deepEqual(lines(page(sd, 'more').text), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(sd.lastSearch.page, 1);
  const third = page(sd, 'more').text;
  assert.deepEqual(lines(third), [21, 22, 23]);
  assert.match(third, /showing 21–23 of 23/);
  assert.doesNotMatch(third, /<b>more<\/b>/);
  assert.match(page(sd, 'more').text, /That's all 23 results/);
  assert.equal(sd.lastSearch.page, 2);
});

test('a new search resets to page 0', () => {
  const sd = { lastSearch: search(23, { page: 2 }) };
  assert.deepEqual(lines(page(sd).text).slice(0, 1), [1]);
});

test('line format', () => {
  const sd = { lastSearch: search(0, { results: [res(3, { title: 'Title', company: 'Company', url: 'https://u/1', hours_label: '🕐 US hours', posted_at: '2026-10-24T05:00:00Z' })] }) };
  assert.match(page(sd).text, /^3\. <a href="https:\/\/u\/1">Title<\/a> — Company · 🌍 Worldwide · 🕐 US hours · 2d · remoteok$/m);
});

test('himalayas credit, today, no company, undated', () => {
  const sd = { lastSearch: search(0, { results: [
    res(1, { source: 'himalayas', posted_at: '2026-10-26T02:00:00Z' }),
    res(2, { company: '', posted_at: 'whenever' }),
  ] }) };
  const t = page(sd).text;
  assert.match(t, /^1\. .* · today · via Himalayas$/m);
  assert.match(t, /^2\. <a href="https:\/\/x\/2">Job 2<\/a> · 🌍 Worldwide · remoteok$/m);
});

test('age uses Bangkok calendar days', () => {
  // 2026-10-25T18:00Z is already 26 Oct 01:00 in Bangkok -> "today"
  const sd = { lastSearch: search(0, { results: [res(1, { posted_at: '2026-10-25T18:00:00Z' })] }) };
  assert.match(page(sd).text, /· today ·/);
});

test('escapes html', () => {
  const sd = { lastSearch: search(0, { results: [res(1, { title: 'A<b> & co', company: 'X&Y', url: 'https://x/?a=1&b=2' })] }) };
  const t = page(sd).text;
  assert.match(t, /href="https:\/\/x\/\?a=1&amp;b=2">A&lt;b&gt; &amp; co<\/a> — X&amp;Y/);
});

test('unverified note', () =>
  assert.match(page({ lastSearch: search(5, { unverified: 10 }) }).text, /\(10 couldn't be checked\)/));

test('no results', () => {
  const t = page({ lastSearch: search(0) }).text;
  assert.match(t, /No matches for "customer support" in 480 listings/);
  assert.match(t, /broader/);
});

test('no search yet', () =>
  assert.equal(page({}, 'more').text, 'No search yet - type what kind of job you want.'));

test('message stays under the Telegram limit', () => {
  const long = 'W'.repeat(300);
  const url = 'https://x/' + 'u'.repeat(110); // realistic worst case; links can't be shortened
  const sd = { lastSearch: search(0, { query: long, results: Array.from({ length: 10 }, (_, i) => res(i + 1, { title: long, company: long, url })) }) };
  assert.ok(page(sd).text.length < 4096);
});

test('already-encoded source text is not encoded twice', () => {
  const sd = { lastSearch: search(0, { results: [res(1, { title: 'Ops &#39;24', company: 'Aisles &amp; Abroad' })] }) };
  const t = page(sd).text;
  assert.match(t, /— Aisles &amp; Abroad ·/);
  assert.match(t, />Ops '24</);
});

test('every AI batch failed -> says so instead of "no matches"', () => {
  const t = page({ lastSearch: search(0, { unverified: 40 }) }).text;
  assert.match(t, /Couldn't check 40 listings/);
  assert.match(t, /try again in a minute/);
  assert.doesNotMatch(t, /No matches|broader/);
});

test('no listings fetched at all -> sources unreachable', () => {
  const t = page({ lastSearch: search(0, { checked_total: 0 }) }).text;
  assert.match(t, /Couldn't reach the job sources/);
  assert.doesNotMatch(t, /No matches|broader/);
});
