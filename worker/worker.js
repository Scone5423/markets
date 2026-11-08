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

// Yield for a money market fund such as FZCXX. Tries Yahoo's own yield field first, then
// annualizes the most recent monthly payout (payout x 12 / price).
async function fetchFundYield(sym) {
  try {
    const s = await getSession();
    const r = await fetch(
      'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(sym) + '?modules=summaryDetail&crumb=' + encodeURIComponent(s.crumb),
      { headers: { 'User-Agent': UA, Cookie: s.cookie } }
    );
    if (r.ok) {
      const d = ((await r.json()).quoteSummary.result || [])[0];
      const y = d && d.summaryDetail && d.summaryDetail.yield;
      const v = y && typeof y === 'object' ? y.raw : y;
      if (typeof v === 'number' && v > 0) return { yield: v * 100, src: 'yahoo' };
    }
  } catch (e) {}
  const r = await fetch(
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=6mo&interval=1d&events=div',
    { headers: { 'User-Agent': UA } }
  );
  const res = (await r.json()).chart.result[0];
  const divs = Object.values((res.events && res.events.dividends) || {}).sort((a, b) => a.date - b.date);
  const last = divs[divs.length - 1], px = res.meta.regularMarketPrice;
  if (!last || !px) throw new Error('no payout data');
  return { yield: last.amount * 12 / px * 100, src: 'payout', date: new Date(last.date * 1000).toISOString().slice(0, 10) };
}

// ---- Markets by country (Home page) ----------------------------------------
// One headline stock index per country. Changes are price changes in local currency.
const COUNTRIES = [
  ['United States', 'S&P 500', '^GSPC'], ['Canada', 'S&P/TSX', '^GSPTSE'], ['Mexico', 'IPC', '^MXX'], ['Brazil', 'Bovespa', '^BVSP'],
  ['United Kingdom', 'FTSE 100', '^FTSE'], ['Germany', 'DAX', '^GDAXI'], ['France', 'CAC 40', '^FCHI'], ['Netherlands', 'AEX', '^AEX'],
  ['Switzerland', 'SMI', '^SSMI'], ['Spain', 'IBEX 35', '^IBEX'], ['Italy', 'FTSE MIB', 'FTSEMIB.MI'],
  ['Japan', 'Nikkei 225', '^N225'], ['China', 'Shanghai Composite', '000001.SS'], ['Hong Kong', 'Hang Seng', '^HSI'],
  ['India', 'BSE Sensex', '^BSESN'], ['South Korea', 'KOSPI', '^KS11'], ['Taiwan', 'TAIEX', '^TWII'],
  ['Australia', 'ASX 200', '^AXJO'], ['Singapore', 'Straits Times', '^STI']
];

async function countryRow([country, index, sym]) {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=10y&interval=1d', { headers: { 'User-Agent': UA } });
  const res = (await r.json()).chart.result[0];
  const ts = res.timestamp || [], cl = (res.indicators.quote[0] || {}).close || [];
  const bars = [];
  ts.forEach((t, i) => { if (typeof cl[i] === 'number' && isFinite(cl[i])) bars.push([t * 1000, cl[i]]); });
  if (bars.length < 3) throw new Error('no data');
  const last = bars[bars.length - 1];
  const px = num(res.meta.regularMarketPrice) ?? last[1];
  // Close on or just before the date this long ago; null when the index has less history than that.
  const back = (years, days) => {
    const d = new Date(last[0]);
    if (years) d.setUTCFullYear(d.getUTCFullYear() - years); else d.setUTCDate(d.getUTCDate() - days);
    if (bars[0][0] > d.getTime() + 10 * 86400000) return null;
    let v = null;
    for (const b of bars) { if (b[0] <= d.getTime()) v = b[1]; else break; }
    return v;
  };
  const chg = base => (base ? (px / base - 1) * 100 : null);
  return {
    country, index, s: sym, price: px,
    day: chg(bars[bars.length - 2][1]) === null ? null : chg(bars[bars.length - 2][1]),
    week: chg(back(0, 7)), y1: chg(back(1)), y5: chg(back(5)), y10: chg(back(10)),
    asOf: new Date(last[0]).toISOString().slice(0, 10)
  };
}

let countriesCache = null;
async function getCountries() {
  if (countriesCache && Date.now() - countriesCache.t < 600000) return countriesCache.d;
  const rows = (await Promise.all(COUNTRIES.map(c => countryRow(c).catch(() => ({ country: c[0], index: c[1], s: c[2], failed: true }))))).filter(Boolean);
  if (rows.every(x => x.failed)) throw new Error('no country data');
  const d = { asOf: new Date().toISOString(), rows };
  countriesCache = { t: Date.now(), d };
  return d;
}

