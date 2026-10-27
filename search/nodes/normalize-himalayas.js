// Himalayas search responses -> the shared job shape. The search ran with country=Israel, so a job is
// either worldwide (no restrictions) or lists Israel. region_hint is authoritative downstream.
const text = (html) => String(html || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const seen = new Set();
const out = [];
for (const item of $input.all()) {
  for (const j of item.json.jobs || []) {
    const url = j.applicationLink || j.guid;
    const where = j.locationRestrictions || [];
    if (!j.title || !url || seen.has(url)) continue;
    if (where.length && !where.includes('Israel')) continue;
    seen.add(url);
    out.push({ json: {
      title: j.title,
      company: j.companyName || '',
      url,
      description: text(j.description || j.excerpt).slice(0, 4000),
      source: 'himalayas',
      posted_at: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : '',
      location: where.length ? where.join(', ') : 'Worldwide',
      region_hint: where.length ? 'israel' : 'worldwide',
    } });
  }
}
return out;
