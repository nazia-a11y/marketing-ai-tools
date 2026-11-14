// Marketing tools API: one Cloudflare Worker shared by every tool.
// It holds the Anthropic key, limits usage, caches results and routes requests.
//
// Bindings (set in the Cloudflare dashboard):
//   ANTHROPIC_API_KEY  secret
//   STORE              KV namespace (cache, run counters and daily usage stats)
//   ALLOWED_ORIGINS    comma-separated list of pages allowed to call this API
//   DAILY_CAP          visibility check: total runs per day (default 20)
//   VISITOR_CAP        visibility check: runs per visitor per day (default 2)
//   PLAN_DAILY_CAP     pipeline planner: total runs per day (default 30)
//   PLAN_VISITOR_CAP   pipeline planner: runs per visitor per day (default 5)
//   REF_DAILY_CAP      referral calculator: total runs per day (default 30)
//   REF_VISITOR_CAP    referral calculator: runs per visitor per day (default 5)
//   ROUTE_DAILY_CAP    global hiring planner: total runs per day (default 30)
//   ROUTE_VISITOR_CAP  global hiring planner: runs per visitor per day (default 5)
//   MODEL              Claude model (default claude-haiku-5-5)

const DEFAULTS = { DAILY_CAP: 20, VISITOR_CAP: 2, PLAN_DAILY_CAP: 30, PLAN_VISITOR_CAP: 5, REF_DAILY_CAP: 30, REF_VISITOR_CAP: 5, ROUTE_DAILY_CAP: 30, ROUTE_VISITOR_CAP: 5, MODEL: 'claude-haiku-5-5' };
const CACHE_SECONDS = 24 * 60 * 60;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') return json({ ok: true }, 200, cors);
      if (url.pathname === '/api/usage' && request.method === 'GET') {
        const t = url.searchParams.get('tool');
        const tool = t === 'plan' || t === 'referral' || t === 'route' ? t : 'visibility';
        if (cors['Access-Control-Allow-Origin']) ctx.waitUntil(track(request, env, tool, 'loads'));
        return json(await usage(request, env, tool), 200, cors);
      }
      if (url.pathname === '/api/visibility' && request.method === 'POST') {
        if (!cors['Access-Control-Allow-Origin']) return json({ error: 'This page is not allowed to use the API.' }, 403, cors);
        const input = cleanVisibilityInput(await request.json().catch(() => ({})));
        if (input.error) return json({ error: input.error }, 400, cors);
        return json(await runLimited(request, env, 'visibility', input, () => visibility(input, env)), 200, cors);
      }
      if (url.pathname === '/api/plan' && request.method === 'POST') {
        if (!cors['Access-Control-Allow-Origin']) return json({ error: 'This page is not allowed to use the API.' }, 403, cors);
        const input = cleanPlanInput(await request.json().catch(() => ({})));
        if (input.error) return json({ error: input.error }, 400, cors);
        return json(await runLimited(request, env, 'plan', input, () => plan(input, env)), 200, cors);
      }
      if (url.pathname === '/api/referral' && request.method === 'POST') {
        if (!cors['Access-Control-Allow-Origin']) return json({ error: 'This page is not allowed to use the API.' }, 403, cors);
        const input = cleanReferralInput(await request.json().catch(() => ({})));
        if (input.error) return json({ error: input.error }, 400, cors);
        return json(await runLimited(request, env, 'referral', input, () => referral(input, env)), 200, cors);
      }
      if (url.pathname === '/api/route' && request.method === 'POST') {
        if (!cors['Access-Control-Allow-Origin']) return json({ error: 'This page is not allowed to use the API.' }, 403, cors);
        const input = cleanRouteInput(await request.json().catch(() => ({})));
        if (input.error) return json({ error: input.error }, 400, cors);
        return json(await runLimited(request, env, 'route', input, () => routeReview(input, env)), 200, cors);
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      const status = e.status || 500;
      return json({ error: e.publicMessage || 'Something went wrong. Please try again later.' }, status, cors);
    }
  }
};

// ---------- shared layer ----------

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

function fail(status, publicMessage) {
  const e = new Error(publicMessage);
  e.status = status;
  e.publicMessage = publicMessage;
  return e;
}

const today = () => new Date().toISOString().slice(0, 10);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function visitorId(request) {
  // Hash the address so no personal data is stored.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return (await sha256(ip + today())).slice(0, 24);
}

// Each tool has its own limits, so one cannot use up the other's runs.
function caps(env, tool) {
  if (tool === 'route') {
    return {
      daily: Number(env.ROUTE_DAILY_CAP || DEFAULTS.ROUTE_DAILY_CAP),
      visitor: Number(env.ROUTE_VISITOR_CAP || DEFAULTS.ROUTE_VISITOR_CAP)
    };
  }
  if (tool === 'referral') {
    return {
      daily: Number(env.REF_DAILY_CAP || DEFAULTS.REF_DAILY_CAP),
      visitor: Number(env.REF_VISITOR_CAP || DEFAULTS.REF_VISITOR_CAP)
    };
  }
  if (tool === 'plan') {
    return {
      daily: Number(env.PLAN_DAILY_CAP || DEFAULTS.PLAN_DAILY_CAP),
      visitor: Number(env.PLAN_VISITOR_CAP || DEFAULTS.PLAN_VISITOR_CAP)
    };
  }
  return {
    daily: Number(env.DAILY_CAP || DEFAULTS.DAILY_CAP),
    visitor: Number(env.VISITOR_CAP || DEFAULTS.VISITOR_CAP)
  };
}

// The visibility check keeps its original counter names.
const counterKeys = (tool, vid) => {
  const p = tool === 'visibility' ? '' : `${tool}:`;
  return { dayKey: `count:${p}${today()}`, visKey: `visitor:${p}${today()}:${vid}` };
};

async function usage(request, env, tool) {
  const c = caps(env, tool);
  const { dayKey, visKey } = counterKeys(tool, await visitorId(request));
  const used = Number((await env.STORE.get(dayKey)) || 0);
  const mine = Number((await env.STORE.get(visKey)) || 0);
  return { remaining_today: Math.max(0, c.daily - used), remaining_for_you: Math.max(0, c.visitor - mine) };
}

// Cached results are free and do not count against any limit.
async function runLimited(request, env, tool, input, work) {
  const key = `cache:${tool}:v14:${await sha256(JSON.stringify(input))}`; // v14: wording checked against the inputs, figures match the pages
  const cached = await env.STORE.get(key, 'json');
  if (cached) {
    await track(request, env, tool, 'cached');
    return { ...cached, cached: true };
  }

  const c = caps(env, tool);
  const { dayKey, visKey } = counterKeys(tool, await visitorId(request));
  const used = Number((await env.STORE.get(dayKey)) || 0);
  const mine = Number((await env.STORE.get(visKey)) || 0);
  if (used >= c.daily) throw fail(429, 'Today\'s free runs have all been used. Please try again tomorrow, or look at the example result.');
  if (mine >= c.visitor) throw fail(429, `You have used your ${c.visitor} free runs for today. Please try again tomorrow.`);
  await env.STORE.put(dayKey, String(used + 1), { expirationTtl: 2 * 86400 });
  await env.STORE.put(visKey, String(mine + 1), { expirationTtl: 2 * 86400 });

  let result;
  try {
    result = await work();
  } catch (e) {
    // A failed run should not use up anyone's allowance.
    await env.STORE.put(dayKey, String(used), { expirationTtl: 2 * 86400 });
    await env.STORE.put(visKey, String(mine), { expirationTtl: 2 * 86400 });
    throw e;
  }
  result.run_at = new Date().toISOString();
  await env.STORE.put(key, JSON.stringify(result), { expirationTtl: CACHE_SECONDS });
  await track(request, env, tool, 'runs');
  return { ...result, cached: false };
}

// Daily usage stats, kept with no expiry so use can be reviewed later.
// loads: calls from a tool page (once when it opens and once after each review),
// runs: new reviews, cached: repeat reviews served from the cache,
// visitors: short hashed addresses, the same across days, so repeat visitors can be told apart.
async function track(request, env, tool, field) {
  try {
    const k = `stats:${tool}:${today()}`;
    const s = (await env.STORE.get(k, 'json')) || { loads: 0, runs: 0, cached: 0, visitors: [] };
    s[field] = (s[field] || 0) + 1;
    const v = (await sha256((request.headers.get('CF-Connecting-IP') || 'unknown') + 'stats')).slice(0, 8);
    if (!s.visitors.includes(v) && s.visitors.length < 500) s.visitors.push(v);
    await env.STORE.put(k, JSON.stringify(s));
  } catch (e) { /* stats must never break a tool */ }
}

async function claude(env, body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: env.MODEL || DEFAULTS.MODEL, ...body })
  });
  if (!res.ok) {
    const detail = await res.text();
    console.log('Anthropic error', res.status, detail.slice(0, 300));
    throw fail(502, 'The AI service did not respond properly. Please try again later.');
  }
  return res.json();
}

