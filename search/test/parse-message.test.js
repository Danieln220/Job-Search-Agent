const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./harness');

const F = 'parse-message.js';
const body = (text, update_id = 1, chat = 111) => [{ body: { update_id, message: { chat: { id: chat }, text } } }];

test('search text', () => {
  const [o] = run(F, { items: body('remote customer support no experience') });
  assert.equal(o.kind, 'search');
  assert.equal(o.query, 'remote customer support no experience');
  assert.equal(o.chat_id, '111');
  assert.equal(o.update_id, 1);
});

test('more', () => assert.equal(run(F, { items: body(' More ') })[0].kind, 'more'));

test('save list', () => assert.deepEqual(run(F, { items: body('save 3, 5 7') })[0].save_ranks, [3, 5, 7]));

test('help and /start', () => {
  for (const t of ['help', '/start', 'hi', '???']) assert.equal(run(F, { items: body(t) })[0].kind, 'help', t);
  assert.match(run(F, { items: body('help') })[0].text, /save 3/);
});

test('other chat ignored', () => assert.deepEqual(run(F, { items: body('data entry', 1, 999) }), []));

test('message without text ignored', () =>
  assert.deepEqual(run(F, { items: [{ body: { update_id: 3, message: { chat: { id: 111 } } } }] }), []));

test('duplicate update_id is ignored', () => {
  const sd = {};
  assert.equal(run(F, { items: body('data entry', 42), staticData: sd }).length, 1);
  assert.deepEqual(run(F, { items: body('data entry', 42), staticData: sd }), []);
});

test('keeps 200 ids', () => {
  const sd = { processedUpdateIds: [...Array(200).keys()] };
  run(F, { items: body('x y z', 500), staticData: sd });
  assert.equal(sd.processedUpdateIds.length, 200);
  assert.equal(sd.processedUpdateIds.at(-1), 500);
});
