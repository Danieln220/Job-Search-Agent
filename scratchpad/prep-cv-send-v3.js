const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const jobs = $('Apply Prep').all();
const resp = $input.all();

// Thread each pitch under the digest card for the SAME job (2026-09-21). Before this the card
// and the pitch were two unrelated messages for one job, which read as a duplicate posting.
// Card message ids come from this run's sends: 'Telegram: Job Card' (cards with buttons) and
// 'Telegram' (header, plus any card whose archive_id join failed). Both have already run -
// Limit's FIRST branch is Format Digest, whose subtree contains both Telegram nodes.
// Fallback order: card for this job -> the digest header -> 0. Telegram ignores
// reply_to_message_id 0 (probed 2026-09-21), so the pitch is never lost to a bad reply target.
const cardById = {};
const cardByUrl = {};
let headerId = 0;
const noteUrl = (text, id) => {
  const m = /🔗 (\S+)/.exec(String(text || ''));
  if (m && !cardByUrl[m[1]]) cardByUrl[m[1]] = id;
  return !!m;
};
try {
  for (const s of $('Telegram: Job Card').all()) {
    const r = (s.json && s.json.result) || {};
    const id = Number(r.message_id) || 0;
    if (!id) continue; // error item (onError=continueRegularOutput) - nothing to reply to
    const cb = ((((r.reply_markup || {}).inline_keyboard || [])[0] || [])[0] || {}).callback_data || '';
    const m = /^fb:\w+:(\d+)$/.exec(cb);
    if (m && !cardById[m[1]]) cardById[m[1]] = id;
    noteUrl(r.text, id);
  }
} catch (e) { console.log('No job cards to thread under: ' + e.message); }
try {
  for (const s of $('Telegram').all()) {
    const r = (s.json && s.json.result) || {};
    const id = Number(r.message_id) || 0;
    if (!id) continue;
    if (!noteUrl(r.text, id) && !headerId) headerId = id; // the header carries no 🔗 line
  }
} catch (e) { console.log('No header message to fall back on: ' + e.message); }

const out = [];
let threaded = 0;
for (let i = 0; i < resp.length; i++) {
  const j = resp[i].json || {};
  const job = (jobs[i] && jobs[i].json) || {};
  const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) { console.log('Pitch draft missing for item ' + i); continue; }
  const pitch = String(content).trim().slice(0, 700);
  const caption = ('📨 <b>Ready to forward</b> — ' + esc(job.title || '') + (job.company ? ' @ ' + esc(job.company) : '') + '\n\n' + esc(pitch) + '\n\n🔗 ' + esc(job.url || '')).slice(0, 1000);
  const replyTo = cardById[String(job.archive_id || '')] || cardByUrl[job.url] || headerId || 0;
  if (replyTo && replyTo !== headerId) threaded++;
  out.push({ json: { caption, url: job.url || '', reply_to: replyTo } });
}
console.log('Pitches: ' + out.length + ', threaded under their own card: ' + threaded);
return out;
