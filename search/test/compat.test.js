// Runs the Weekly Stats and Feedback code nodes taken from the newest backups/ copy of each live
// workflow (git-ignored). Re-fetch the live workflows into backups/ after patching to test them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runCode } = require('./harness');

const BACKUPS = path.join(__dirname, '..', '..', 'backups');
const liveCode = (prefix, node) => {
  const f = fs.readdirSync(BACKUPS).filter((n) => n.startsWith(prefix + '-2')).sort().pop();
  return JSON.parse(fs.readFileSync(path.join(BACKUPS, f), 'utf8')).nodes.find((n) => n.name === node).parameters.jsCode;
};
const NOW = '2026-10-26T05:00:00Z';

test('weekly stats ignores search rows', () => {
  const row = (o) => ({ url: 'https://a', title: 'A', source: 'remoteok', score: 70, first_seen: '2026-10-25T10:00:00+07:00', delivered: true, ...o });
  const [out] = runCode(liveCode('weekly-stats', 'Build Stats'), {
    nodes: { 'Read Archive': [row(), row({ url: 'https://b', title: 'B', source: 'search:himalayas', score: null })] }, now: NOW });
  assert.match(out.text, /scored: 1\b/);
  assert.doesNotMatch(out.text, /search:/);
});

const card = (job) => runCode(liveCode('feedback', 'Render Message'), { now: NOW, nodes: {
  'Parse Callback': [{ archive_id: 5, action: 'save', label: 'Saved', rated_at: NOW, chat_id: '111', message_id: '9', callback_query_id: 'x' }],
  'Lookup Job': [{ id: 5, title: 'T', company: 'C', url: 'https://u', ...job }] } })[0].text;

test('feedback card has no star line without a score', () =>
  assert.doesNotMatch(card({ score: null, category: null, source: 'search:himalayas' }), /^⭐/m));

test('feedback card keeps the star line with a score', () =>
  assert.match(card({ score: 85, category: 'ai_automation', source: 'remoteok' }), /^⭐ 85 · ai_automation$/m));