const textOf = (msg) => (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

// ---------- tool 1: AI search visibility ----------

const COUNTRIES = ['United Kingdom', 'Ireland', 'United States', 'Germany', 'France', 'Netherlands', 'Australia', 'Canada', 'Global'];
const REPEATS_NO_WEB = 3;
const REPEATS_WEB = 1;

const clip = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function cleanVisibilityInput(raw) {
  const brand = clip(raw.brand, 60);
  const category = clip(raw.category, 80);
  const country = COUNTRIES.includes(raw.country) ? raw.country : 'United Kingdom';
  const competitors = (Array.isArray(raw.competitors) ? raw.competitors : [])
    .map((c) => clip(c, 60)).filter(Boolean).slice(0, 4);
  if (brand.length < 2) return { error: 'Enter your brand name.' };
  if (category.length < 3) return { error: 'Enter the category you sell in, for example "CRM platform".' };
  return { brand, category, country, competitors };
}

const placeName = (c) => (['United Kingdom', 'United States', 'Netherlands'].includes(c) ? `the ${c}` : c);
// A category typed as "CRM category" or "the payroll market" reads better without the extra word.
const bareCategory = (c) => c.replace(/^(the|a|an)\s+/i, '').replace(/\s+(category|market|sector|space|industry)$/i, '').trim() || c;

// Fallback wording, used only if Claude's wording fails its checks. It reads correctly for plural
// categories ("law firms"), singular ones ("CRM platform") and mass nouns ("accounting software").
function questionsFor({ category, country, competitors }) {
  const cat = bareCategory(category);
  const where = country === 'Global' ? '' : ` in ${placeName(country)}`;
  const plural = /[^s]s$/i.test(cat) && !/(ics|ss|us|is|ous)$/i.test(cat);
  const qs = plural ? [
    `What are the best ${cat}${where}?`,
    `Which ${cat}${where} would you recommend for a mid-sized company, and why?`,
    `I am comparing ${cat}${where}. Which ones should be on my shortlist?`,
    `Who are the leading ${cat}${where} for enterprise customers?`
  ] : [
    `What are the best ${cat} options${where}?`,
    `Which ${cat} provider would you recommend${where} for a mid-sized company, and why?`,
    `I am comparing ${cat} options${where}. Which companies should be on my shortlist?`,
    `Who are the leading ${cat} providers${where} for enterprise customers?`
  ];
  qs.push(competitors.length
    ? `What are the best alternatives to ${competitors[0]}${where}?`
    : plural ? `Which ${cat}${where} have the strongest reputation with customers?` : `Which ${cat} providers${where} have the strongest reputation with customers?`);
  return qs;
}

// Claude words the five buyer questions for this exact category, so they read naturally for any input.
// The checks keep the questions fair: no brand of the visitor's, the right place, and the competitor only where it belongs.
async function writeQuestions(env, input) {
  const base = questionsFor(input);
  const cat = bareCategory(input.category);
  const where = input.country === 'Global' ? 'no particular country' : placeName(input.country);
  try {
    const msg = await claude(env, {
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `A buyer is researching "${cat}" (what they typed as a category; it may be a product, a service or a kind of company) for ${where}. Write five questions they would ask an AI assistant, one for each purpose below, in natural British English that is grammatical for this exact category (for example "the best accounting software", "the best payroll providers", "the best CRM platforms").
1. Ask for the best options.
2. Ask which one to recommend for a mid-sized company, and why.
3. Say they are comparing options and ask which companies to shortlist.
4. Ask who the leading providers are for enterprise customers.
5. ${input.competitors.length ? `Ask for the best alternatives to ${input.competitors[0]}.` : 'Ask which providers have the strongest reputation with customers.'}
${input.country === 'Global' ? 'Do not name a country.' : `Mention ${placeName(input.country)} in every question.`} Do not name any company${input.competitors.length ? ` except ${input.competitors[0]} in question 5` : ''}. Write without contractions. Each question ends with a question mark. Reply only with JSON: {"questions": ["...", "...", "...", "...", "..."]}`
      }]
    });
    const qs = parseJsonLoose(textOf(msg)).questions;
    const aliases = { 'United Kingdom': [/\b(united kingdom|britain)\b/i, /\bUK\b/], 'United States': [/\b(united states|america)\b/i, /\bUSA?\b/], 'Netherlands': [/\b(netherlands|dutch)\b/i] };
    const country = input.country === 'Global' ? null : aliases[input.country] || [new RegExp(`\\b${input.country}\\b`, 'i')];
    const names = [input.brand, ...input.competitors.slice(1)].map((n) => n.toLowerCase());
    const ok = Array.isArray(qs) && qs.length === 5 && qs.every((q, k) => typeof q === 'string'
      && q.length >= 15 && q.length <= 220 && /\?$/.test(q.trim())
      && (!country || country.some((re) => re.test(q)))
      && !names.some((n) => firstIndex(q, n) >= 0)
      && (k < 4 || !input.competitors.length || firstIndex(q, input.competitors[0]) >= 0)
      && (k === 4 || !input.competitors.length || firstIndex(q, input.competitors[0]) < 0));
    if (ok) return qs.map((q) => clip(q, 220));
    console.log('Questions rejected', JSON.stringify(qs).slice(0, 400));
  } catch (e) {
    if (e.publicMessage) throw e;
  }
  return base;
}

function namePattern(name) {
  const core = name.replace(/\b(ltd|limited|plc|inc|llc|gmbh|group)\.?$/i, '').trim();
  const esc = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  return new RegExp(`(^|[^a-z0-9])${esc}(?![a-z0-9])`, 'i');
}

function firstIndex(text, name) {
  const m = namePattern(name).exec(text);
  return m ? m.index + m[1].length : -1;
}

