// Watchlist price proxy for Cloudflare Workers (free plan is enough).
//
// To update an existing Worker: open it in Cloudflare, click Edit code, replace everything
// with this file, and click Deploy.
//
// First-time setup: Workers & Pages > Create > Hello World > Deploy, then Edit code,
// paste this file, and Deploy again. Paste the Worker's address into "Price sources"
// on your watchlist page (or send it to Claude to build in as the default).
//
// It only calls Yahoo Finance, and only for the symbols you ask for.

const UA = 'Mozilla/5.0 (compatible; watchlist)';
let session = null; // cached Yahoo cookie + crumb, reused for up to an hour

async function getSession() {
  if (session && Date.now() - session.at < 3600000) return session;
  const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const cookie = ((r.headers.get('set-cookie') || '').match(/A3=[^;]+/) || [])[0];
  if (!cookie) throw new Error('no cookie');
  const c = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await c.text()).trim();
  if (!c.ok || !crumb || crumb.includes('<')) throw new Error('no crumb');
  session = { cookie, crumb, at: Date.now() };
  return session;
}

// One batched call for P/E and 52-week range (needs the cookie + crumb).
async function fetchQuotes(symbols) {
  const s = await getSession();
  const r = await fetch(
    'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbols.join(',')) + '&crumb=' + encodeURIComponent(s.crumb),
    { headers: { 'User-Agent': UA, Cookie: s.cookie } }
  );
  if (!r.ok) { session = null; throw new Error('quote HTTP ' + r.status); }
  const out = {};
  for (const q of (await r.json()).quoteResponse.result) out[q.symbol] = q;
  return out;
}

async function fetchChart(sym) {
  const r = await fetch(
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=1d',
    { headers: { 'User-Agent': UA } }
  );
  return (await r.json()).chart.result[0].meta;
}

// Average US 30-year mortgage rate (Freddie Mac weekly survey, via FRED).
async function fetchMortgage() {
  const r = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('FRED HTTP ' + r.status);
  const rows = (await r.text()).trim().split(/\r?\n/).slice(1).map(l => l.split(','))
    .filter(x => x.length >= 2 && isFinite(parseFloat(x[1])));
  if (rows.length < 2) throw new Error('no data');
  const a = rows[rows.length - 1], b = rows[rows.length - 2], y = rows[rows.length - 53];
  return { rate: parseFloat(a[1]), prev: parseFloat(b[1]), date: a[0], yago: y ? parseFloat(y[1]) : null };
}

const RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max'];
const INTERVALS = ['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo'];

// ---- Market movers (Home page) --------------------------------------------
// Universe: US stocks worth over $2B, priced over $5, with real trading volume.
const UNIVERSE = [
  { operator: 'EQ', operands: ['region', 'us'] },
  { operator: 'GTE', operands: ['intradaymarketcap', 2000000000] },
  { operator: 'GTE', operands: ['intradayprice', 5] },
  { operator: 'GT', operands: ['avgdailyvol3m', 200000] }
];

async function screen(sortField, sortType, size, offset = 0) {
  const s = await getSession();
  const r = await fetch(
    'https://query1.finance.yahoo.com/v1/finance/screener?lang=en-US&region=US&formatted=false&corsDomain=finance.yahoo.com&crumb=' + encodeURIComponent(s.crumb),
    {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Cookie: s.cookie },
      body: JSON.stringify({
        size, offset, sortField, sortType, quoteType: 'EQUITY', userId: '', userIdType: 'guid',
        query: { operator: 'AND', operands: UNIVERSE }
      })
    }
  );
  if (!r.ok) { session = null; throw new Error('screener HTTP ' + r.status); }
  const res = ((await r.json()).finance || {}).result;
  if (!res || !res[0]) throw new Error('no screener result');
  return res[0].quotes || [];
}

// 5-trading-day change for up to ~20 symbols per request.
async function sparkWeek(batch) {
  const s = await getSession();
  const r = await fetch(
    'https://query1.finance.yahoo.com/v8/finance/spark?range=1mo&interval=1d&symbols=' + encodeURIComponent(batch.join(',')) + '&crumb=' + encodeURIComponent(s.crumb),
    { headers: { 'User-Agent': UA, Cookie: s.cookie } }
  );
  if (!r.ok) throw new Error('spark HTTP ' + r.status);
  const j = await r.json(), out = [];
  const add = (sym, closes) => {
    const c = (closes || []).filter(v => typeof v === 'number' && isFinite(v));
    if (c.length >= 6) out.push({ s: sym, p: c[c.length - 1], c: (c[c.length - 1] / c[c.length - 6] - 1) * 100 });
  };
  if (j.spark && j.spark.result) {
    for (const it of j.spark.result) {
      const resp = it.response && it.response[0];
      add(it.symbol, resp && resp.indicators && resp.indicators.quote && resp.indicators.quote[0] && resp.indicators.quote[0].close);
    }
  } else {
    for (const k of Object.keys(j)) add(k, j[k] && j[k].close);
  }
  return out;
}

