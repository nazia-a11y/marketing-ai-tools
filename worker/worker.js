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
  const key = `cache:${tool}:v5:${await sha256(JSON.stringify(input))}`;
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

function questionsFor({ category, country, competitors }) {
  const where = country === 'Global' ? '' : ` in ${placeName(country)}`;
  const qs = [
    `What are the best ${category}s${where}?`,
    `Which ${category}${where} would you recommend for a mid-sized company, and why?`,
    `I am comparing ${category}s${where}. Which companies should be on my shortlist?`,
    `Who are the leading ${category}s${where} for enterprise customers?`
  ];
  qs.push(competitors.length
    ? `What are the best alternatives to ${competitors[0]} as a ${category}${where}?`
    : `Which ${category}s${where} have the strongest reputation with customers?`);
  return qs;
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

function sentenceAround(text, idx) {
  const start = Math.max(text.lastIndexOf('.', idx), text.lastIndexOf('\n', idx)) + 1;
  let end = text.slice(idx).search(/[.\n]/);
  end = end < 0 ? text.length : idx + end + 1;
  return text.slice(start, end).replace(/[*#_`>]/g, '').trim().slice(0, 260);
}

function scoreAnswers(answers, names, brand) {
  const stats = Object.fromEntries(names.map((n) => [n, { mentions: 0, positions: [] }]));
  const quotes = [];
  for (const a of answers) {
    const found = names.map((n) => ({ n, i: firstIndex(a.text, n) })).filter((x) => x.i >= 0).sort((x, y) => x.i - y.i);
    found.forEach((f, rank) => { stats[f.n].mentions += 1; stats[f.n].positions.push(rank + 1); });
    const own = found.find((f) => f.n === brand);
    if (own && quotes.length < 3) {
      const text = sentenceAround(a.text, own.i);
      if (!quotes.some((q) => q.text === text)) quotes.push({ question: a.question, text });
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
      content: `Below are several AI answers about ${category}s.\n\n${corpus}\n\nList every company or brand named in these answers as a ${category}, except these: ${known.join(', ') || 'none'}. Use the names exactly as written. Reply only with JSON: {"brands": ["..."]}`
    }]
  });
  try {
    const t = (textOf(msg).match(/\{[\s\S]*\}/) || ['{}'])[0];
    const list = JSON.parse(t).brands;
    return Array.isArray(list) ? [...new Set(list.map((b) => clip(b, 60)).filter(Boolean))].slice(0, 12) : [];
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
  const questions = questionsFor(input);
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
  const names = [...known, ...discovered.filter((d) => !known.some((k) => k.toLowerCase() === d.toLowerCase()))];

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

// Improve a rate by 5 points, or by 1 point when it is under 10%.
const stepFor = (rate) => (rate < 10 ? 1 : 5);

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
  const whatIf = stages.map((s) => {
    const better = Math.min(100, s.rate + stepFor(s.rate));
    const saving = budget * (1 - s.rate / better);
    return { stage: s.label, from: s.rate, to: better, budget_saving: r(saving) };
  }).sort((a, b) => b.budget_saving - a.budget_saving);
  const names = i.mode === 'simple' ? ['leads', 'opportunities', 'won'] : ['leads', 'mqls', 'sqls', 'opportunities', 'won'];
  const annual = { marketing_revenue: r(mktRevenue) };
  const monthly = {};
  names.forEach((n, k) => { annual[n] = Math.ceil(counts[k]); monthly[n] = n === 'won' ? +(counts[k] / 12).toFixed(1) : r(counts[k] / 12); });
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
    weakest_stage: stages.slice().sort((a, b) => a.rate - b.rate)[0].label,
    what_if: whatIf,
    channel_budget: i.channels.map((c) => ({ name: c.name, leads: Math.ceil(leads * c.share / 100), budget: r(leads * (c.share / 100) * c.cpl) }))
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

async function plan(input, env) {
  const maths = planMaths(input);
  const facts = JSON.stringify({ inputs: input, results: maths });
  const msg = await claude(env, {
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `You are a B2B marketing operations lead reviewing a pipeline plan. All figures below were calculated with fixed formulas. Use only these figures and do not invent benchmarks or statistics. If the funnel_detail is basics only, do not comment on stages that were not given; you may suggest tracking them. Currency is ${input.currency}.

${facts}

Write a short review in British English, without contractions, in plain words a CEO would understand. Reply only with JSON in this form:
{"summary": "two sentences on what the plan needs", "constraint": "one or two sentences on the single biggest constraint, using the what_if figures", "risks": ["risk", "risk"], "actions": ["action", "action", "action"]}`
    }]
  });
  let review = null;
  const text = textOf(msg);
  try {
    const j = parseJsonLoose(text);
    const s = (x, n) => clip(x, n);
    review = {
      summary: s(j.summary, 500),
      constraint: s(j.constraint, 500),
      risks: (Array.isArray(j.risks) ? j.risks : []).map((x) => s(x, 300)).filter(Boolean).slice(0, 3),
      actions: (Array.isArray(j.actions) ? j.actions : []).map((x) => s(x, 300)).filter(Boolean).slice(0, 4)
    };
  } catch { /* handled below */ }
  if (!review || !review.summary) {
    console.log('Plan review unreadable', msg.stop_reason, text.slice(0, 300));
    throw fail(502, 'The AI review could not be written. Please try again.');
  }
  return { tool: 'plan', input, model: env.MODEL || DEFAULTS.MODEL, results: maths, review };
}

// ---------- referral revenue calculator ----------

// Referral Revenue Calculator: the formulas, shared word for word by the page and the server.
// Presets come from published benchmarks (see the page for sources). Cautious uses the low end.
const REF_PRESETS = {
  cautious: { refer: 2, signup: 5, convert: 5, uplift: 0, churn_cut: 0 },
  typical: { refer: 5, signup: 15, convert: 8, uplift: 25, churn_cut: 18 },
  strong: { refer: 10, signup: 25, convert: 12, uplift: 50, churn_cut: 18 }
};
const REF_RAMP_MONTHS = 6;   // the programme builds to full strength over six months
const REF_SALES_LAG = 3;     // sales-led deals close about three months after sign-up
const REF_MAX_LIFE = 10;     // cap customer lifetime at ten years

// Improve a rate by 5 points, or by 1 point when it is under 10%.
const refStep = (rate) => (rate < 10 ? 1 : 5);

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
  const rates = refRates(i);
  const run = refRun(i, rates);
  const n = run.won;
  const rewardCost = n * i.reward;
  const runningCost = 12 * i.monthly_cost;
  const totalCost = rewardCost + runningCost;
  const costPer = n > 0 ? totalCost / n : null;
  const life = (churn) => Math.min(REF_MAX_LIFE, 100 / Math.max(churn, 0.1));
  const lifeNormal = life(i.churn);
  const lifeReferred = life(i.churn * (1 - rates.churn_cut / 100));

  // What-if: improve one lever at a time and see the extra customers in a year.
  const levers = [
    ['refer', 'Customers who refer each month'],
    ['signup', 'Referred people who sign up'],
    i.motion === 'sales_led' ? ['win_rate', 'Your win rate'] : ['convert', 'Sign-ups who become paying']
  ];
  const whatIf = levers.map(([key, label]) => {
    const from = key === 'win_rate' ? i.win_rate : rates[key];
    const to = Math.min(100, from + refStep(from));
    let better;
    if (key === 'win_rate') better = { ...rates, convert: Math.min(100, to * (1 + rates.uplift / 100)) };
    else better = { ...rates, [key]: to };
    const extra = refRun(i, better).won - n;
    return { lever: label, from, to, extra_customers: r1(extra), extra_arr: r0(extra * i.acv) };
  }).sort((a, b) => b.extra_arr - a.extra_arr);

  const warnings = [];
  if (n < 1) warnings.push('At these numbers, referrals would bring in fewer than one new customer in a year.');
  if (i.reward > i.acv * 0.2) warnings.push('The reward is more than 20% of a customer\'s first-year value, which is above the usual range of 5% to 20%.');
  if (i.reward >= i.paid_cac) warnings.push('The reward costs as much as winning a customer through paid channels, so it removes most of the saving.');
  if (costPer !== null && costPer >= i.paid_cac) warnings.push('Once running costs are included, referrals cost more per customer than paid channels at these numbers.');

  return {
    rates: { refer: rates.refer, signup: rates.signup, convert: r1(rates.convert), churn_cut: rates.churn_cut },
    referrers: r0(run.referrers),
    signups: r1(run.signups),
    new_customers: r1(n),
    still_in_pipeline: r1(run.later),
    arr_added: r0(n * i.acv),
    share_of_base_pct: r1((n / i.customers) * 100),
    reward_cost: r0(rewardCost),
    running_cost: r0(runningCost),
    total_cost: r0(totalCost),
    cost_per_customer: costPer === null ? null : r0(costPer),
    paid_cost_same_customers: r0(n * i.paid_cac),
    saving_vs_paid: r0(n * i.paid_cac - totalCost),
    payback_months: costPer === null ? null : r1(costPer / (i.acv / 12)),
    reward_pct_of_acv: r1((i.reward / i.acv) * 100),
    lifetime_years_normal: r1(lifeNormal),
    lifetime_years_referred: r1(lifeReferred),
    lifetime_value_normal: r0(i.acv * lifeNormal),
    lifetime_value_referred: r0(i.acv * lifeReferred),
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

async function referral(input, env) {
  const maths = refMaths(input);
  const facts = JSON.stringify({ inputs: input, results: maths });
  const msg = await claude(env, {
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `You are a B2B SaaS growth lead advising whether a customer referral programme is worth running. All figures below were calculated with fixed formulas from the user's inputs and ${input.preset} benchmark assumptions. Use only these figures and do not invent benchmarks or statistics. Be honest: if the numbers are small or the programme costs more than paid channels, say so plainly and explain what would need to change. Currency is ${input.currency}.

${facts}

Write a short review in British English, without contractions, in plain words a founder would understand. Reply only with JSON in this form:
{"summary": "two sentences on whether a referral programme looks worth testing and why", "lever": "one or two sentences on the number that matters most, using the what_if figures", "risks": ["risk", "risk"], "actions": ["action", "action", "action"]}`
    }]
  });
  let review = null;
  const text = textOf(msg);
  try {
    const j = parseJsonLoose(text);
    const s = (x, n) => clip(x, n);
    review = {
      summary: s(j.summary, 500),
      lever: s(j.lever, 500),
      risks: (Array.isArray(j.risks) ? j.risks : []).map((x) => s(x, 300)).filter(Boolean).slice(0, 3),
      actions: (Array.isArray(j.actions) ? j.actions : []).map((x) => s(x, 300)).filter(Boolean).slice(0, 4)
    };
  } catch { /* handled below */ }
  if (!review || !review.summary) {
    console.log('Referral review unreadable', msg.stop_reason, text.slice(0, 300));
    throw fail(502, 'The AI review could not be written. Please try again.');
  }
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
    eor_limit: 18
  },
  fr: {
    name: 'France', currency: 'EUR', english: false, salary: 60000,
    fee: 515, payroll: 45, setup: 4000, running: 2000, setup_months: 2, setup_range: '3 to 8 weeks', entity: 'SAS',
    employer: (s) => 0.235 * s + 0.1466 * Math.min(s, 48060) + 0.0425 * Math.min(s, 192240) + 0.1478 * clampTo(s - 48060, 0, 336420),
    employer_text: 'health, family, pension, unemployment and other contributions, about 40% to 45% of pay. Pay below about €65,600 gets a reduction this tool does not apply, so it slightly overstates cost there',
    notes: ['Employers must also pay at least half of a company health plan, which is not included here.'],
    eor: 'France restricts lending workers for profit. Employer of record usually runs through wage portage, which only suits skilled, autonomous people on temporary assignments, for up to 36 months.',
    eor_limit: 18
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
    eor_limit: 18
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
const ROUTE_URGENCY_MONTHS = { month: 1, soon: 3, later: 99 };

// Headcount each month, in a straight line from now to 12 months to 24 months.
function routeHeadcount(i) {
  const out = [];
  for (let m = 1; m <= ROUTE_MONTHS; m++) {
    const h = m <= 12 ? i.now + (i.m12 - i.now) * (m / 12) : i.m12 + (i.m24 - i.m12) * ((m - 12) / 12);
    out.push(Math.max(0, Math.round(h)));
  }
  return out;
}

function routeMaths(i) {
  const r0 = (x) => Math.round(x);
  const c = ROUTE_COUNTRIES[i.country] || ROUTE_COUNTRIES.uk;
  const heads = routeHeadcount(i);

  // The cost of employing one person, which is the same on either route.
  const employer = c.employer(i.salary, i);
  const perPerson = i.salary + employer;
  const payTax = (h) => (c.payroll_tax ? c.payroll_tax.rate * Math.max(0, h * i.salary - c.payroll_tax.threshold) / 12 : 0);
  let teamCost = 0;
  for (const h of heads) teamCost += h * perPerson / 12 + payTax(h);

  // Route costs, on top of pay.
  const running = i.running * (c.english || i.local_language ? 1 : ROUTE_LANGUAGE_UPLIFT);
  const eorMonth = (h) => h * i.fee;
  const ownMonth = (h) => running + h * i.payroll;
  const setupMonths = Math.ceil(c.setup_months);
  const readyMonth = setupMonths + 1;              // earliest month your own company can employ people

  // Month by month, when does your own company become cheaper to run than employer of record?
  let switchMonth = null;
  for (let m = 1; m <= ROUTE_MONTHS; m++) if (eorMonth(heads[m - 1]) >= ownMonth(heads[m - 1]) && heads[m - 1] > 0) { switchMonth = m; break; }
  const crossHead = i.fee > i.payroll ? Math.ceil(running / (i.fee - i.payroll)) : null;

  // Cost of a plan that uses employer of record until a given month, then your own company.
  // People who need work passes in Singapore cannot be employed through employer of record, so nobody starts before your own company is ready.
  const passes = i.country === 'sg' && !i.citizens;
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
  const stayEor = planCost(null);
  const financialSwitch = switchMonth === null ? null : Math.max(switchMonth, readyMonth);
  const financialPlan = financialSwitch === null ? null : planCost(financialSwitch);
  const financial = financialPlan !== null && financialPlan[ROUTE_MONTHS - 1] < stayEor[ROUTE_MONTHS - 1];

  // Country rules that limit employer of record count as a risk when people would stay on it beyond the limit.
  const limitHit = c.eor_limit !== null && heads.some((h, k) => h > 0 && k + 1 > c.eor_limit);
  // Risks that need your own company as soon as it can be ready, as opposed to a time limit you can plan around.
  const urgentRisk = !!(i.risk_sales || i.risk_manager || i.risk_licences || i.risk_regulated || passes || (c.eor_limit === 0 && heads.some((h) => h > 0)));
  const risk = urgentRisk || limitHit;
  const strategic = !!(i.plan_permanent || i.ma);
  const score = [financial, risk, strategic].filter(Boolean).length;

  // Pick the plan.
  let route, sw = null;
  if (passes) {
    route = 'own';
    sw = readyMonth;
  } else if (score >= 2) {
    route = 'own';
    // Switch as soon as possible for urgent risks, otherwise when your own company becomes cheaper,
    // and never later than a country's limit on employer of record.
    if (urgentRisk) sw = readyMonth;
    else if (financial) sw = financialSwitch;
    else sw = limitHit ? c.eor_limit : readyMonth;
    if (limitHit) sw = Math.max(readyMonth, Math.min(sw, c.eor_limit));
  } else {
    route = 'eor';
  }
  const plan = route === 'own' ? planCost(sw) : stayEor;
  const setupStart = sw === null ? null : Math.max(1, sw - setupMonths);
  const needBy = ROUTE_URGENCY_MONTHS[i.urgency] || 3;
  const bridge = route === 'own' && !passes && (heads[0] > 0 || needBy < readyMonth);

  const steps = [];
  if (route === 'own') {
    if (setupStart === 1) steps.push('Start setting up your ' + c.entity + ' now. It usually takes ' + c.setup_range + ' in ' + c.name + '.');
    else steps.push('Start setting up your ' + c.entity + ' in month ' + setupStart + '. It usually takes ' + c.setup_range + ' in ' + c.name + '.');
    if (passes) steps.push('Your hires need work passes, which only your own company can sponsor, so they can start in month ' + sw + ', once it is ready.');
    else if (bridge || sw > 1) steps.push('Use employer of record for your first hires' + (sw > 1 ? ' until month ' + sw : '') + ', so you can hire straight away.');
    const why = urgentRisk ? ', as soon as it is ready, because of the risks flagged below'
      : financial && sw === financialSwitch ? ', when it becomes cheaper to run than employer of record'
      : limitHit && sw === c.eor_limit ? ', before the ' + c.eor_limit + '-month limit on employer of record in ' + c.name
      : ', as soon as it is ready, for the permanent presence you plan';
    if (!passes) steps.push('Move your team onto your own company in month ' + sw + why + '.');
  } else {
    steps.push('Hire through employer of record. You can start within days or weeks, with no setup cost.');
    if (switchMonth !== null) steps.push('Review the decision in month ' + Math.max(1, switchMonth - setupMonths) + '. Your own company starts to cost less to run at about ' + (crossHead || heads[switchMonth - 1]) + ' people, around month ' + switchMonth + '.');
    else steps.push('At this hiring plan, your own company does not become cheaper within 24 months. Review the decision if your plans grow.');
    if (limitHit) steps.push('Plan for the ' + c.eor_limit + '-month limit on employer of record in ' + c.name + '. By month ' + c.eor_limit + ', move people onto your own company or end their placements.');
  }

  const flags = [];
  if (c.eor_limit === 0) flags.push(c.eor + ' Take local legal advice before using employer of record for anything beyond a short, temporary need.');
  else if (limitHit) flags.push(c.eor + ' Your plan keeps people in the country beyond month ' + c.eor_limit + ', so this counts as a risk.');
  else flags.push(c.eor);
  if (passes) flags.push('You said your hires are not Singapore citizens or permanent residents, so they will need work passes, which your own company must sponsor.');
  if (i.risk_sales || i.risk_manager) flags.push('Staff who sign contracts, close local sales or run the local operation can create a taxable presence in that country, even through employer of record. Get tax advice for that country before they start.');
  if (i.risk_licences) flags.push('Local licences, contracts in your own name, public tenders or local data storage usually need your own local company.');
  if (i.risk_regulated) flags.push('Regulated sectors often need a local company from the start. Check the rules for that country early.');
  if (i.ma) flags.push('Acquisitions and carve-outs come with fixed deadlines, so plan payroll and employment transfers in parallel with the deal.');
  if (i.exclusive) flags.push('People who work only for you, full-time and under your direction, are usually treated as employees. Using contractors for them is risky, so employer of record or your own company is the safer choice.');
  if (!c.english && !i.local_language) flags.push('Running a company where you do not work in the local language costs more, so the running cost has been raised by 30%.');

  return {
    country: c.name,
    currency: c.currency,
    salary: i.salary,
    employer_costs_per_person: r0(employer),
    cost_per_person_year: r0(perPerson),
    team_cost_24_months: r0(teamCost),
    route,
    switch_month: sw,
    setup_start_month: setupStart,
    ready_month: readyMonth,
    cost_crossover_month: switchMonth,
    crossover_headcount: crossHead,
    headcount: heads,
    cumulative_stay_eor: stayEor,
    cumulative_plan: plan,
    total_stay_eor: stayEor[ROUTE_MONTHS - 1],
    total_plan: plan[ROUTE_MONTHS - 1],
    difference: plan[ROUTE_MONTHS - 1] - stayEor[ROUTE_MONTHS - 1],
    running_cost_used: r0(running),
    checks: { financial, risk, strategic, score },
    country_rules: { eor_limit_months: c.eor_limit, limit_applies: limitHit, needs_work_pass_sponsor: passes },
    steps,
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

async function routeReview(input, env) {
  const maths = routeMaths(input);
  const facts = JSON.stringify({ inputs: input, results: maths });
  const msg = await claude(env, {
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `You are an adviser on international expansion, reviewing whether a company should hire in a new country through an employer of record or its own local company. All figures below were calculated with fixed formulas from the user's answers, 2026 employer contribution rules for the country and editable cost estimates. results.cost_per_person_year is salary plus statutory employer costs, and results.team_cost_24_months is pay plus employer costs for the whole team. Both are the same on either route. results.total_plan and results.total_stay_eor are only the route costs on top of pay, so always describe them as costs on top of pay. results.flags include country rules on employer of record taken from published legal briefings, and you may refer to them. Use only these figures, answers and flags. Do not invent other country-specific laws, tax rules or statistics, and do not name any provider. This is general guidance, not legal or tax advice. In results.checks, each value is true when that check points towards setting up the company's own local company. A false risk check means no tax, regulatory or contract risk triggers were reported, which is good news, not a failure. results.ready_month is only the earliest month the company could employ people if setup started in month 1. Under the recommended plan, setup starts in results.setup_start_month and the company must be ready by results.switch_month, so use switch_month as the setup deadline. The country is ${maths.country} and the currency is ${maths.currency}.

${facts}

Write a short review in British English, without contractions, in plain words a CFO or HR director would understand. Reply only with JSON in this form:
{"summary": "two sentences on the recommended route and why", "driver": "one or two sentences on what is driving the route, using the three checks and the cost figures", "risks": ["risk", "risk"], "confirm": ["question to confirm with an adviser in that country", "question", "question"]}`
    }]
  });
  let review = null;
  const text = textOf(msg);
  try {
    const j = parseJsonLoose(text);
    const s = (x, n) => clip(x, n);
    review = {
      summary: s(j.summary, 500),
      driver: s(j.driver, 500),
      risks: (Array.isArray(j.risks) ? j.risks : []).map((x) => s(x, 300)).filter(Boolean).slice(0, 3),
      confirm: (Array.isArray(j.confirm) ? j.confirm : []).map((x) => s(x, 300)).filter(Boolean).slice(0, 4)
    };
  } catch { /* handled below */ }
  if (!review || !review.summary) {
    console.log('Route review unreadable', msg.stop_reason, text.slice(0, 300));
    throw fail(502, 'The AI review could not be written. Please try again.');
  }
  return { tool: 'route', input, model: env.MODEL || DEFAULTS.MODEL, results: maths, review };
}

// Exported for local tests.
export const _test = { routeMaths, cleanRouteInput, refMaths, cleanReferralInput, planMaths, cleanPlanInput, placeName, cleanVisibilityInput, questionsFor, scoreAnswers, firstIndex, namePattern, sentenceAround, domainsOf };
