// Mark delivered ONLY the cards Telegram actually accepted (2026-09-21).
// This used to run straight off `Limit`, so every job in the digest was flagged delivered=true
// even when its card never left the building. Now that `Telegram: Job Card` no longer retries
// (a retried send is what produced three copies of one card on 09-21), an unsent card MUST stay
// delivered=false so Resume Scored's undelivered-recovery re-surfaces it on the next run.
const jobs = $('Limit').all().map(i => i.json || {});
const byId = {};
for (const j of jobs) if (j.archive_id) byId[String(j.archive_id)] = j;

const sends = $input.all();
const out = [];
const seen = new Set();
for (const s of sends) {
  const j = s.json || {};
  const r = j.result || {};
  if (!j.ok || !r.message_id) {
    console.log('Card NOT delivered, leaving delivered=false: ' + String(j.error || 'unknown error'));
    continue;
  }
  const cb = ((((r.reply_markup || {}).inline_keyboard || [])[0] || [])[0] || {}).callback_data || '';
  const m = /^fb:\w+:(\d+)$/.exec(cb);
  const job = m ? byId[m[1]] : null;
  const fromText = /🔗 (\S+)/.exec(String(r.text || ''));
  const url = (job && job.url) || (fromText && fromText[1]) || '';
  if (!url || seen.has(url)) continue;
  seen.add(url);
  out.push({ json: { url } });
}
console.log('Marking delivered: ' + out.length + ' of ' + sends.length + ' card sends');
return out;
