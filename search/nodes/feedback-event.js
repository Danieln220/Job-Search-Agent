// One 'saved' event per inserted archive row, paired by index with Prep Save. Key order is the
// Google Sheet's header row (same shape as the Feedback workflow's Build Event).
const rows = $('Prep Save').all().map((i) => i.json);
const date = new Date().toISOString();
return $input.all().map((ins, i) => {
  const r = rows[i];
  return { json: {
    date, status: 'saved', score: '', title: r.title, company: r.company, source: r.source,
    url: r.url, archive_id: ins.json.id, note: `search: ${r._query} #${r._rank}`,
  } };
});
