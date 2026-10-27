// Classifies one Telegram text message forwarded by the bridge: search / more / save / help.
// Returns [] (chain stops) for other chats, messages without text, and update_ids already seen
// (the bridge is at-least-once, so the same message can arrive twice).
const ALLOWED_CHAT_ID = '__CHAT_ID__';
const KEEP_IDS = 200;

const HELP = [
  '🔎 <b>Job search</b>',
  'Type the kind of job you want, e.g. <i>remote customer support no experience</i>.',
  'I search all the job sites and reply with a numbered list.',
  '',
  '<b>more</b> - next 10 results',
  '<b>save 3</b> - save job 3 (or <b>save 3 5</b>)',
].join('\n');

const body = $input.first().json.body || {};
const msg = body.message || {};
const chatId = String((msg.chat || {}).id ?? '');
const text = String(msg.text || '').trim();
if (chatId !== ALLOWED_CHAT_ID || !text) return [];

const sd = $getWorkflowStaticData('global');
const seen = sd.processedUpdateIds || [];
if (seen.includes(body.update_id)) return [];
sd.processedUpdateIds = [...seen, body.update_id].slice(-KEEP_IDS);

const base = { chat_id: chatId, update_id: body.update_id, text };
const save = text.match(/^save\s+(\d+(?:[\s,]+\d+)*)$/i);

if (/^more$/i.test(text)) return [{ json: { ...base, kind: 'more' } }];
if (save) return [{ json: { ...base, kind: 'save', save_ranks: save[1].split(/[\s,]+/).map(Number) } }];
if (/^\/?(start|help)$/i.test(text) || text.length < 3 || !/\p{L}/u.test(text)) {
  return [{ json: { ...base, kind: 'help', text: HELP } }];
}
return [{ json: { ...base, kind: 'search', query: text } }];
