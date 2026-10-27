// Turns Groq's interpretation of the request into fetch urls + the "searching…" reply.
// Falls back to the user's own words when Groq failed or returned no usable JSON.
const WWR_CATEGORIES = [
  'remote-customer-support-jobs', 'remote-design-jobs', 'remote-sales-and-marketing-jobs',
  'remote-management-and-finance-jobs', 'remote-product-jobs', 'remote-devops-sysadmin-jobs',
  'remote-full-stack-programming-jobs', 'remote-back-end-programming-jobs',
  'remote-front-end-programming-jobs', 'remote-programming-jobs', 'all-other-remote-jobs',
];
const JOBICY_INDUSTRIES = [
  'admin-support', 'business', 'copywriting', 'design-multimedia', 'supporting', 'cybersecurity',
  'data-science', 'admin', 'education', 'accounting-finance', 'healthcare', 'hr', 'legal',
  'marketing', 'management', 'project-management', 'qa-testing', 'seller', 'seo', 'engineering',
  'technical-support', 'web-app-design',
];
const STOPWORDS = new Set(('remote job jobs find me a an for the any no experience matter what worldwide ' +
  'anywhere work from home please i want need').split(' '));
const ENTRY_RX = /no experience|entry|junior|beginner|trainee|intern/i;

const pm = $('Parse Message').first().json;
const query = pm.query;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let ai = null;
try {
  const content = $input.first().json.choices[0].message.content;
  const parsed = JSON.parse(String(content).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ai = parsed;
} catch (e) { /* fall back below */ }

const modelTerms = ai && Array.isArray(ai.terms)
  ? ai.terms.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().toLowerCase())
  : null;
const ownWords = query.toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter((w) => w && !STOPWORDS.has(w));
const terms = [...new Set(modelTerms && modelTerms.length ? modelTerms : (ai ? [] : ownWords))].slice(0, 8);
const level = ai && (ai.level === 'entry' || ai.level === 'any') ? ai.level : (ENTRY_RX.test(query) ? 'entry' : 'any');

const wwr = ai && WWR_CATEGORIES.includes(ai.wwr_category) ? ai.wwr_category : null;
const jobicy = ai && JOBICY_INDUSTRIES.includes(ai.jobicy_industry) ? ai.jobicy_industry : null;

const himalayas = (term) => 'https://himalayas.app/jobs/api/search?' +
  (term ? 'q=' + encodeURIComponent(term) + '&' : '') +
  'country=Israel' + (level === 'entry' ? '&seniority=Entry-level' : '') + '&sort=recent';

const text = [
  '🔎 Searching for: <b>' + (terms.length ? terms.map(esc).join(' · ') : 'the newest remote jobs') + '</b>',
  'Level: <b>' + (level === 'entry' ? 'entry / no experience' : 'any') + '</b> · remote only',
  'Takes about 1–2 minutes.',
].join('\n');

return [{ json: {
  search_id: 's' + pm.update_id,
  chat_id: pm.chat_id,
  query,
  terms,
  level,
  freelancer_queries: terms.slice(0, 3),
  himalayas_urls: terms.length ? terms.slice(0, 2).map(himalayas) : [himalayas('')],
  wwr_category_url: wwr ? 'https://weworkremotely.com/categories/' + wwr + '.rss' : 'https://weworkremotely.com/remote-jobs.rss',
  jobicy_industry_url: 'https://jobicy.com/api/v2/remote-jobs?count=50' + (jobicy ? '&industry=' + jobicy : ''),
  text,
} }];