// The whole sentence around a brand mention, cleaned of Markdown, without cutting words or splitting at "Inc." or "4.5".
function sentenceAround(text, idx) {
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  let lineEnd = text.indexOf('\n', idx);
  if (lineEnd < 0) lineEnd = text.length;
  let line = text.slice(lineStart, lineEnd);
  let at = idx - lineStart;
  if (/^\s*\|.*\|\s*$/.test(line)) {
    // A table row: read it as a list of its cells.
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    const joined = cells.join(', ');
    at = Math.max(0, joined.toLowerCase().indexOf(line.slice(at, at + 4).toLowerCase()));
    line = joined;
  }
  // Sentence breaks: . ! or ? followed by a space and a capital letter, not after a short abbreviation or a single letter.
  const breaks = [];
  const re = /[.!?](?=\s+["'(*_]*[A-Z0-9])/g;
  let m;
  while ((m = re.exec(line))) {
    const before = line.slice(Math.max(0, m.index - 4), m.index);
    if (/(^|\s)(inc|ltd|co|corp|vs|etc|e\.g|i\.e|no|st|mr|ms|dr)$/i.test(before) || /(^|\s)[A-Z]$/.test(before)) continue;
    breaks.push(m.index + 1);
  }
  const start = Math.max(0, ...breaks.filter((b) => b <= at));
  const end = breaks.find((b) => b > at) || line.length;
  let s = line.slice(start, end)
    .replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, '')        // list markers
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')         // links
    .replace(/[*_`#>|]+/g, '')                        // emphasis, headings, table bars
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 260) {
    // Keep the part around the brand, cut on word boundaries and show the cut.
    const pos = Math.max(0, s.toLowerCase().indexOf(line.slice(at, at + 3).toLowerCase()));
    let from = Math.max(0, pos - 100);
    from = from ? s.indexOf(' ', from) + 1 : 0;
    let to = Math.min(s.length, from + 250);
    if (to < s.length) to = s.lastIndexOf(' ', to);
    s = (from ? '…' : '') + s.slice(from, to).replace(/[,;:\s]+$/, '') + (to < s.length ? '…' : '');
  }
  return s;
}

function scoreAnswers(answers, names, brand) {
  const stats = Object.fromEntries(names.map((n) => [n, { mentions: 0, positions: [] }]));
  const quotes = [];
  for (const a of answers) {
    const found = names.map((n) => ({ n, i: firstIndex(a.text, n) })).filter((x) => x.i >= 0).sort((x, y) => x.i - y.i);
    found.forEach((f, rank) => { stats[f.n].mentions += 1; stats[f.n].positions.push(rank + 1); });
    const own = found.find((f) => f.n === brand);
    if (own && quotes.length < 3) {
      // Use the first mention that sits in a real sentence, not a bare heading such as "**FreeAgent**".
      const re = new RegExp(namePattern(brand).source, 'gi');
      let m, text = '';
      while ((m = re.exec(a.text))) {
        const t = sentenceAround(a.text, m.index + m[1].length);
        if (t.replace(/[^a-z]/gi, '').length - brand.replace(/[^a-z]/gi, '').length >= 20) { text = t; break; }
      }
      if (text && !/[.!?…)]$/.test(text)) text += '…';
      if (text && !quotes.some((q) => q.text === text)) quotes.push({ question: a.question, text });
    }
  }
  const total = answers.length;
  const allMentions = names.reduce((s, n) => s + stats[n].mentions, 0) || 1;
  const rows = names.map((n) => ({
    name: n,
    is_you: n === brand,
    mentions: stats[n].mentions,
    mention_rate: total ? Math.round((stats[n].mentions / total) * 100) : 0,
    share_of_voice: Math.round((stats[n].mentions / allMentions) * 100),
    avg_position: stats[n].positions.length ? Math.round((stats[n].positions.reduce((s, p) => s + p, 0) / stats[n].positions.length) * 10) / 10 : null
  })).sort((x, y) => y.mentions - x.mentions);
  return { answers: total, rows, quotes };
}

async function ask(env, question, country, web) {
  const body = {
    max_tokens: 1600,
    messages: [{ role: 'user', content: question }]
  };
  if (web) {
    body.tools = [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 1,
      ...(country !== 'Global' ? { user_location: { type: 'approximate', country: countryCode(country) } } : {})
    }];
  }
  const msg = await claude(env, body);
  const sources = [];
  for (const b of msg.content || []) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r.url) sources.push(r.url);
    }
  }
  return { question, text: textOf(msg), sources };
}

function countryCode(c) {
  return { 'United Kingdom': 'GB', 'Ireland': 'IE', 'United States': 'US', 'Germany': 'DE', 'France': 'FR', 'Netherlands': 'NL', 'Australia': 'AU', 'Canada': 'CA' }[c];
}

async function discoverBrands(env, answers, known, category) {
  const corpus = answers.map((a) => a.text).join('\n---\n').slice(0, 8000);
  const msg = await claude(env, {
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `Below are several AI answers to questions about ${bareCategory(category)}.\n\n${corpus}\n\nList every company, product or brand that these answers put forward as an option for ${bareCategory(category)}, except these: ${known.join(', ') || 'none'}. Leave out review sites, analyst firms, publications, people, generic terms and product features. Use the names exactly as written. Reply only with JSON: {"brands": ["..."]}`
    }]
  });
  try {
    const t = (textOf(msg).match(/\{[\s\S]*\}/) || ['{}'])[0];
    const list = JSON.parse(t).brands;
    return Array.isArray(list) ? [...new Set(list.map((b) => clip(b, 60)).filter((b) => b && firstIndex(corpus, b) >= 0))].slice(0, 12) : [];
  } catch {
    return [];
  }
}

function domainsOf(answers) {
  const count = {};
  for (const a of answers) for (const u of a.sources) {
    try { const d = new URL(u).hostname.replace(/^www\./, ''); count[d] = (count[d] || 0) + 1; } catch {}
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([domain, times]) => ({ domain, times }));
}

async function visibility(input, env) {
  const questions = await writeQuestions(env, input);
  const jobs = [];
  for (const q of questions) {
    for (let i = 0; i < REPEATS_NO_WEB; i++) jobs.push({ q, web: false });
    for (let i = 0; i < REPEATS_WEB; i++) jobs.push({ q, web: true });
  }
  const results = await inBatches(jobs, 5, async (j) => ({ web: j.web, ...(await ask(env, j.q, input.country, j.web)) }));
  const noWeb = results.filter((r) => !r.web);
  const web = results.filter((r) => r.web);

  const known = [input.brand, ...input.competitors];
  const discovered = await discoverBrands(env, results, known, input.category);
  // One row per brand: drop a discovered name that is another listed brand plus a product word ("Sage Payroll"
  // when "Sage" is listed) or the same name written differently ("Lohn & Gehalt", "Lohn+Gehalt").
  const key = (n) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = [...known];
  for (const d of [...discovered].sort((x, y) => x.length - y.length)) {
    if (names.some((k) => key(k) === key(d) || firstIndex(d, k) >= 0)) continue;
    names.push(d);
  }

  const model = scoreAnswers(noWeb, names, input.brand);
  const live = scoreAnswers(web, names, input.brand);
  const trim = (r) => r.rows.filter((row) => row.mentions > 0 || known.includes(row.name)).slice(0, 10);

  return {
    tool: 'visibility',
    input,
    model: env.MODEL || DEFAULTS.MODEL,
    questions,
    repeats: { no_web: REPEATS_NO_WEB, web: REPEATS_WEB },
    modes: {
      model_knowledge: { answers: model.answers, rows: trim(model), quotes: model.quotes },
      live_web: { answers: live.answers, rows: trim(live), quotes: live.quotes, sources: domainsOf(web) }
    },
    discovered
  };
}


// ---------- tool 2: pipeline planner ----------
// The numbers are calculated here with fixed formulas. Claude only explains them.

const CURRENCIES = ['GBP', 'USD', 'EUR'];
const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

// Two ways to describe the funnel: every stage, or just the basics.
const PLAN_STAGES = {
  detailed: [
    { key: 'lead_to_mql', label: 'Lead to MQL' },
    { key: 'mql_to_sql', label: 'MQL to SQL' },
    { key: 'sql_to_opp', label: 'SQL to opportunity' },
    { key: 'win_rate', label: 'Opportunity to won' }
  ],
  simple: [
    { key: 'lead_to_opp', label: 'Lead to opportunity' },
    { key: 'win_rate', label: 'Opportunity to won' }
  ]
};

function cleanPlanInput(raw) {
  const mode = raw.mode === 'simple' ? 'simple' : 'detailed';
  const bad = { error: 'Please check the numbers. Each one must be a positive figure, and rates must be between 0.1 and 100.' };
  // The detailed input keeps its original shape, so saved results still match.
  const out = { currency: CURRENCIES.includes(raw.currency) ? raw.currency : 'GBP' };
  if (mode === 'simple') out.mode = 'simple';
  const fields = [['target', 1000, 1e10], ['deal_size', 100, 1e8], ['marketing_share', 1, 100],
    ...PLAN_STAGES[mode].map((s) => [s.key, 0.1, 100]), ['cycle_months', 1, 36]];
  for (const [k, min, max] of fields) {
    const n = num(raw[k], min, max);
    if (n === null) return bad;
    out[k] = n;
  }
  const channels = (Array.isArray(raw.channels) ? raw.channels : []).slice(0, 6).map((c) => ({
    name: clip(c && c.name, 40), share: num(c && c.share, 0, 100), cpl: num(c && c.cpl, 0, 1e6)
  })).filter((c) => c.name && c.share !== null && c.cpl !== null && c.share > 0);
  const total = channels.reduce((s, c) => s + c.share, 0);
  if (!channels.length || Math.abs(total - 100) > 0.5) return { error: 'The channel shares must add up to 100%.' };
  out.channels = channels;
  return out;
}

// Who controls each stage, as shown on the page.
const PLAN_OWNERS = { lead_to_mql: 'Marketing', mql_to_sql: 'Marketing and sales', sql_to_opp: 'Sales', lead_to_opp: 'Marketing and sales', win_rate: 'Sales' };

function planMaths(i) {
  const r = (x) => Math.round(x);
  const stages = PLAN_STAGES[i.mode === 'simple' ? 'simple' : 'detailed'].map((s) => ({ ...s, rate: i[s.key] }));
  const mktRevenue = i.target * (i.marketing_share / 100);
  const won = mktRevenue / i.deal_size;
  // Work back up the funnel from won deals to leads.
  const counts = [won];
  for (let k = stages.length - 1; k >= 0; k--) counts.unshift(counts[0] / (stages[k].rate / 100));
  const leads = counts[0];
  const opps = counts[counts.length - 2];
  const cpl = i.channels.reduce((s, c) => s + (c.share / 100) * c.cpl, 0);
  const budget = leads * cpl;
  // Same rule as the page's table: raise one stage at a time by 5 points, or 1 point under 10%,
  // and list the stages with the biggest budget saving first.
  const whatIf = stages.map((s) => {
    const to = Math.min(100, s.rate + (s.rate < 10 ? 1 : 5));
    return { stage: s.label, controlled_by: PLAN_OWNERS[s.key], from: s.rate, to, budget_saving: r(budget * (1 - s.rate / to)) };
  }).sort((a, b) => b.budget_saving - a.budget_saving);
  const spendPct = (budget / mktRevenue) * 100;
  const leadToWon = (won / leads) * 100;
  const planCheck = won < 1 ? 'below one deal'
    : leadToWon > 10 || i.win_rate > 60 ? 'rates look too high'
    : spendPct > 100 ? 'spends more than it brings in'
    : spendPct > 40 ? 'a stretch'
    : spendPct > 20 ? 'workable' : 'comfortable';
  const names = i.mode === 'simple' ? ['leads', 'opportunities', 'won'] : ['leads', 'mqls', 'sqls', 'opportunities', 'won'];
  const annual = { marketing_revenue: r(mktRevenue) };
  const monthly = {};
  // Rounded as the page shows them: whole numbers a year, and a month to one decimal place under 10.
  names.forEach((n, k) => { annual[n] = r(counts[k]); const m = counts[k] / 12; monthly[n] = m < 10 ? Math.round(m * 10) / 10 : r(m); });
  return {
    funnel_detail: i.mode === 'simple' ? 'basics only: lead to opportunity and win rate' : 'every stage',
    annual,
    monthly,
    blended_cpl: r(cpl),
    budget: r(budget),
    budget_per_month: r(budget / 12),
    cost_per_won: r(budget / won),
    budget_to_revenue_pct: +((budget / mktRevenue) * 100).toFixed(1),
    pipeline_needed: r(opps * i.deal_size),
    lead_to_won_pct: +((won / leads) * 100).toFixed(2),
    plan_check: planCheck,
    budget_covers: 'media and programme spend only, excluding salaries and tools',
    what_if: whatIf,
    start_with: whatIf[0].budget_saving > 0 ? whatIf[0].stage : null,
    cpl_tenth_lower_saving: r(budget * 0.1),
    channel_budget: i.channels.map((c) => ({ name: c.name, leads: Math.ceil(leads * c.share / 100), budget: r(leads * (c.share / 100) * c.cpl) }))
  };
}

// The figures exactly as the planner page shows them, so the review can quote them word for word.
// They are worked out from the unrounded numbers with the page's own formatting, so they match it to the last digit.
function planFigures(i, m) {
  const money = moneyFmt(i.currency);
  const pct = (n) => `${+(+n).toFixed(2)}%`;
  const stages = PLAN_STAGES[i.mode === 'simple' ? 'simple' : 'detailed'];
  const next = { lead_to_mql: 'MQLs', mql_to_sql: 'SQLs', sql_to_opp: 'opportunities', lead_to_opp: 'opportunities', win_rate: 'won deals' };
  const mkt = i.target * i.marketing_share / 100;
  const won = mkt / i.deal_size;
  const counts = [won];
  for (let k = stages.length - 1; k >= 0; k--) counts.unshift(counts[0] / (i[stages[k].key] / 100));
  const leads = counts[0];
  const opps = counts[counts.length - 2];
  const cpl = i.channels.reduce((s, c) => s + (c.share / 100) * c.cpl, 0);
  const budget = leads * cpl;
  const perMonth = (n) => (n / 12 < 10 ? (n / 12).toFixed(1) : intFmt(n / 12));
  return {
    your_inputs: {
      currency: i.currency,
      revenue_target: money(i.target),
      share_from_marketing: pct(i.marketing_share),
      average_deal_size: money(i.deal_size),
      sales_cycle: `${i.cycle_months} month${i.cycle_months === 1 ? '' : 's'}`,
      sales_cycle_before_a_noun: `${i.cycle_months}-month`,
      stage_rates: stages.map((s) => ({ stage: s.label, rate: pct(i[s.key]) })),
      channels: i.channels.map((c) => ({ name: c.name, share: pct(c.share), cost_per_lead: money(c.cpl) }))
    },
    figures: {
      revenue_marketing_must_source: money(mkt),
      leads_needed_a_month: leads / 12 < 10 ? (leads / 12).toFixed(1) : intFmt(leads / 12),
      leads_needed_a_year: intFmt(leads),
      funnel: stages.map((s, k) => ({ stage: next[s.key], a_month: perMonth(counts[k + 1]), a_year: intFmt(counts[k + 1]) })),
      marketing_budget_a_year: money(budget),
      marketing_budget_a_month: money(budget / 12),
      pipeline_to_create: money(opps * i.deal_size),
      opportunities_a_year: intFmt(opps),
      marketing_cost_per_won_deal: money(budget / won),
      budget_as_share_of_revenue_sourced: `${(budget / mkt * 100).toFixed(1)}%`,
      average_cost_per_lead: money(cpl),
      saving_from_a_tenth_lower_cost_per_lead: money(budget * 0.1),
      what_if: stages.map((s) => {
        const from = i[s.key];
        const to = Math.min(100, from + (from < 10 ? 1 : 5));
        return { stage: s.label, controlled_by: PLAN_OWNERS[s.key], from: pct(from), to: from >= 100 ? 'already at 100%' : pct(to), saving: budget * (1 - from / to) };
      }).sort((a, b) => b.saving - a.saving).map((w) => ({ ...w, saving: undefined, budget_saving: money(w.saving) })),
      channels: i.channels.map((c) => ({ name: c.name, leads_a_year: intFmt(Math.ceil(leads * c.share / 100)), budget_a_year: money(leads * (c.share / 100) * c.cpl) })),
      plan_check: m.plan_check,
      plan_check_thresholds: ['20%', '40%', '100%', '10%', '60%']
    }
  };
}

// Read the first complete JSON object in a reply, ignoring any text around it.
function parseJsonLoose(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON');
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* try a shorter slice */ }
  }
  throw new Error('no JSON');
}

// ---------- review wording checks ----------
// Claude writes the words; every number in a review must be one the page already shows.
// Each review is checked, and any number that is not among the figures sends it back once for a rewrite.
const numbersIn = (text) => (String(text || '').match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) || []).map((s) => Number(s.replace(/,/g, '')));

function allowedNumbers(...sources) {
  const set = new Set();
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'number') { if (Number.isFinite(v)) set.add(v); return; }
    if (typeof v === 'string') { numbersIn(v).forEach((n) => set.add(n)); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  sources.forEach(walk);
  for (let n = 0; n <= 10; n++) set.add(n); // small counts, which may be written as figures
  set.add(12);                               // "12 months", the year the page talks about
  return set;
}

const reviewTexts = (review) => Object.values(review).flatMap((v) => (Array.isArray(v) ? v : [v]));
const unknownNumbers = (texts, allowed) => [...new Set(texts.flatMap((t) => numbersIn(t)).filter((n) => !allowed.has(n)))];
const sentencesOf = (t) => String(t).split(/(?<=[.!?])\s+(?=[A-Z])/);

// shape: { field: max length } for text fields, { field: [max items, max length] } for lists.
async function writeReview(env, prompt, shape, allowed, label) {
  const read = (text) => {
    try {
      const j = parseJsonLoose(text);
      const out = {};
      for (const [k, spec] of Object.entries(shape)) {
        out[k] = Array.isArray(spec)
          ? (Array.isArray(j[k]) ? j[k] : []).map((x) => clip(x, spec[1])).filter(Boolean).slice(0, spec[0])
          : clip(j[k], spec);
      }
      return out.summary ? out : null;
    } catch { return null; }
  };
  const messages = [{ role: 'user', content: prompt }];
  let best = null, bestBad = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await claude(env, { max_tokens: 3000, messages });
    const text = textOf(msg);
    const review = read(text);
    if (!review) { console.log(label + ' review unreadable', msg.stop_reason, text.slice(0, 300)); continue; }
    const bad = unknownNumbers(reviewTexts(review), allowed);
    if (!best || bad.length < bestBad.length) { best = review; bestBad = bad; }
    if (!bad.length) break;
    console.log(label + ' review used numbers not on the page', bad.join(' '));
    messages.push({ role: 'assistant', content: text }, {
      role: 'user',
      content: `These numbers in your review are not among the figures provided: ${bad.join(', ')}. Rewrite the whole review so that every number is copied exactly from "figures" or "your_inputs". Where a point needs a number that is not there, make the point without a number. Reply only with the JSON.`
    });
  }
  if (!best) throw fail(502, 'The AI review could not be written. Please try again.');
  if (bestBad.length) {
    // Last resort: drop any sentence or list item that still carries a number the page does not show.
    const clean = (t) => sentencesOf(t).filter((s) => !unknownNumbers([s], allowed).length).join(' ');
    for (const [k, spec] of Object.entries(shape)) {
      best[k] = Array.isArray(spec) ? best[k].filter((x) => !unknownNumbers([x], allowed).length) : clean(best[k]);
    }
    if (!best.summary) throw fail(502, 'The AI review could not be written. Please try again.');
  }
  return best;
}

// Number formats that match the pages exactly.
const moneyFmt = (currency) => (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
const intFmt = (n) => Math.round(n).toLocaleString('en-GB');
const oneFmt = (n) => (n < 10 ? (Math.round(n * 10) / 10).toLocaleString('en-GB') : intFmt(n));

// Wording rules every review shares.
const WORDING_RULES = `How to write it:
- Write about this visitor's own figures and answers, whatever they are. Use their own names for things (channels, categories, countries) exactly as they typed them.
- Every number you write must be copied exactly from "figures" or "your_inputs", with its currency symbol or % sign. Do not round, convert, add up, subtract or work out any new number, share or ratio, and do not write amounts in words such as "1.2 million" or "300k". If a point needs a number that is not listed, make it without a number.
- Make every sentence grammatical for these exact figures: one customer, two customers; one month, three months; a figure of 1 takes the singular.
- Write natural, varied sentences. Do not repeat the same phrase from one sentence or item to the next.
- British English, no contractions, plain words. Never mention field names or explain how the figures or this review were worked out.
- Never put a double quotation mark inside a text value; use single quotation marks if you must quote.`;

async function plan(input, env) {
  const maths = planMaths(input);
  const facts = planFigures(input, maths);
  const prompt = `You are a demand generation leader reviewing a B2B pipeline plan that a visitor has just entered into a planner. All figures below were calculated with fixed formulas and are written exactly as the page shows them. Your job is the wording only.

What the figures mean:
- The marketing budget is media and programme spend only, excluding salaries and tools.
- plan_check is the planner's verdict from fixed rules: marketing spend under 20% of the revenue it sources is comfortable, 20% to 40% workable, 40% to 100% a stretch, and above 100% it spends more than it brings in; more than 10% of leads becoming customers, or a win rate above 60%, means the rates look too high; 'below one deal' means the revenue marketing must source is less than one average deal, so the funnel figures are fractions of a deal and only indicative; say so plainly, and suggest checking the target, the share from marketing or the deal size. Base the summary on plan_check and do not contradict it.
- Marketing is only asked to source share_from_marketing of the revenue target. The rest comes from other sources by design, so never say the plan falls short of the full target.
- what_if raises one stage at a time by 5 percentage points, or 1 point for a rate under 10%, exactly as the page's table shows, with the biggest saving first. The first row is the stage the page highlights; say who controls it (controlled_by) if you recommend it. saving_from_a_tenth_lower_cost_per_lead is what a tenth lower cost per lead would save, which marketing controls.
- If only the basics were given (two stages), do not comment on stages that were not given; you may suggest tracking them.
- Call the money still to be won 'pipeline' or 'opportunities' as suits the sentence. Use the phrase 'pipeline to create' no more than once in the whole review.
- Do not use ARR, MRR, CAC, ROI or other abbreviations; MQL and SQL are fine. Write for a CEO.

${WORDING_RULES}

${JSON.stringify(facts)}

Reply only with JSON in this form:
{"summary": "two sentences on what this plan needs and whether it is realistic, following plan_check", "constraint": "one or two sentences on the single biggest constraint on this plan, judged from plan_check, the spend and the lead volume", "risks": ["risk", "risk"], "actions": ["action", "action", "action"]}`;
  const review = await writeReview(env, prompt, { summary: 500, constraint: 500, risks: [3, 300], actions: [4, 300] }, allowedNumbers(facts), 'Plan');
  return { tool: 'plan', input, model: env.MODEL || DEFAULTS.MODEL, results: maths, review };
}

// ---------- referral revenue calculator ----------

// Referral Revenue Calculator: the formulas, shared word for word by the page and the server.
// Benchmarks come from published sources (see the page). The page shows cautious as Low,
// typical as Typical and strong as High. Low uses the low end of each range.
const REF_PRESETS = {
  cautious: { refer: 2, signup: 5, convert: 5, uplift: 0, churn_cut: 0 },
  typical: { refer: 5, signup: 15, convert: 8, uplift: 25, churn_cut: 18 },
  strong: { refer: 10, signup: 25, convert: 12, uplift: 50, churn_cut: 18 }
};
const REF_RAMP_MONTHS = 6;   // the programme builds to full strength over six months
const REF_SALES_LAG = 3;     // sales-led deals close about three months after sign-up
const REF_MAX_LIFE = 10;     // cap customer lifetime at ten years
const REF_SMALL_GROWTH = 2;  // under 2% more customers in a year is a modest addition to growth
const REF_PAYBACK_GOOD = 12; // paying back within 12 months makes a programme worth running
const REF_PAYBACK_MAX = 24;  // taking more than 24 months to pay back makes it not worth it

function refRates(i) {
  const p = REF_PRESETS[i.preset] || REF_PRESETS.typical;
  const convert = i.motion === 'sales_led' ? Math.min(100, i.win_rate * (1 + p.uplift / 100)) : p.convert;
  return { refer: p.refer, signup: p.signup, convert, churn_cut: p.churn_cut, uplift: p.uplift };
}

// Run twelve months. Referred customers join the base and can refer others too.
function refRun(i, rates) {
  const lag = i.motion === 'sales_led' ? REF_SALES_LAG : 0;
  const closing = new Array(12 + lag).fill(0);
  let won = 0;
  let referrers = 0;
  let signups = 0;
  const monthly = [];
  for (let m = 1; m <= 12; m++) {
    const ramp = Math.min(1, m / REF_RAMP_MONTHS);
    const r = (i.customers + won) * (rates.refer / 100) * ramp;
    const s = r * (rates.signup / 100);
    referrers += r;
    signups += s;
    closing[m - 1 + lag] += s * (rates.convert / 100);
    won += closing[m - 1];
    monthly.push(+closing[m - 1].toFixed(2));
  }
  const later = closing.slice(12).reduce((a, b) => a + b, 0);
  return { referrers, signups, won, later, monthly };
}

function refMaths(i) {
  const r0 = (x) => Math.round(x);
  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;
  const sales = i.motion === 'sales_led';
  const rates = refRates(i);
  const run = refRun(i, rates);
  const n = run.won;
  const few = r1(n) < 1; // fewer than one customer as the page shows it, rounded to one decimal place
  const rewardCost = n * i.reward;
  const runningCost = 12 * i.monthly_cost;
  const totalCost = rewardCost + runningCost;
  const costPer = n > 0 ? totalCost / n : null;
  const growth = (n / i.customers) * 100;
  const life = (churn) => Math.min(REF_MAX_LIFE, 100 / Math.max(churn, 0.1));
  const lifeNormal = life(i.churn);
  const lifeReferred = life(i.churn * (1 - rates.churn_cut / 100));
  const per100 = (run.referrers / i.customers) * 100;

  // Payback: months of the referred customers' own revenue needed to cover the programme cost.
  const payback = !few ? r1(costPer / (i.acv / 12)) : null;
  // First-year revenue from the referred customers for each 1 of programme cost.
  const perPound = !few && totalCost > 0 ? (n * i.acv) / totalCost : null;

  // Referred customers a year needed to pay back within 12 months (and at least one customer).
  // The model is linear in the customer base, so the base needed scales directly.
  const needed = i.acv > i.reward ? Math.max(1, runningCost / (i.acv - i.reward)) : null;
  const baseNeeded = needed !== null && n > 0 ? i.customers * (needed / n) : null;

  // The verdict on the question the page asks: does the programme pay for itself, and how much does it add?
  // Paid channels are a benchmark only. Referrals sit alongside them in the channel mix.
  let verdict;
  if (few) verdict = 'too_few';
  else if (payback > REF_PAYBACK_MAX) verdict = 'not_worth_it';
  else if (payback >= REF_PAYBACK_GOOD) verdict = 'small_test';
  else if (growth < REF_SMALL_GROWTH) verdict = 'worth_running_modest';
  else verdict = 'worth_running';

  // What-if: improve one rate at a time by the same share and see the extra customers in a year.
  const levers = [
    ['refer', 'Customers who refer each month'],
    ['signup', 'Referred people who sign up'],
    sales ? ['win_rate', 'Your win rate'] : ['convert', 'Sign-ups who become paying']
  ];
  const whatIf = levers.map(([key, label]) => {
    const from = key === 'win_rate' ? i.win_rate : rates[key];
    const to = Math.min(100, from + (from < 10 ? 1 : 5)); // same rule as the page: 5 points, or 1 point under 10%
    let better;
    if (key === 'win_rate') better = { ...rates, convert: Math.min(100, to * (1 + rates.uplift / 100)) };
    else better = { ...rates, [key]: to };
    const extra = refRun(i, better).won - n;
    return { lever: label, from: r1(from), to: r1(to), extra_customers: r1(extra), extra_yearly_revenue: r0(extra * i.acv) };
  }).sort((a, b) => b.extra_yearly_revenue - a.extra_yearly_revenue);

  const warnings = [];
  if (few) warnings.push('At these numbers, referrals would bring in fewer than one new customer in a year.');
  if (i.reward > i.acv * 0.2) warnings.push('The reward is more than 20% of what a customer pays in their first year, above the usual range of 5% to 20%.');
  if (i.paid_cac < i.acv / 12) warnings.push('Your paid channel cost per customer is less than one month of what a customer pays. That is unusually low for deals of this size, so check it includes all sales and marketing costs, as it is the benchmark shown here.');
  if (per100 >= 75) warnings.push(`These benchmarks assume about ${r0(per100)} referrals a year for every 100 customers. That is rare for a business that sells to other businesses, so treat it as a best case.`);
  else if (sales && per100 >= 40) warnings.push(`These benchmarks assume about ${r0(per100)} referrals a year for every 100 customers. For a business that sells through a sales team, that is a best case.`);

  return {
    verdict,
    rates: { refer: rates.refer, signup: rates.signup, convert: r1(rates.convert), churn_cut: rates.churn_cut },
    referrers: r0(run.referrers),
    referrals_per_100_customers: r0(per100),
    signups: r1(run.signups),
    new_customers: r1(n),
    still_in_pipeline: r1(run.later),
    yearly_revenue_added: r0(n * i.acv),
    share_of_base_pct: r1(growth),
    reward_cost: r0(rewardCost),
    running_cost: r0(runningCost),
    total_cost: r0(totalCost),
    cost_per_customer: few ? null : r0(costPer),
    payback_months: payback,
    return_per_pound: perPound === null ? null : r2(perPound),
    paid_cost_same_customers: r0(n * i.paid_cac),
    paid_payback_months: r1(i.paid_cac / (i.acv / 12)),
    customers_needed_to_pay_back: needed === null ? null : r1(needed),
    customer_base_to_pay_back: baseNeeded === null ? null : r0(baseNeeded),
    reward_pct_of_acv: r1((i.reward / i.acv) * 100),
    lifetime_years_normal: r1(lifeNormal),
    lifetime_years_referred: r1(lifeReferred),
    lifetime_revenue_normal: r0(i.acv * lifeNormal),
    lifetime_revenue_referred: r0(i.acv * lifeReferred),
    monthly_new_customers: run.monthly,
    what_if: whatIf,
    warnings
  };
}

function cleanReferralInput(raw) {
  const motion = raw.motion === 'sales_led' ? 'sales_led' : 'self_serve';
  const preset = ['cautious', 'typical', 'strong'].includes(raw.preset) ? raw.preset : 'typical';
  const out = { currency: CURRENCIES.includes(raw.currency) ? raw.currency : 'GBP', motion, preset };
  const fields = [['customers', 10, 1e7], ['acv', 50, 1e8], ['paid_cac', 1, 1e8], ['reward', 0, 1e8], ['monthly_cost', 0, 1e8], ['churn', 1, 90]];
  if (motion === 'sales_led') fields.push(['win_rate', 0.1, 100]);
  for (const [k, min, max] of fields) {
    const n = num(raw[k], min, max);
    if (n === null) return { error: 'Please check the numbers. Each one must be a positive figure within a sensible range.' };
    out[k] = n;
  }
  return out;
}

// The figures exactly as the referral page shows them, so the review can quote them word for word.
function refFigures(i, m) {
  const money = moneyFmt(i.currency);
  const pct = (n) => `${+(+n).toFixed(1)}%`;
  const sales = i.motion === 'sales_led';
  const runningCost = 12 * i.monthly_cost;
  const months = (n) => (oneFmt(n) === '0' ? 'less than a month' : `${oneFmt(n)} month${oneFmt(n) === '1' ? '' : 's'}`);
  return {
    your_inputs: {
      currency: i.currency,
      how_customers_buy: sales ? 'through a sales team' : 'they sign up themselves',
      assumptions: { cautious: 'Cautious', typical: 'Typical', strong: 'Strong' }[i.preset],
      paying_customers_today: intFmt(i.customers),
      yearly_value_per_customer: money(i.acv),
      paid_channel_cost_per_customer: money(i.paid_cac),
      reward_per_referred_customer: money(i.reward),
      running_cost_a_month: money(i.monthly_cost),
      customers_lost_a_year: pct(i.churn),
      ...(sales ? { win_rate: pct(i.win_rate) } : {})
    },
    figures: {
      verdict: m.verdict,
      new_customers_in_a_year: oneFmt(m.new_customers),
      growth_on_todays_base: pct(m.share_of_base_pct),
      yearly_revenue_added: money(m.yearly_revenue_added),
      referrals_made: intFmt(m.referrers),
      referrals_a_year_per_100_customers: intFmt(m.referrals_per_100_customers),
      people_who_sign_up: oneFmt(m.signups),
      sign_up_rate: pct(m.rates.signup),
      become_paying_rate: pct(m.rates.convert),
      customers_who_refer_each_month: pct(m.rates.refer),
      ...(sales ? { still_in_pipeline_at_year_end: oneFmt(m.still_in_pipeline) === '0' ? 'none' : oneFmt(m.still_in_pipeline) } : {}),
      reward_cost: money(m.reward_cost),
      running_cost_a_year: money(runningCost),
      programme_cost: money(m.total_cost),
      cost_per_referred_customer: m.cost_per_customer === null ? 'none yet' : money(m.cost_per_customer),
      pays_back_in: m.payback_months === null ? 'does not pay back' : months(m.payback_months),
      paid_channels_payback: months(m.paid_payback_months),
      first_year_revenue_per_1_of_cost: m.return_per_pound === null ? 'none' : m.return_per_pound.toFixed(2),
      referred_customers_a_year_needed_to_pay_back_in_12_months: m.customers_needed_to_pay_back === null ? 'not possible, as the reward is more than a year of revenue' : oneFmt(m.customers_needed_to_pay_back),
      customer_base_needed_to_pay_back_in_12_months: m.customer_base_to_pay_back === null ? 'not known' : intFmt(m.customer_base_to_pay_back),
      reward_as_share_of_first_year_value: pct(m.reward_pct_of_acv),
      lifetime_value_typical_customer: money(m.lifetime_revenue_normal),
      lifetime_value_referred_customer: money(m.lifetime_revenue_referred),
      referred_customers_cancel_less_often_by: m.rates.churn_cut ? `${m.rates.churn_cut}%` : 'not assumed',
      what_if: m.what_if.map((w) => ({ lever: w.lever, from: pct(w.from), to: pct(w.to), extra_customers_in_a_year: w.extra_yearly_revenue > 0 && oneFmt(w.extra_customers) === '0' ? 'under 0.1' : oneFmt(w.extra_customers), extra_yearly_revenue: money(w.extra_yearly_revenue) })),
      warnings: m.warnings,
      verdict_thresholds: ['12 months', '24 months', '2%']
    }
  };
}

async function referral(input, env) {
  const maths = refMaths(input);
  const facts = refFigures(input, maths);
  const prompt = `You are a B2B SaaS growth lead advising whether a customer referral programme is worth running alongside a company's existing channels. A visitor has just entered their own numbers. All figures below were calculated with fixed formulas from those numbers and the ${facts.your_inputs.assumptions} benchmarks (the page offers Cautious, Typical and Strong), and are written exactly as the page shows them. Your job is the wording only.

What the figures mean:
- verdict is the page's answer, based on payback, the months of the referred customers' own revenue needed to cover the rewards and running cost. too_few: fewer than one new customer in a year, too few customers for referrals to pay. not_worth_it: pays back in more than 24 months. small_test: pays back in 12 to 24 months, worth a small test first. worth_running_modest: pays back within 12 months but adds under 2% more customers in a year, worth running as a modest addition to growth. worth_running: pays back within 12 months and adds 2% or more. Start from that verdict and do not contradict it, though you may be more cautious.
- Referrals add to the customers won through other channels rather than replacing them. The paid channel cost is a benchmark within the channel mix, not an alternative, so never judge the programme on whether it is cheaper than paid channels and never describe a saving against them.
- what_if shows the effect of improving one number by 5 percentage points (1 point for rates under 10%), exactly as the page's table shows, with the biggest effect first. Name the first one and quote its figures as given.
- If warnings say the benchmarks are a best case, or that the paid channel cost looks low, mention it.
- Be honest: if the numbers are small or the payback is long, say so plainly and explain what would need to change.
- Say "a year" or "yearly revenue", never ARR, MRR, CAC or LTV. Write for a founder.

${WORDING_RULES}

${JSON.stringify(facts)}

Reply only with JSON in this form:
{"summary": "two sentences on whether a referral programme looks worth running for this company and why", "lever": "one or two sentences on the number that matters most, using the first what_if row", "risks": ["risk", "risk"], "actions": ["action", "action", "action"]}`;
  const review = await writeReview(env, prompt, { summary: 500, lever: 500, risks: [3, 300], actions: [4, 300] }, allowedNumbers(facts), 'Referral');
  return { tool: 'referral', input, model: env.MODEL || DEFAULTS.MODEL, results: maths, review };
}

// ---------- global hiring planner ----------

// Global Hiring Planner: the formulas, shared word for word by the page and the server.
// Employer contribution rules are 2026 figures from government sources and the big accounting firms' tax guides.
// Setup and running costs are typical estimates from local advisers; users can replace them with real quotes.
const clampTo = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const ROUTE_COUNTRIES = {
  uk: {
    name: 'United Kingdom', currency: 'GBP', english: true, salary: 60000,
    fee: 475, payroll: 40, setup: 1500, running: 1000, setup_months: 1.5, setup_range: '2 to 6 weeks', entity: 'private limited company (Ltd)',
    employer: (s) => 0.15 * Math.max(0, s - 5000) + 0.03 * clampTo(s - 6240, 0, 44030),
    employer_text: 'National Insurance of 15% above £5,000 a year, and at least 3% pension on earnings between £6,240 and £50,270',
    notes: ['No minimum share capital. A UK subsidiary of a larger group usually needs an audit.'],
    eor: 'Employer of record is lawful in the UK. If people work under your direction, they are entitled to the same pay and conditions as your own staff after 12 weeks.',
    eor_limit: null
  },
  ie: {
    name: 'Ireland', currency: 'EUR', english: true, salary: 60000,
    fee: 515, payroll: 45, setup: 3000, running: 1200, setup_months: 2.5, setup_range: '6 to 10 weeks', entity: 'private company limited by shares (LTD)',
    employer: (s) => s * (s / 52 > 552 ? 0.1125 : 0.09) + 0.015 * Math.min(s, 80000),
    employer_text: 'PRSI of 11.25% on all pay above €552 a week (9% below), and 1.5% auto-enrolment pension up to €80,000',
    notes: ['The company needs a director living in the European Economic Area, or a bond of about €25,000 instead.'],
    eor: 'A 2026 Workplace Relations Commission decision treated an employer of record as an employment agency, which needs a licence in Ireland. Check that the provider holds one.',
    eor_limit: null
  },
  de: {
    name: 'Germany', currency: 'EUR', english: false, salary: 70000,
    fee: 515, payroll: 45, setup: 5000, running: 2000, setup_months: 2.5, setup_range: '6 to 12 weeks', entity: 'GmbH',
    employer: (s) => 0.112 * Math.min(s, 101400) + 0.1055 * Math.min(s, 69750) + 0.011 * s + 0.021 * Math.min(s, 101400),
    employer_text: 'pension, unemployment, health, care and accident insurance and the small-employer sick pay levy, about 25% of pay, falling above the ceilings of €69,750 and €101,400',
    notes: ['A GmbH needs €25,000 share capital, with €12,500 paid in before registration.'],
    eor: 'In Germany an employer of record must hold a labour leasing licence, and the same person can usually be placed with you for at most 18 months.',
    eor_limit: 18, limit_text: 'German law limits each person to 18 months placed with you'
  },
  fr: {
    name: 'France', currency: 'EUR', english: false, salary: 60000,
    fee: 515, payroll: 45, setup: 4000, running: 2000, setup_months: 2, setup_range: '3 to 8 weeks', entity: 'SAS',
    employer: (s) => 0.235 * s + 0.1466 * Math.min(s, 48060) + 0.0425 * Math.min(s, 192240) + 0.1478 * clampTo(s - 48060, 0, 336420),
    employer_text: 'health, family, pension, unemployment and other contributions, about 40% to 45% of pay. Pay below about €65,600 gets a reduction this tool does not apply, so it slightly overstates cost there',
    notes: ['Employers must also pay at least half of a company health plan, which is not included here.'],
    eor: 'France restricts lending workers for profit. Employer of record usually runs through wage portage, which the law allows only for skilled, autonomous people on occasional or specialist assignments, not permanent roles, and for at most 36 months per assignment.',
    eor_limit: 36, limit_text: 'French law limits each wage portage assignment to 36 months',
    portage: true
  },
  nl: {
    name: 'Netherlands', currency: 'EUR', english: false, salary: 65000,
    fee: 515, payroll: 45, setup: 3500, running: 1500, setup_months: 2, setup_range: '3 to 8 weeks', entity: 'BV',
    employer: (s) => 0.08 * s + 0.1713 * Math.min(s * 1.08, 79409),
    employer_text: 'the 8% holiday allowance, plus unemployment, disability, return-to-work and health levies of about 17% up to €79,409',
    notes: ['If your sector has a mandatory pension fund, its contributions are extra.'],
    eor: 'People employed through a provider must get the same terms as your own staff. A licensing system for labour supply starts in 2027.',
    eor_limit: null
  },
  es: {
    name: 'Spain', currency: 'EUR', english: false, salary: 50000,
    fee: 515, payroll: 45, setup: 4000, running: 550, setup_months: 2, setup_range: '4 to 10 weeks', entity: 'Sociedad Limitada (SL)',
    employer: (s) => 0.3165 * Math.min(s, 61214.4) + 0.011 * Math.max(0, s - 61214.4),
    employer_text: 'social security of about 31.65% of pay up to €61,214, and about 1.1% above it. Annual gross already includes the extra payments',
    notes: ['A foreign company can also register directly as an employer in Spain without a subsidiary, which can suit one or two hires.'],
    eor: 'Spanish law has no employer of record category. Supplying workers to another company is reserved for licensed temporary work agencies, so a long-term arrangement risks being treated as illegal worker supply.',
    eor_limit: 0
  },
  pl: {
    name: 'Poland', currency: 'PLN', english: false, salary: 240000,
    fee: 2200, payroll: 185, setup: 8000, running: 1500, setup_months: 2, setup_range: '6 to 8 weeks, longer if the bank account is slow', entity: 'sp. z o.o.',
    employer: (s) => 0.2198 * Math.min(s, 282600) + 0.0572 * Math.max(0, s - 282600),
    employer_text: 'pension, disability, accident, Labour Fund and guaranteed benefits contributions, plus 1.5% workplace pension, about 22% up to PLN 282,600',
    notes: ['An sp. z o.o. needs PLN 5,000 share capital.'],
    eor: 'If an employer of record is set up as temporary agency work, the same person can be placed with you for at most 18 months in any 36. From July 2026 the labour inspectorate can also reclassify contracts as employment.',
    eor_limit: 18, limit_text: 'Polish law limits each person to 18 months in any 36 placed with you as temporary agency work'
  },
  sg: {
    name: 'Singapore', currency: 'SGD', english: true, salary: 120000,
    fee: 780, payroll: 65, setup: 3000, running: 1000, setup_months: 1, setup_range: '1 to 4 weeks', entity: 'private limited company (Pte Ltd)',
    employer: (s, i) => (i.citizens ? 0.17 * Math.min(s, 102000) : 0) + Math.min(0.0025 * s / 12, 11.25) * 12,
    employer_text: 'CPF of 17% up to S$102,000 for citizens and permanent residents, and the Skills Development Levy for everyone',
    notes: ['The company needs a resident director and a company secretary. Running costs include a nominee director.'],
    eor: 'Since 2024 an employer of record cannot sponsor work passes in Singapore, so hiring people who need an Employment Pass needs your own company.',
    eor_limit: null
  },
  au: {
    name: 'Australia', currency: 'AUD', english: true, salary: 130000,
    fee: 910, payroll: 75, setup: 5000, running: 1200, setup_months: 1.5, setup_range: '2 to 6 weeks', entity: 'proprietary company (Pty Ltd)',
    employer: (s) => 0.12 * Math.min(s, 270830),
    employer_text: 'superannuation of 12% up to A$270,830. Payroll tax (5.45% in New South Wales) only applies once total wages pass A$1.2 million, and is added for your team when it does',
    payroll_tax: { rate: 0.0545, threshold: 1200000 },
    notes: ['The company needs a director who lives in Australia. A subsidiary usually needs audited accounts unless the group is small.'],
    eor: 'Employer of record can count as labour hire. Victoria, Queensland and the ACT require labour hire licences.',
    eor_limit: null
  },
  ca: {
    name: 'Canada (Ontario)', currency: 'CAD', english: true, salary: 110000,
    fee: 825, payroll: 70, setup: 5000, running: 1200, setup_months: 1.5, setup_range: '4 to 6 weeks', entity: 'Ontario corporation',
    employer: (s) => 0.0595 * Math.max(0, Math.min(s, 74600) - 3500) + 0.04 * Math.max(0, Math.min(s, 85000) - 74600) + 0.02282 * Math.min(s, 68900),
    employer_text: 'CPP, CPP2 and employment insurance, which stop at their yearly maximums. Ontario Employer Health Tax (1.95%) only applies once total wages pass C$1 million, and is added for your team when it does',
    payroll_tax: { rate: 0.0195, threshold: 1000000 },
    notes: ['No minimum capital and no resident director needed for an Ontario corporation.'],
    eor: 'Since July 2024 temporary help agencies placing workers in Ontario need a licence. Check that the provider holds one.',
    eor_limit: null
  }
};
const ROUTE_LANGUAGE_UPLIFT = 1.3;                      // running cost uplift when you do not work in the local language
const ROUTE_MONTHS = 24;
const ROUTE_START_MONTH = { month: 1, soon: 3, later: 5 };  // month the first person starts

// Headcount each month: nobody before the first start month, then a straight line to 12 months and 24 months.
function routeHeadcount(i) {
  const start = ROUTE_START_MONTH[i.urgency] || 3;
  const out = [];
  for (let m = 1; m <= ROUTE_MONTHS; m++) {
    let h = 0;
    if (m >= start) h = m <= 12 ? i.now + (i.m12 - i.now) * ((m - start) / Math.max(1, 12 - start)) : i.m12 + (i.m24 - i.m12) * ((m - 12) / 12);
    out.push(Math.max(0, Math.round(h)));
  }
  return out;
}

const ROUTE_MATERIAL_SHARE = 0.1;  // a saving below a tenth of employer of record fees is within the margin of these estimates
const ROUTE_MATERIAL_MONTHS = 3;   // and it must also be worth at least three months of running costs

// The first month someone would pass the country's time limit on employer of record placements.
// Each person's limit runs from their own start date. When the team shrinks, the newest people are assumed to leave first.
function routeLimitMonth(heads, limit) {
  if (!limit) return null;
  const groups = [];
  let prev = 0;
  for (let m = 1; m <= heads.length; m++) {
    const h = heads[m - 1];
    if (h > prev) groups.push({ start: m, n: h - prev });
    let out = Math.max(0, prev - h);
    while (out > 0 && groups.length) {
      const g = groups[groups.length - 1];
      const k = Math.min(out, g.n);
      g.n -= k; out -= k;
      if (!g.n) groups.pop();
    }
    prev = h;
    if (groups.length && m - groups[0].start >= limit) return m;
  }
  return null;
}

function routeMaths(i) {
  const r0 = (x) => Math.round(x);
  const c = ROUTE_COUNTRIES[i.country] || ROUTE_COUNTRIES.uk;
  const heads = routeHeadcount(i);
  const start = ROUTE_START_MONTH[i.urgency] || 3;
  const hires = heads.some((h) => h > 0);
  const firstHire = heads.findIndex((h) => h > 0) + 1;
  const stays = heads[ROUTE_MONTHS - 1] > 0;          // somebody is still employed at the end of the plan

  // The cost of employing one person, which is the same on either route.
  const employer = c.employer(i.salary, i);
  const perPerson = i.salary + employer;
  const payTax = (h) => (c.payroll_tax ? c.payroll_tax.rate * Math.max(0, h * i.salary - c.payroll_tax.threshold) / 12 : 0);
  let teamCost = 0;
  for (const h of heads) teamCost += h * perPerson / 12 + payTax(h);

  // Route costs: fees, setup and running costs. Salaries and employer taxes are left out because they are the same on either route.
  const uplift = !c.english && !i.local_language;
  const running = i.running * (uplift ? ROUTE_LANGUAGE_UPLIFT : 1);
  const eorMonth = (h) => h * i.fee;
  const ownMonth = (h) => running + h * i.payroll;
  const setupMonths = Math.ceil(c.setup_months);
  const readyMonth = setupMonths + 1;              // earliest month your own company can employ people
  const passes = i.country === 'sg' && !i.citizens; // work pass holders cannot be employed through employer of record

  // Month by month, when does your own company become cheaper to run than employer of record?
  let switchMonth = null;
  for (let m = 1; m <= ROUTE_MONTHS; m++) if (heads[m - 1] > 0 && eorMonth(heads[m - 1]) >= ownMonth(heads[m - 1])) { switchMonth = m; break; }
  // Team size from which your own company costs less each month than the fees. With no running cost it does from the first person.
  const crossHead = running <= 0 ? 1 : i.fee > i.payroll ? Math.ceil(running / (i.fee - i.payroll)) : null;

  // Cost of a plan that uses employer of record until month sw, then your own company.
  // Setup is paid when it starts, and running costs begin once the company is ready.
  const planCost = (sw) => {
    const cum = [];
    let t = 0;
    for (let m = 1; m <= ROUTE_MONTHS; m++) {
      if (sw !== null && m === Math.max(1, sw - setupMonths)) t += i.setup;
      t += sw !== null && m >= sw ? ownMonth(heads[m - 1]) : (sw !== null && passes ? 0 : eorMonth(heads[m - 1]));
      cum.push(r0(t));
    }
    return cum;
  };
  const total = (sw) => planCost(sw)[ROUTE_MONTHS - 1];
  const stayEor = planCost(null);
  const eorTotal = stayEor[ROUTE_MONTHS - 1];

  // Country rules. A time limit runs from each person's start date.
  const limitMonth = hires ? routeLimitMonth(heads, c.eor_limit) : null;
  const limitHit = limitMonth !== null;
  const banned = c.eor_limit === 0 && hires;
  const portageRule = !!c.portage && hires && stays && !!i.plan_permanent; // wage portage is not allowed for permanent roles
  const clip = (sw) => (limitHit ? Math.max(readyMonth, Math.min(sw, limitMonth)) : sw);

  const direct = Math.max(readyMonth, start);       // own company ready for the first hire, no employer of record
  const financialSwitch = switchMonth === null ? null : Math.max(switchMonth, readyMonth);
  // The cheapest way to end up on your own company, among the sensible switch months.
  const options = [direct, financialSwitch].filter((x) => x !== null && x <= ROUTE_MONTHS).map(clip);
  const cheapestOwn = options.reduce((a, b) => (total(b) < total(a) ? b : a), options[0]);
  const bestSaving = hires && !passes ? eorTotal - total(cheapestOwn) : 0;
  const threshold = Math.max(ROUTE_MATERIAL_SHARE * eorTotal, ROUTE_MATERIAL_MONTHS * running);
  const financial = hires && !passes && bestSaving >= threshold;
  const smallSaving = hires && !passes && bestSaving > 0 && !financial;

  // Risks. Urgent ones need your own company as soon as it can be ready; a country time limit can be planned around.
  const urgentRisk = !!(i.risk_sales || i.risk_manager || i.risk_licences || i.risk_regulated || passes || banned);
  const risk = urgentRisk || limitHit || portageRule;
  const strategic = hires && ((!!i.plan_permanent && stays) || !!i.ma);
  const score = [financial, risk, strategic].filter(Boolean).length;

  // Pick the plan.
  let route = 'eor', sw = null;
  if (hires && (passes || score >= 2)) {
    route = 'own';
    if (urgentRisk || portageRule) sw = direct;
    else if (financial) sw = cheapestOwn;
    else sw = limitHit ? limitMonth : direct;
    sw = clip(sw);
    if (start >= readyMonth && total(direct) <= total(sw)) sw = direct;
  }
  // Employer of record with a time limit: costed as employer of record until the limit, then your own company if you keep the team.
  const bridge = route === 'eor' && limitHit;
  if (bridge) sw = Math.max(readyMonth, limitMonth);
  const plan = sw === null ? stayEor : planCost(sw);
  const setupStart = sw === null ? null : Math.max(1, sw - setupMonths);
  const usesEor = route === 'eor' || (!passes && heads.slice(0, sw - 1).some((h) => h > 0));
  let payback = null;                                // first month the plan's running total is back below employer of record
  if (sw !== null && !passes) for (let m = sw; m <= ROUTE_MONTHS; m++) if (plan[m - 1] <= stayEor[m - 1]) { payback = m; break; }

  // The headline, the main reason and the money, written for the person reading the page.
  const cur = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: c.currency, maximumFractionDigits: 0 }).format(Math.abs(n) < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 100) * 100);
  const people = (n) => (n === 1 ? '1 person' : n + ' people');
  const yours = 'your ' + c.entity;
  const same = ' Salaries and employer taxes are the same on either route.';
  const crossText = switchMonth === null ? '' : crossHead <= 1
    ? 'Even with one person, your own company costs less each month than employer of record fees.'
    : switchMonth <= firstHire
      ? 'At about ' + crossHead + ' people, which your plan has from the start, your own company costs less each month than employer of record fees.'
      : 'From about ' + crossHead + ' people (month ' + switchMonth + ') your own company costs less each month than employer of record fees.';
  let headline, reason, money, reasonIs = '';
  if (!hires) {
    headline = 'Add at least one person to see your route';
    reason = 'Your hiring plan has nobody starting in the next 24 months.';
    money = '';
  } else if (route === 'own') {
    if (passes && start < sw) headline = 'Set up your own company first. Your first hire can start in month ' + sw;
    else if (!usesEor) headline = 'Set up your own company before your first hire';
    else headline = 'Employer of record first, then your own company from month ' + sw;
    if (passes) reason = 'Your hires need work passes, and in Singapore only your own company can sponsor them.';
    else if (banned) reason = 'Spanish law reserves supplying workers to licensed temporary work agencies, so a long-term employer of record arrangement is risky in Spain.';
    else if (i.risk_sales || i.risk_manager) reason = 'Local sales staff or a country manager can create a taxable presence, even through employer of record.';
    else if (i.risk_licences) reason = 'Local licences, contracts in your own name, tenders or local data storage usually need your own company.';
    else if (i.risk_regulated) reason = 'Regulated sectors often need a local company from the start.';
    else if (portageRule) { reason = 'In France, employer of record runs through wage portage, which the law does not allow for permanent roles.'; reasonIs = 'rule'; }
    else if (!usesEor) reason = 'Your own company can be ready by month ' + sw + ', when your first person starts, so you can skip employer of record.';
    else if (financial && switchMonth !== null && sw >= switchMonth) reason = crossText + (payback ? ' Switching in month ' + sw + ' pays back the setup cost by month ' + payback + '.' : '');
    else if (limitHit) { reason = c.limit_text + ', and your first hires reach that in month ' + limitMonth + '.'; reasonIs = 'rule'; }
    else reason = i.ma ? 'You are hiring as part of an acquisition or carve-out, which usually needs your own company.' : 'You plan a long-term presence, so your own company is worth setting up as soon as it can be ready.';
    const d = plan[ROUTE_MONTHS - 1] - eorTotal;
    if (passes) money = 'Your own company costs about ' + cur(plan[ROUTE_MONTHS - 1]) + ' over 24 months in setup, running and payroll costs, salaries excluded. Employer of record is not an option for work pass holders.';
    else if (cur(d) === cur(0)) money = 'Fees, setup and running costs come to about the same as employer of record over 24 months' + (limitHit ? ', which the ' + c.eor_limit + '-month limit would not allow for everyone anyway.' : '.') + same;
    else if (d <= 0) money = 'You save about ' + cur(-d) + ' over 24 months on fees and running costs, after paying for setup' + (limitHit ? ', compared with keeping everyone on employer of record, which the ' + c.eor_limit + '-month limit would not allow anyway.' : '.') + same;
    else if (limitHit && sw === limitMonth) money = 'Fees, setup and running costs come to about ' + cur(plan[ROUTE_MONTHS - 1]) + ' over 24 months. Employer of record alone would cost about ' + cur(eorTotal) + ', but the ' + c.eor_limit + '-month limit does not allow it beyond month ' + (limitMonth - 1) + ' for your first hires.' + same;
    else money = 'Your own company costs about ' + cur(d) + ' more over 24 months in fees, setup and running costs than employer of record. That is the price of moving early to manage the risks.' + same;
  } else if (bridge) {
    headline = 'Use employer of record for up to ' + c.eor_limit + ' months per person';
    reason = c.limit_text + '. Your first hires reach it in month ' + limitMonth + ', so start setting up ' + yours + ' by month ' + setupStart + ', or plan to end the placements.';
    reasonIs = 'rule';
    money = 'Employer of record fees come to about ' + cur(stayEor[limitMonth - 2]) + ' up to month ' + (limitMonth - 1) + '. If you keep the team and move it onto ' + yours + ' in month ' + sw + ', fees, setup and running costs come to about ' + cur(plan[ROUTE_MONTHS - 1]) + ' over 24 months.' + same;
  } else {
    if (banned) {
      headline = 'Use employer of record only for a short, temporary need';
      reason = 'Spanish law has no employer of record category, so a long-term arrangement risks being treated as illegal worker supply. For anything longer, register as an employer in Spain or set up ' + yours + '.';
      reasonIs = 'rule';
    } else if (financial) {
      headline = 'Employer of record for now';
      reason = 'Your own company would save about ' + cur(bestSaving) + ' over 24 months, but with no risks reported and no long-term presence planned, it is not worth committing to yet.';
    } else {
      headline = i.risk_sales || i.risk_manager ? 'Employer of record for now, but get tax advice first' : 'Stay on employer of record';
      if (smallSaving) reason = 'Your own company would save only about ' + cur(bestSaving) + ' over 24 months, not worth the setup and admin.';
      else if (switchMonth !== null) reason = 'Your own company only costs less each month from about ' + people(crossHead) + ', and within 24 months it would not pay back its setup cost.';
      else reason = 'At this size, your own company would cost more to run each month than employer of record fees for the whole 24 months.';
    }
    const fees = ' Employer of record fees come to about ' + cur(eorTotal) + ' over 24 months.';
    if (bestSaving > 0) money = (financial ? 'Setting up your own company could save about ' : 'Your own company would save only about ') + cur(bestSaving) + ' over 24 months on fees and running costs, after paying for setup' + (financial ? ', but only if you are sure you are staying.' : '.') + fees + same;
    else if (cur(bestSaving) === cur(0)) money = 'Employer of record fees come to about ' + cur(eorTotal) + ' over 24 months, about the same as your own company would cost in setup, running and payroll costs.' + same;
    else money = 'Employer of record fees come to about ' + cur(eorTotal) + ' over 24 months. Your own company would cost about ' + cur(eorTotal - bestSaving) + ' in setup, running and payroll costs, so staying saves about ' + cur(-bestSaving) + '.' + same;
  }

  // Notes. Each has a priority; the answer card shows the three that matter most.
  const all = [];
  const add = (p, text, rule) => all.push({ p, text, rule: !!rule });
  // Country rules first.
  if (passes && reasonIs !== 'rule') add(1, 'Employer of record is not an option for work pass holders in Singapore.', true);
  if (banned && route === 'own') add(1, 'Spanish law has no employer of record category, so use it only for a short, temporary need.', true);
  if (limitHit && reasonIs !== 'rule') add(1, c.limit_text + ', counted from each person\'s start date. ' + (route === 'own' && sw < limitMonth ? 'Your first hires would reach it in month ' + limitMonth + ', so employer of record could not cover them for the full 24 months.' : 'Your first hires reach it in month ' + limitMonth + '.'), true);
  if (c.portage && hires && !portageRule) add(1, 'In France, employer of record runs through wage portage, which the law allows only for occasional or specialist assignments of up to 36 months, not permanent roles.', true);
  else if (c.eor_limit > 0 && hires && !limitHit && !c.portage) add(3, c.limit_text + ', counted from each person\'s start date. Nobody in your plan reaches it within 24 months.', true);
  if (route === 'eor' && (i.risk_sales || i.risk_manager)) add(1, 'Employer of record does not remove the taxable presence that local sales or management staff can create. Get tax advice before they start.', true);
  if (route === 'eor' && i.risk_licences) add(1, 'Licences, tenders and contracts in your own name will still need your own company.', true);
  if (hires && i.country === 'ie') add(3, 'Check that your employer of record provider holds an employment agency licence in Ireland.', true);
  if (hires && i.country === 'au') add(3, 'In Victoria, Queensland and the ACT, check that your employer of record provider holds a labour hire licence.', true);
  if (hires && i.country === 'ca') add(3, 'Check that your employer of record provider holds an Ontario temporary help agency licence.', true);
  // The other side of the answer.
  if (hires && i.plan_permanent && !stays) add(2, 'You ticked a long-term presence, but your plan ends with nobody in the country, so this is treated as a temporary need.');
  if (route === 'own' && !passes && !banned && !urgentRisk && !portageRule && !financial) add(2, 'Employer of record still makes sense if you are not sure you are staying' + (limitHit ? ', as long as each person moves or leaves within ' + c.eor_limit + ' months of starting' : '') + '. At this size your own company costs about ' + cur(Math.max(0, plan[ROUTE_MONTHS - 1] - eorTotal)) + ' more over 24 months.');
  if (route === 'eor' && !banned && financial) add(2, 'If you decide to stay, start setting up your own company a few months before you need it. A ' + c.entity + ' usually takes ' + c.setup_range + '.');
  if (route === 'eor' && !banned && !bridge && !financial && crossHead) add(2, crossHead <= 1 ? 'Look again if you decide to stay, as your own company already costs less each month to run at this size.' : 'Look again if the team grows past about ' + people(crossHead) + ' and you plan to stay, as your own company then costs less each month.');
  // Timing.
  if (route === 'own' && usesEor && start === 1) add(4, 'Because your first person starts within a month, employer of record lets them start before your own company is ready.');
  if (route === 'own' && !usesEor && !passes) add(4, 'Because your first hire is not until month ' + firstHire + ', there is time to set up your own company first.');
  if (passes && start < sw) add(1, 'Your first hire cannot start until month ' + sw + ', when your own company is ready to sponsor work passes.');
  const others = [i.risk_sales || i.risk_manager ? 'local sales or management staff' : null, i.risk_licences ? 'licences, contracts or data storage' : null, i.risk_regulated ? 'a regulated sector' : null].filter(Boolean);
  if (others.length > 1) add(5, 'You also flagged ' + others.slice(1).join(' and ') + (others.length > 2 ? ', which point' : ', which points') + ' the same way.');
  if (strategic && i.plan_permanent) add(6, route === 'own' ? 'You plan a long-term presence, which also points to your own company.' : 'You plan a long-term presence, but at this size that alone does not justify your own company.');
  if (hires && !strategic && route === 'own') add(5, 'Even without a long-term presence planned, the costs or the risks point to your own company.');
  if (i.ma) add(5, 'As this is part of an acquisition or carve-out, plan payroll and employment transfers alongside the deal.');
  if (uplift) add(5, 'Running your own company costs 30% more here because you do not work in the local language.');
  if (hires && !i.exclusive && !urgentRisk) add(2, 'Because they will not work only for you under your direction, contractors could also suit these roles, if they are truly independent.');
  const notes = all.filter((n) => !n.rule).map((n) => n.text);
  const heroNotes = all.map((n, k) => [n, k]).sort((a, b) => a[0].p - b[0].p || a[1] - b[1]).slice(0, 3).map((x) => x[0].text);

  const when = (m) => (m <= 1 ? 'Now' : 'Month ' + m);
  const first = (n) => (n === 1 ? 'person' : n + ' people');
  const steps = [];
  if (hires && route === 'own') {
    steps.push([setupStart, when(setupStart) + ': start setting up ' + yours + (limitHit && sw === limitMonth ? ' at the latest' : '') + '. It usually takes ' + c.setup_range + '.']);
    if (usesEor) steps.push([firstHire, when(firstHire) + ': hire your first ' + first(heads[firstHire - 1]) + ' through employer of record.']);
    steps.push([sw + 0.5, when(sw) + ': ' + (usesEor ? 'move your team onto your own company.' : heads[sw - 1] > 0 ? 'your own company employs your first ' + first(heads[sw - 1]) + ' directly.' : 'your own company is ready to employ people, ahead of your first hire in month ' + firstHire + '.')]);
  } else if (bridge) {
    steps.push([firstHire, when(firstHire) + ': hire your first ' + first(heads[firstHire - 1]) + ' through employer of record. There is no setup cost.']);
    steps.push([setupStart, when(setupStart) + ': decide whether you are keeping the team. If you are, start setting up ' + yours + ', which usually takes ' + c.setup_range + '.']);
    steps.push([sw + 0.5, when(sw) + ': your first hires reach the ' + c.eor_limit + '-month limit. Move them onto your own company or end their placements.']);
  } else if (hires) {
    steps.push([firstHire, when(firstHire) + ': hire your first ' + first(heads[firstHire - 1]) + ' through employer of record. There is no setup cost.']);
    if (switchMonth !== null) steps.push([Math.max(firstHire, switchMonth - setupMonths), when(Math.max(firstHire, switchMonth - setupMonths)) + ': review the decision. ' + (crossHead <= 1 ? 'Your own company already costs less each month to run, so the question is whether you are staying.' : 'Your own company starts to cost less each month at about ' + people(crossHead) + '.')]);
    if (switchMonth === null) steps.push([24, 'Month 24: review the decision if your plans grow.']);
  }
  steps.sort((a, b) => a[0] - b[0]);

  const flags = [];
  flags.push(banned ? c.eor + ' Take local legal advice before using employer of record for anything beyond a short, temporary need.'
    : limitHit ? c.eor + ' The limit runs from each person\'s start date, and your first hires reach it in month ' + limitMonth + '.'
    : portageRule ? c.eor + ' You plan a long-term presence, so this counts as a risk.' : c.eor);
  if (i.risk_sales || i.risk_manager) flags.push('Staff who sign contracts, close local sales or run the local operation can create a taxable presence in that country, even through employer of record. Get tax advice for that country before they start.');
  if (i.risk_licences) flags.push('Local licences, contracts in your own name, public tenders or local data storage usually need your own local company.');
  if (i.risk_regulated) flags.push('Regulated sectors often need a local company from the start. Check the rules for that country early.');

  return {
    country: c.name,
    currency: c.currency,
    salary: i.salary,
    employer_costs_per_person: r0(employer),
    cost_per_person_year: r0(perPerson),
    team_cost_24_months: r0(teamCost),
    route,
    uses_employer_of_record: usesEor,
    employer_of_record_available: !passes,
    first_hire_month: firstHire || null,
    switch_month: sw,
    setup_start_month: setupStart,
    ready_month: readyMonth,
    cost_crossover_month: switchMonth,
    crossover_headcount: crossHead,
    payback_month: payback,
    headcount: heads,
    cumulative_stay_eor: passes ? null : stayEor,
    cumulative_plan: plan,
    total_stay_eor: passes ? null : eorTotal,
    total_plan: plan[ROUTE_MONTHS - 1],
    difference: passes ? null : plan[ROUTE_MONTHS - 1] - eorTotal,
    best_own_company_saving: passes ? null : bestSaving,
    saving_threshold: r0(threshold),
    running_cost_used: r0(running),
    checks: { financial, risk, strategic, score },
    country_rules: { eor_limit_months: c.eor_limit, limit_applies: limitHit, limit_month: limitMonth, needs_work_pass_sponsor: passes, portage_not_for_permanent_roles: portageRule },
    headline,
    reason,
    money,
    notes,
    hero_notes: heroNotes,
    steps: steps.map((x) => x[1].replace(/\.\./g, '.')),
    flags
  };
}

function cleanRouteInput(raw) {
  const yes = (k) => raw[k] === true;
  const out = {
    country: Object.prototype.hasOwnProperty.call(ROUTE_COUNTRIES, raw.country) ? raw.country : 'uk'
  };
  const bad = { error: 'Please check the numbers. Headcounts must be whole numbers from 0 to 10,000 and costs cannot be negative.' };
  out.salary = num(raw.salary, 1000, 1e7);
  if (out.salary === null) return { error: 'Enter an average salary a year.' };
  out.local_language = yes('local_language');
  out.citizens = yes('citizens');
  for (const k of ['now', 'm12', 'm24']) {
    const n = num(raw[k], 0, 10000);
    if (n === null || !Number.isInteger(n)) return bad;
    out[k] = n;
  }
  if (out.now + out.m12 + out.m24 === 0) return { error: 'Enter at least one person in your hiring plan.' };
  out.urgency = ['month', 'soon', 'later'].includes(raw.urgency) ? raw.urgency : 'soon';
  for (const k of ['exclusive', 'risk_sales', 'risk_manager', 'risk_licences', 'risk_regulated', 'plan_permanent', 'ma']) out[k] = yes(k);
  for (const [k, min, max] of [['fee', 1, 1e5], ['setup', 0, 1e7], ['running', 0, 1e6], ['payroll', 0, 1e5]]) {
    const n = num(raw[k], min, max);
    if (n === null) return bad;
    out[k] = n;
  }
  return out;
}

// The figures exactly as the hiring planner page shows them, so the review can quote them word for word.
function routeFigures(i, m) {
  const money = moneyFmt(m.currency);
  const people = (n) => (n === 0 ? 'nobody' : `${intFmt(n)} ${n === 1 ? 'person' : 'people'}`);
  const month = (n) => (n === null || n === undefined ? 'none' : `month ${n}`);
  return {
    your_inputs: {
      country: m.country,
      currency: m.currency,
      average_salary_a_year: money(i.salary),
      people_now: people(i.now), people_in_12_months: people(i.m12), people_in_24_months: people(i.m24),
      first_person_starts: { month: 'within a month', soon: 'in about three months', later: 'in about five months' }[i.urgency],
      employer_of_record_fee_per_person_a_month: money(i.fee),
      own_company_setup_cost: money(i.setup),
      own_company_running_cost_a_month: money(i.running),
      payroll_cost_per_person_a_month: money(i.payroll),
      answers: {
        works_in_local_language: i.local_language, all_citizens_or_residents: i.citizens, work_only_for_you: i.exclusive,
        local_sales_staff: i.risk_sales, country_manager: i.risk_manager, licences_contracts_or_data: i.risk_licences,
        regulated_sector: i.risk_regulated, long_term_presence: i.plan_permanent, acquisition_or_carve_out: i.ma
      }
    },
    figures: {
      answer_shown: { headline: m.headline, reason: m.reason, money: m.money },
      route: m.route === 'own' ? 'your own company' : 'employer of record',
      one_person_costs_a_year: money(m.cost_per_person_year),
      employer_taxes_and_contributions_per_person: money(m.employer_costs_per_person),
      team_pay_and_employer_costs_over_24_months: money(Math.round(m.team_cost_24_months / 1000) * 1000),
      fees_setup_and_running_costs_of_the_plan_over_24_months: money(m.total_plan),
      employer_of_record_fees_throughout_over_24_months: m.total_stay_eor === null ? 'not available' : money(m.total_stay_eor),
      plan_compared_with_employer_of_record: m.difference === null ? 'not comparable' : m.difference <= 0 ? `saves ${money(-m.difference)}` : `costs ${money(m.difference)} more`,
      first_hire: month(m.first_hire_month),
      own_company_from: month(m.switch_month),
      start_setup: month(m.setup_start_month),
      setup_paid_back_by: month(m.payback_month),
      own_company_cheaper_each_month_from: m.crossover_headcount ? people(m.crossover_headcount) : 'not reached',
      checks_pointing_to_own_company: `${m.checks.score} of 3`,
      checks: m.checks,
      country_limit_on_employer_of_record: m.country_rules.eor_limit_months ? `${m.country_rules.eor_limit_months} months per person` : 'none',
      limit_reached_in: month(m.country_rules.limit_month),
      next_steps: m.steps,
      notes: m.hero_notes,
      country_rules_and_flags: m.flags
    }
  };
}

async function routeReview(input, env) {
  const maths = routeMaths(input);
  const facts = routeFigures(input, maths);
  const prompt = `You are an adviser on international expansion, reviewing whether a company should hire in a new country through an employer of record or its own local company. A visitor has just entered their own plan. All figures below were calculated with fixed formulas from their answers, 2026 employer contribution rules for the country and editable cost estimates, and are written exactly as the page shows them. Your job is the wording only.

What the figures mean:
- answer_shown is the plain-English answer already on the page. Keep the review consistent with it.
- One person's cost and the team's pay and employer costs are the same on either route. The plan and employer of record totals are fees, setup and running costs only, with salaries and employer taxes left out, so describe them that way.
- The cost check points to your own company only when the saving is big enough to matter; a smaller saving is within the margin of the estimates and is not a reason to set up a company. A risk check that does not point to your own company means no tax, regulatory or contract risks were reported, which is good news.
- When employer of record is not available (Singapore work pass holders), do not compare with employer of record or mention a saving.
- A country limit runs from each person's start date. setup_paid_back_by is when the plan's running total falls back below employer of record; own_company_cheaper_each_month_from is the team size at which the monthly cost of your own company falls below the fees. Keep these apart.
- Figures leave out the company's own HR, legal and management time and any cost of closing the company. Use only these figures, answers and flags. Do not invent other country-specific laws, tax rules or statistics, and do not name any provider. This is general guidance, not legal or tax advice.
- Say "employer of record", "your own company", "employer taxes and contributions", "over 24 months" and "a year". Do not use abbreviations such as EOR, ARR, PE or TCO. Write for a CFO or HR director.

${WORDING_RULES}

${JSON.stringify(facts)}

Reply only with JSON in this form:
{"summary": "two sentences on the recommended route for this plan and why", "driver": "one or two sentences on what is driving the route, using the three checks and the cost figures", "risks": ["risk", "risk"], "confirm": ["question to confirm with an adviser in that country", "question", "question"]}`;
  const review = await writeReview(env, prompt, { summary: 500, driver: 500, risks: [3, 300], confirm: [4, 300] }, allowedNumbers(facts, [24, 36]), 'Route');
  return { tool: 'route', input, model: env.MODEL || DEFAULTS.MODEL, results: maths, review };
}

// Exported for local tests.
export const _test = { routeFigures, planFigures, refFigures, allowedNumbers, unknownNumbers, numbersIn, writeQuestions, bareCategory, writeReview, routeMaths, cleanRouteInput, refMaths, cleanReferralInput, planMaths, cleanPlanInput, placeName, cleanVisibilityInput, questionsFor, sentencesOf, scoreAnswers, firstIndex, namePattern, sentenceAround, domainsOf };