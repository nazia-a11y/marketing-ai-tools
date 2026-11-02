// Marketing tools API: one Cloudflare Worker shared by every tool.
// It holds the Anthropic key, limits usage, caches results and routes requests.
//
// Bindings (set in the Cloudflare dashboard):
//   ANTHROPIC_API_KEY  secret
//   STORE              KV namespace (cache and run counters)
//   ALLOWED_ORIGINS    comma-separated list of pages allowed to call this API
//   DAILY_CAP          total runs per day across all visitors (default 20)
//   VISITOR_CAP        runs per visitor per day (default 2)
//   MODEL              Claude model (default claude-haiku-5-5)

const DEFAULTS = { DAILY_CAP: 20, VISITOR_CAP: 2, MODEL: 'claude-haiku-5-5' };
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
        return json(await usage(request, env), 200, cors);
      }
      if (url.pathname === '/api/visibility' && request.method === 'POST') {
        if (!cors['Access-Control-Allow-Origin']) return json({ error: 'This page is not allowed to use the API.' }, 403, cors);
        const input = cleanVisibilityInput(await request.json().catch(() => ({})));
        if (input.error) return json({ error: input.error }, 400, cors);
        return json(await runLimited(request, env, 'visibility', input, () => visibility(input, env)), 200, cors);
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

function caps(env) {
  return {
    daily: Number(env.DAILY_CAP || DEFAULTS.DAILY_CAP),
    visitor: Number(env.VISITOR_CAP || DEFAULTS.VISITOR_CAP)
  };
}

async function usage(request, env) {
  const c = caps(env);
  const vid = await visitorId(request);
  const used = Number((await env.STORE.get(`count:${today()}`)) || 0);
  const mine = Number((await env.STORE.get(`visitor:${today()}:${vid}`)) || 0);
  return { remaining_today: Math.max(0, c.daily - used), remaining_for_you: Math.max(0, c.visitor - mine) };
}

// Cached results are free and do not count against any limit.
async function runLimited(request, env, tool, input, work) {
  const key = `cache:${tool}:${await sha256(JSON.stringify(input))}`;
  const cached = await env.STORE.get(key, 'json');
  if (cached) return { ...cached, cached: true };

  const c = caps(env);
  const vid = await visitorId(request);
  const dayKey = `count:${today()}`;
  const visKey = `visitor:${today()}:${vid}`;
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
  return { ...result, cached: false };
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
  if (category.length < 3) return { error: 'Enter the category you sell in, for example "colocation provider".' };
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
    max_tokens: 700,
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
  const corpus = answers.map((a) => a.text).join('\n---\n').slice(0, 12000);
  const msg = await claude(env, {
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Below are several AI answers about ${category}s.\n\n${corpus}\n\nList every company or brand named in these answers as a ${category}, except these: ${known.join(', ') || 'none'}. Use the names exactly as written. Reply only with JSON: {"brands": ["..."]}`
    }]
  });
  try {
    const t = textOf(msg).replace(/^```(json)?|```$/g, '').trim();
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

// Exported for local tests.
export const _test = { placeName, cleanVisibilityInput, questionsFor, scoreAnswers, firstIndex, namePattern, sentenceAround, domainsOf };