// ---- Gurus page ---------------------------------------------------------------
// Holdings: public 13F data as shown on dataroma.com. Letters: news search. Podcasts: Apple Podcasts search.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const textOf = h => h.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  const d = await fn();
  cache.set(key, { t: Date.now(), d });
  return d;
}

function parseDataroma(html) {
  const period = (html.match(/Period:\s*(Q\d\s*\d{4})/i) || [])[1] || null;
  const date = (html.match(/Portfolio date:\s*(\d{1,2}\s+\w+\s+\d{4})/i) || [])[1] || null;
  const holdings = [];
  for (const row of html.split(/<tr[^>]*>/i).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => textOf(m[1]));
    const si = cells.findIndex(c => /^[A-Z0-9][A-Z0-9.\-]{0,9}\s+-\s+\S/.test(c));
    if (si < 0) continue;
    const m = cells[si].match(/^([A-Z0-9][A-Z0-9.\-]{0,9})\s+-\s+(.+)$/);
    const rest = cells.slice(si + 1);
    const pct = parseFloat((rest.find(c => /^\d+(\.\d+)?$/.test(c)) || ''));
    const act = rest.find(c => /^(Add|Reduce|Buy|Sell|New)\b/i.test(c)) || '';
    const shares = parseInt(((rest.find(c => /^\d{1,3}(,\d{3})+$/.test(c))) || '').replace(/,/g, ''), 10);
    if (!isFinite(pct)) continue;
    holdings.push({ s: m[1], n: m[2], pct, act, shares: isFinite(shares) ? shares : null });
  }
  return { period, date, holdings };
}

async function getGuruHoldings(code) {
  return cached('h:' + code, 6 * 3600000, async () => {
    const r = await fetch('https://www.dataroma.com/m/holdings.php?m=' + encodeURIComponent(code), { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } });
    if (!r.ok) throw new Error('Dataroma HTTP ' + r.status);
    const d = parseDataroma(await r.text());
    if (!d.holdings.length) throw new Error('no holdings found for code ' + code);
    return d;
  });
}

function parseRss(xml) {
  const tag = (s, t) => { const m = s.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>', 'i')); return m ? textOf(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : ''; };
  return xml.split(/<item>/i).slice(1).map(it => ({
    title: tag(it, 'title'), link: tag(it, 'link'), source: tag(it, 'source'), t: Date.parse(tag(it, 'pubDate')) || null
  })).filter(x => x.title && x.link);
}

async function getGuruNews(name) {
  return cached('n:' + name.toLowerCase(), 3600000, async () => {
    const last = name.trim().split(/\s+/).pop().toLowerCase();
    const q = '"' + name + '" (letter OR "shareholder letter" OR "investor letter" OR "annual letter" OR "quarterly letter")';
    const [news, pod] = await Promise.all([
      fetch('https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=' + encodeURIComponent(q + ' when:365d'), { headers: { 'User-Agent': BROWSER_UA } })
        .then(r => r.text()).then(parseRss).catch(() => []),
      fetch('https://itunes.apple.com/search?media=podcast&entity=podcastEpisode&limit=40&term=' + encodeURIComponent(name), { headers: { 'User-Agent': BROWSER_UA } })
        .then(r => r.json()).then(j => j.results || []).catch(() => [])
    ]);
    const nameRe = new RegExp('\\b' + name.trim().split(/\s+/)[0].toLowerCase() + '\\b.*\\b' + last + '\\b|\\b' + last + '\\b', 'i');
    const letters = news.filter(x => nameRe.test(x.title) && /letter/i.test(x.title)).sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 5)
      .map(x => ({ title: x.title, url: x.link, source: x.source, t: x.t }));
    const podcasts = pod.filter(e => e.trackName && new RegExp('\\b' + last + '\\b', 'i').test(e.trackName + ' ' + (e.description || '')))
      .sort((a, b) => Date.parse(b.releaseDate) - Date.parse(a.releaseDate)).slice(0, 5)
      .map(e => ({ title: e.trackName, show: e.collectionName, url: e.trackViewUrl, t: Date.parse(e.releaseDate) || null }));
    return { letters, podcasts };
  });
}

