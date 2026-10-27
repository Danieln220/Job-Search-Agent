// The normalizers copied from the daily digest drop each source's location field (the digest never
// needed it), so the AI check could not see e.g. RemoteOK's "Seattle, Washington". Put it back by url.
// Jobicy and HN already carry location at the start of the description; WWR and Freelancer have none.
const RAW = [
  ['Fetch RemoteOK', null, 'location'],
  ['Fetch Remotive (ai)', 'jobs', 'candidate_required_location'],
  ['Fetch Remotive (automation)', 'jobs', 'candidate_required_location'],
  ['Fetch Working Nomads', null, 'location'],
  ['Fetch Arbeitnow', 'data', 'location'],
];
const loc = new Map();
for (const [node, list, key] of RAW) {
  let rows;
  try { rows = $(node).all().map((i) => i.json); } catch (e) { continue; } // node did not run
  for (const r of rows) {
    for (const x of list ? r[list] || [] : [r]) {
      const v = String(x[key] || '').trim();
      if (x.url && v) loc.set(x.url, v);
    }
  }
}
return $input.all().map((i) => (i.json.location || !loc.has(i.json.url)
  ? { json: i.json } : { json: { ...i.json, location: loc.get(i.json.url) } }));
