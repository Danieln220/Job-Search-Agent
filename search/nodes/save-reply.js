// Confirms what was saved, plus the "No #12 …" note when some ranks were not in the list.
// Some sources send text already HTML-encoded ("Aisles &amp; Abroad"): decode first, escape once.
const esc = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|#0?39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[e] || "'")
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rows = $('Prep Save').all().map((i) => i.json);
const saved = $('Feedback Event').all().map((e, i) => `#${rows[i]._rank} ${esc(String(e.json.title).slice(0, 80))}`);
const text = [`⭐ Saved ${saved.length}: ${saved.join(', ')}`, rows[0]._missing].filter(Boolean).join('\n');
return [{ json: { chat_id: rows[0]._chat_id, text } }];