// Generic "follow this page" source: an RSS/Atom feed, a page that advertises one, or a page of links.
function parseFeed(xml) {
  const tag = (s, t) => { const m = s.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>', 'i')); return m ? textOf(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : ''; };
  const out = [];
  for (const it of xml.split(/<item[\s>]/i).slice(1)) {
    const link = tag(it, 'link') || (it.match(/<enclosure[^>]+url="([^"]+)"/i) || [])[1] || '';
    out.push({ title: tag(it, 'title'), url: link, t: Date.parse(tag(it, 'pubDate')) || null });
  }
  if (!out.length) {
    for (const it of xml.split(/<entry[\s>]/i).slice(1)) {
      const link = (it.match(/<link[^>]+rel="alternate"[^>]*href="([^"]+)"/i) || it.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
      out.push({ title: tag(it, 'title'), url: link, t: Date.parse(tag(it, 'published') || tag(it, 'updated')) || null });
    }
  }
  return out.filter(x => x.title && x.url);
}

function pageLinks(html, base, kind) {
  const seen = new Set(), out = [];
  const re = kind === 'letters'
    ? /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    : /<h[1-4][^>]*>\s*<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    let u; try { u = new URL(m[1].replace(/&amp;/g, '&'), base).href; } catch (e) { continue; }
    let title = textOf(m[2]);
    if (!/^https?:/.test(u) || seen.has(u) || !title) continue;
    if (kind === 'letters' && !/letter|ltr|annual|quarter|shareholder|\.pdf/i.test(title + ' ' + u)) continue;
    if (kind !== 'letters' && title.length < 12) continue;
    if (/^\d{4}$/.test(title)) title = 'Letter ' + title;
    seen.add(u); out.push({ title, url: u, t: null });
  }
  return out.slice(0, 30);
}

async function getSource(src, kind) {
  return cached('s:' + kind + ':' + src, 3600000, async () => {
    const get = async u => {
      const r = await fetch(u, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xml,application/rss+xml,*/*' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { type: r.headers.get('content-type') || '', text: (await r.text()).slice(0, 2000000) };
    };
    const first = await get(src);
    const isXml = /xml|rss|atom/i.test(first.type) || /^\s*<\?xml|^\s*<rss|^\s*<feed/i.test(first.text);
    if (isXml) { const items = parseFeed(first.text).slice(0, 10); return { via: 'feed', items }; }
    if (kind !== 'letters') {
      for (const tg of first.text.match(/<link\b[^>]*>/gi) || []) {
        if (/alternate/i.test(tg) && /(rss|atom)\+xml/i.test(tg)) {
          const href = (tg.match(/href=["']([^"']+)["']/i) || [])[1];
          if (href) {
            try {
              const f = await get(new URL(href, src).href);
              const items = parseFeed(f.text).slice(0, 10);
              if (items.length) return { via: 'feed', items };
            } catch (e) {}
          }
        }
      }
    }
    const items = pageLinks(first.text, src, kind).slice(0, 10);
    if (!items.length) throw new Error('no links found on that page');
    return { via: 'page', items };
  });
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

    if (url.searchParams.get('fundyield')) {
      const sym = url.searchParams.get('fundyield');
      if (!/^[A-Za-z0-9.\-]{1,10}$/.test(sym)) return new Response('{}', { status: 400, headers });
      const y = await fetchFundYield(sym).catch(e => ({ error: String(e.message || e) }));
      return new Response(JSON.stringify(y), { headers });
    }

    if (url.searchParams.get('countries')) {
      try {
        return new Response(JSON.stringify(await getCountries()), { headers: { ...headers, 'cache-control': 'public, max-age=300' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { headers });
      }
    }

    if (url.searchParams.get('guru')) {
      const code = url.searchParams.get('guru');
      if (!/^[A-Za-z0-9_\-]{1,20}$/.test(code)) return new Response('{}', { status: 400, headers });
      const d = await getGuruHoldings(code).catch(e => ({ error: String(e.message || e) }));
      return new Response(JSON.stringify(d), { headers: { ...headers, 'cache-control': 'public, max-age=3600' } });
    }

    if (url.searchParams.get('gurunews')) {
      const name = url.searchParams.get('gurunews').slice(0, 60);
      if (!/^[\p{L}.' \-]{2,60}$/u.test(name)) return new Response('{}', { status: 400, headers });
      const d = await getGuruNews(name).catch(e => ({ error: String(e.message || e) }));
      return new Response(JSON.stringify(d), { headers: { ...headers, 'cache-control': 'public, max-age=1800' } });
    }

    if (url.searchParams.get('source')) {
      const src = url.searchParams.get('source'), kind = url.searchParams.get('kind') || 'posts';
      let host = '';
      try { const u = new URL(src); host = u.protocol === 'https:' ? u.hostname : ''; } catch (e) {}
      if (!host || !/\.[a-z]{2,}$/i.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !['letters', 'posts', 'podcast'].includes(kind)) {
        return new Response(JSON.stringify({ error: 'needs a public https address' }), { status: 400, headers });
      }
      const d = await getSource(src, kind).catch(e => ({ error: String(e.message || e) }));
      return new Response(JSON.stringify(d), { headers: { ...headers, 'cache-control': 'public, max-age=1800' } });
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