async function weekMovers() {
  const pages = await Promise.all([screen('intradaymarketcap', 'DESC', 250, 0), screen('intradaymarketcap', 'DESC', 250, 250)]);
  const names = {}, syms = [];
  for (const q of pages.flat()) {
    if (/^[A-Z0-9.\-]{1,10}$/.test(q.symbol) && !(q.symbol in names)) { names[q.symbol] = q.shortName || q.longName || ''; syms.push(q.symbol); }
  }
  const batches = [];
  for (let i = 0; i < syms.length; i += 20) batches.push(syms.slice(i, i + 20));
  const rows = (await Promise.all(batches.map(b => sparkWeek(b).catch(() => [])))).flat();
  if (rows.length < 50) throw new Error('too few weekly prices');
  rows.forEach(x => { x.n = names[x.s] || ''; });
  rows.sort((a, b) => b.c - a.c);
  return { up: rows.slice(0, 10), down: rows.slice(-10).reverse(), count: rows.length };
}

let moversCache = null;
async function getMovers() {
  if (moversCache && Date.now() - moversCache.t < 300000) return moversCache.d;
  await getSession(); // sign in once so the parallel calls below reuse it
  const safe = p => p.catch(() => null);
  const pick = (qs, key) => (qs || []).map(q => ({ s: q.symbol, n: q.shortName || q.longName || '', p: num(q.regularMarketPrice), c: num(q[key]) }))
    .filter(x => x.c !== null).slice(0, 10);
  const [du, dd, yu, yd, wk] = await Promise.all([
    safe(screen('percentchange', 'DESC', 12)), safe(screen('percentchange', 'ASC', 12)),
    safe(screen('fiftytwowkpercentchange', 'DESC', 12)), safe(screen('fiftytwowkpercentchange', 'ASC', 12)),
    safe(weekMovers())
  ]);
  const d = {
    asOf: new Date().toISOString(),
    day: du && dd ? { up: pick(du, 'regularMarketChangePercent'), down: pick(dd, 'regularMarketChangePercent') } : null,
    week: wk,
    year: yu && yd ? { up: pick(yu, 'fiftyTwoWeekChangePercent'), down: pick(yd, 'fiftyTwoWeekChangePercent') } : null
  };
  if (d.day || d.week || d.year) moversCache = { t: Date.now(), d };
  return d;
}

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const headers = {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=60'
    };

    // Diagnostics: open /?debug=1 to see how each data source answers from Cloudflare.
    if (url.searchParams.get('debug')) {
      const t = async (name, fn) => { try { return [name, await fn()]; } catch (e) { return [name, 'ERROR ' + (e.message || e)]; } };
      const peek = async r => 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120).replace(/\s+/g, ' ');
      const res = await Promise.all([
        t('yahoo_chart_GSPC', async () => peek(await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d', { headers: { 'User-Agent': UA } }))),
        t('yahoo_session', async () => { const s = await getSession(); return 'ok crumb ' + s.crumb.length + ' chars'; }),
        t('yahoo_quote', async () => { const q = await fetchQuotes(['AAPL']); return Object.keys(q).length + ' quote(s)'; }),
        t('yahoo_screener', async () => (await screen('percentchange', 'DESC', 3)).length + ' rows'),
        t('fred', async () => peek(await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US', { headers: { 'User-Agent': UA } })))
      ]);
      return new Response(JSON.stringify(Object.fromEntries(res), null, 2), { headers });
    }

    if (url.searchParams.get('mortgage')) {
      const m = await fetchMortgage().catch(() => ({}));
      return new Response(JSON.stringify(m), { headers });
    }

    // Biggest winners and losers across the US market (Home page).
    if (url.searchParams.get('movers')) {
      try {
        return new Response(JSON.stringify(await getMovers()), { headers: { ...headers, 'cache-control': 'public, max-age=300' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { headers });
      }
    }

    // Price history for the Charts tab: passes Yahoo's chart data straight through.
    const chartSym = url.searchParams.get('chart');
    if (chartSym) {
      const range = url.searchParams.get('range') || '1y', interval = url.searchParams.get('interval') || '1d';
      if (!/^[A-Za-z0-9.\-^=]{1,14}$/.test(chartSym) || !RANGES.includes(range) || !INTERVALS.includes(interval)) {
        return new Response('{}', { status: 400, headers });
      }
      try {
        const r = await fetch(
          'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(chartSym) + '?range=' + range + '&interval=' + interval,
          { headers: { 'User-Agent': UA } }
        );
        return new Response(await r.text(), { headers });
      } catch (e) {
        return new Response('{}', { headers });
      }
    }

    const symbols = (url.searchParams.get('symbols') || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => /^[A-Za-z0-9.\-^=]{1,14}$/.test(s))
      .slice(0, 40); // free plan allows 50 outgoing requests per call

    const [quotes, charts] = await Promise.all([
      symbols.length ? fetchQuotes(symbols).catch(() => ({})) : {},
      Promise.all(symbols.map(s => fetchChart(s).catch(() => null)))
    ]);

    const out = {};
    symbols.forEach((s, i) => {
      const m = charts[i] || {}, q = quotes[s] || {};
      const price = num(m.regularMarketPrice) ?? num(q.regularMarketPrice);
      if (price === null) { out[s] = null; return; }
      out[s] = {
        price,
        prev: num(m.chartPreviousClose) ?? num(m.previousClose) ?? num(q.regularMarketPreviousClose),
        cur: m.currency || q.currency,
        pe: num(q.trailingPE),
        hi: num(q.fiftyTwoWeekHigh) ?? num(m.fiftyTwoWeekHigh),
        lo: num(q.fiftyTwoWeekLow) ?? num(m.fiftyTwoWeekLow)
      };
    });

    return new Response(JSON.stringify(out), { headers });
  }
};
