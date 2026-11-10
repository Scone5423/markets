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

// Daily FRED series (e.g. DGS2, the 2-year Treasury yield): latest, previous day and a year ago.
async function fetchFredDaily(id) {
  const r = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('FRED HTTP ' + r.status);
  const rows = (await r.text()).trim().split(/\r?\n/).slice(1).map(l => l.split(','))
    .filter(x => x.length >= 2 && isFinite(parseFloat(x[1])));
  if (rows.length < 2) throw new Error('no data');
  const a = rows[rows.length - 1], b = rows[rows.length - 2];
  const cut = new Date(a[0] + 'T00:00:00Z'); cut.setUTCFullYear(cut.getUTCFullYear() - 1);
  const cs = cut.toISOString().slice(0, 10);
  let y = null; for (let i = rows.length - 1; i >= 0; i--) if (rows[i][0] <= cs) { y = rows[i]; break; }
  return { rate: parseFloat(a[1]), prev: parseFloat(b[1]), date: a[0], yago: y ? parseFloat(y[1]) : null };
}

// ---- Pabrai Wagons ETF (WAGN): documents from wagonsetf.com/ir and holdings from StockAnalysis ----
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
function dateFromText(s) {
  let m = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i.exec(s);
  if (m) return Date.UTC(+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2], 12);
  m = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i.exec(s);
  if (m) return Date.UTC(+m[2], MONTHS.indexOf(m[1].toLowerCase()), 15, 12);
  m = /\b(\d{1,2})\.(\d{1,2})\.(20\d{2}|\d{2})\b/.exec(s);
  if (m) return Date.UTC(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2], 12);
  return null;
}
async function getWagn() {
  return cached('wagn', 1800000, async () => {
    const out = {};
    try {
      const r = await fetch('https://www.wagonsetf.com/ir', { headers: { 'User-Agent': BROWSER_UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = (await r.text()).slice(0, 2000000), seen = new Set(), docs = [];
      for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        let u; try { u = new URL(m[1].replace(/&amp;/g, '&'), 'https://www.wagonsetf.com/ir').href; } catch (e) { continue; }
        if (!/b-cdn\.net|sec\.gov\/Archives|prnewswire\.com|wagonsetf\.com\/(investor-call|semi-annual)/i.test(u) || seen.has(u)) continue;
        let title = textOf(m[2]).replace(/\s+/g, ' ').trim();
        let fname = ''; try { fname = decodeURIComponent(u.split('?')[0].split('/').pop()).replace(/\.(pdf|xml|html?)$/i, '').replace(/[-_]+/g, ' ').trim(); } catch (e) {}
        if (title.length < 12 || /^(download|view|read|pdf|listen|watch|link)\b/i.test(title)) title = fname || title;
        if (!title) continue;
        const t = dateFromText(title) || dateFromText(fname) || null;
        const type = /replay/i.test(title + u) ? 'Replay' : /call/i.test(title + u) ? 'Investor call' : /press|prnewswire/i.test(title + u) ? 'Press release' : /holdings|SOI/i.test(title + u) ? 'Holdings' : /prospectus|SAI/i.test(title + u) ? 'Prospectus' : /letter/i.test(title) ? 'Letter' : /fact ?sheet/i.test(title) ? 'Fact sheet' : /presentation/i.test(title) ? 'Presentation' : 'Report';
        seen.add(u); docs.push({ title, type, url: u, t });
      }
      out.documents = docs.slice(0, 80);
    } catch (e) { out.docError = String(e.message || e); }
    try {
      const r = await fetch('https://stockanalysis.com/etf/wagn/holdings/', { headers: { 'User-Agent': BROWSER_UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = await r.text(), rows = [];
      for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const c = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x => textOf(x[1]).trim());
        if (c.length < 4 || !/%/.test(c[3])) continue;
        const pct = parseFloat(c[3]); if (!isFinite(pct)) continue;
        let sym = c[2] || '';
        if (!sym || /^n\/a$/i.test(sym)) { rows.push({ s: '', n: c[1], pct }); continue; }
        let m;
        if ((m = /^(NSE|BSE):(.+)$/.exec(sym))) sym = m[2] + (m[1] === 'NSE' ? '.NS' : '.BO');
        else if ((m = /^TSXV:(.+)$/.exec(sym))) sym = m[1] + '.V';
        else if ((m = /^TSX:(.+)$/.exec(sym))) sym = m[1] + '.TO';
        else if ((m = /^OSL:(.+)$/.exec(sym))) sym = m[1] + '.OL';
        else if ((m = /^WSE:(.+)$/.exec(sym))) sym = m[1] + '.WA';
        else sym = sym.replace(/\.E\.IS$/, '.IS');
        rows.push({ s: sym, n: c[1], pct });
      }
      const asOf = (/Updated\s+([A-Z][a-z]{2}\s+\d{1,2},\s+20\d{2})/.exec(textOf(html)) || [])[1] || '';
      if (rows.length >= 10) { out.holdings = rows; out.asOf = asOf; } else out.holdError = 'table not found';
    } catch (e) { out.holdError = String(e.message || e); }
    return out;
  });
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

// New positions ("Buy") in the two most recent reported quarters, from Dataroma's activity page.
function parseNewBuys(html) {
  const quarters = [], buys = [];
  let q = null;
  for (const row of html.split(/<tr[^>]*>/i).slice(1)) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => textOf(m[1]));
    const joined = cells.join(' ');
    const si = cells.findIndex(c => /^[A-Z0-9][A-Z0-9.\-]{0,9}\s+-\s+\S/.test(c));
    if (si < 0) {
      const m = joined.match(/\bQ([1-4])\s+(\d{4})\b/);
      if (m && joined.length < 40) { q = 'Q' + m[1] + ' ' + m[2]; if (!quarters.includes(q)) quarters.push(q); }
      continue;
    }
    if (!q || quarters.indexOf(q) > 1) continue;
    const act = cells.slice(si + 1).find(c => /^(Add|Reduce|Buy|Sell)\b/i.test(c)) || '';
    if (!/^Buy\b/i.test(act)) continue;
    const m = cells[si].match(/^([A-Z0-9][A-Z0-9.\-]{0,9})\s+-\s+(.+)$/);
    const pct = parseFloat(cells[cells.length - 1]);
    buys.push({ s: m[1], n: m[2], q, pct: isFinite(pct) ? pct : null });
  }
  return { quarters: quarters.slice(0, 2), buys };
}

async function getGuruHoldings(code) {
  return cached('h:' + code, 6 * 3600000, async () => {
    const get = p => fetch('https://www.dataroma.com/m/' + p + '?m=' + encodeURIComponent(code) + (p.startsWith('m_activity') ? '&typ=a' : ''), { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } });
    const [r, ra] = await Promise.all([get('holdings.php'), get('m_activity.php').catch(() => null)]);
    if (!r.ok) throw new Error('Dataroma HTTP ' + r.status);
    const d = parseDataroma(await r.text());
    if (!d.holdings.length) throw new Error('no holdings found for code ' + code);
    d.newBuys = null;
    if (ra && ra.ok) { try { const nb = parseNewBuys(await ra.text()); if (nb.quarters.length) d.newBuys = nb; } catch (e) {} }
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
    const [news, pod, arts] = await Promise.all([
      fetch('https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=' + encodeURIComponent(q + ' when:365d'), { headers: { 'User-Agent': BROWSER_UA } })
        .then(r => r.text()).then(parseRss).catch(() => []),
      fetch('https://itunes.apple.com/search?media=podcast&entity=podcastEpisode&limit=40&term=' + encodeURIComponent(name), { headers: { 'User-Agent': BROWSER_UA } })
        .then(r => r.json()).then(j => j.results || []).catch(() => []),
      fetch('https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=' + encodeURIComponent('"' + name + '" when:90d'), { headers: { 'User-Agent': BROWSER_UA } })
        .then(r => r.text()).then(parseRss).catch(() => [])
    ]);
    const nameRe = new RegExp('\\b' + name.trim().split(/\s+/)[0].toLowerCase() + '\\b.*\\b' + last + '\\b|\\b' + last + '\\b', 'i');
    const articles = arts.filter(x => new RegExp('\\b' + last + '\\b', 'i').test(x.title)).sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 8)
      .map(x => ({ title: x.title, url: x.link, source: x.source, t: x.t }));
    const letters = news.filter(x => nameRe.test(x.title) && /letter/i.test(x.title)).sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 5)
      .map(x => ({ title: x.title, url: x.link, source: x.source, t: x.t }));
    const podcasts = pod.filter(e => e.trackName && new RegExp('\\b' + last + '\\b', 'i').test(e.trackName + ' ' + (e.description || '')))
      .sort((a, b) => Date.parse(b.releaseDate) - Date.parse(a.releaseDate)).slice(0, 5)
      .map(e => ({ title: e.trackName, show: e.collectionName, url: e.trackViewUrl, t: Date.parse(e.releaseDate) || null }));
    return { letters, podcasts, articles };
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

function pageLinks(html, base, kind, match) {
  const seen = new Set(), out = [];
  const re = kind === 'letters' || match
    ? /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    : /<h[1-4][^>]*>\s*<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    let u; try { u = new URL(m[1].replace(/&amp;/g, '&'), base).href; } catch (e) { continue; }
    let title = textOf(m[2]);
    if (!/^https?:/.test(u) || seen.has(u) || !title) continue;
    if (match && !u.includes(match)) continue;
    if (!match && kind === 'letters' && !/letter|ltr|annual|quarter|shareholder|\.pdf/i.test(title + ' ' + u)) continue;
    if (!match && kind !== 'letters' && title.length < 12) continue;
    // Pick up a date like 11/4/2026 shown in or just after the link.
    const near = m[0] + html.slice(m.index + m[0].length, m.index + m[0].length + 300);
    const dm = textOf(near).match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
    const t = dm ? Date.UTC(+dm[3], +dm[1] - 1, +dm[2]) : null;
    title = title.replace(/\s*\b\d{1,2}\/\d{1,2}\/20\d{2}\b.*$/, '').trim() || title;
    if (/^\d{4}$/.test(title)) title = 'Letter ' + title;
    seen.add(u); out.push({ title, url: u, t });
  }
  if (out.some(x => x.t)) out.sort((a, b) => (b.t || 0) - (a.t || 0));
  // Letters pages: keep the entries that start with a year ("2025 SAI Letter: ..."), newest year first, and drop menu links.
  if (kind === 'letters' && !match) {
    const yr = x => (x.title.match(/^(?:Letter )?((?:19|20)\d{2})\b/) || [])[1];
    const seenYr = new Set();
    const dated = out.filter(x => { const y = yr(x); if (!y || seenYr.has(y)) return false; seenYr.add(y); return true; });
    if (dated.length) return dated.sort((a, b) => yr(b) - yr(a)).slice(0, 30);
  }
  return out.filter(x => x.url.split('#')[0] !== base.split('#')[0] && !/^(home|about( us)?|contact( us)?|products\/services|client letters|interviews and podcasts)$/i.test(x.title)).slice(0, 30);
}

async function getSource(src, kind, match) {
  return cached('s:' + kind + ':' + src + ':' + (match || ''), 3600000, async () => {
    const get = async u => {
      const r = await fetch(u, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xml,application/rss+xml,*/*' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { type: r.headers.get('content-type') || '', text: (await r.text()).slice(0, 2000000) };
    };
    const first = await get(src);
    const isXml = /xml|rss|atom/i.test(first.type) || /^\s*<\?xml|^\s*<rss|^\s*<feed/i.test(first.text);
    if (isXml) { const items = parseFeed(first.text).slice(0, 10); return { via: 'feed', items }; }
    if (kind !== 'letters' && !match) {
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
    const items = pageLinks(first.text, src, kind, match).slice(0, 10);
    if (!items.length) throw new Error('no links found on that page');
    return { via: 'page', items };
  });
}

// ---- 13F holdings straight from the SEC (EDGAR) -----------------------------------
// Dataroma blocks Cloudflare, so holdings come from each manager's own 13F filings.
const SEC_UA = 'PersonalMarketsDashboard/1.0 (personal, non-commercial use)';
const secGet = async url => {
  const r = await fetch(url, { headers: { 'User-Agent': SEC_UA, Accept: 'application/json,text/xml,*/*' } });
  if (!r.ok) throw new Error('SEC HTTP ' + r.status);
  return r;
};
const quarterOf = d => { const m = /^(\d{4})-(\d{2})/.exec(d); return m ? 'Q' + Math.ceil(+m[2] / 3) + ' ' + m[1] : d; };

async function infoTable(cik, acc) {
  const dir = 'https://www.sec.gov/Archives/edgar/data/' + parseInt(cik, 10) + '/' + acc.replace(/-/g, '') + '/';
  const idx = await (await secGet(dir + 'index.json')).json();
  const files = ((idx.directory || {}).item || []).map(i => i.name);
  const file = files.find(n => /infotable.*\.xml$/i.test(n)) || files.find(n => /\.xml$/i.test(n) && !/primary_doc/i.test(n));
  if (!file) throw new Error('no holdings table in filing');
  const xml = await (await secGet(dir + file)).text();
  const pos = new Map();
  for (const m of xml.matchAll(/<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/gi)) {
    const b = m[1], f = t => ((b.match(new RegExp('<(?:\\w+:)?' + t + '>([^<]*)<', 'i')) || [])[1] || '').trim();
    if (f('putCall')) continue;                       // skip options
    const cusip = f('cusip').toUpperCase(), value = parseFloat(f('value')), sh = parseFloat(f('sshPrnamt'));
    if (!cusip || !isFinite(value)) continue;
    const p = pos.get(cusip) || { cusip, n: textOf(f('nameOfIssuer')), value: 0, shares: 0 };
    p.value += value; p.shares += isFinite(sh) ? sh : 0;
    pos.set(cusip, p);
  }
  if (!pos.size) throw new Error('empty holdings table');
  const total = [...pos.values()].reduce((a, p) => a + p.value, 0);
  return { pos, total };
}

const tickerCache = new Map();
async function tickersFor(cusips) {
  const need = cusips.filter(c => !tickerCache.has(c));
  for (let i = 0; i < need.length; i += 10) {
    const batch = need.slice(i, i + 10);
    try {
      const r = await fetch('https://api.openfigi.com/v3/mapping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map(c => ({ idType: 'ID_CUSIP', idValue: c, exchCode: 'US' })))
      });
      const j = await r.json();
      batch.forEach((c, k) => {
        const rows = (j[k] && j[k].data) || [];
        const pick = rows.find(x => /common|depositary|reit|adr/i.test(x.securityType || '')) || rows[0];
        tickerCache.set(c, pick && pick.ticker ? pick.ticker.replace('/', '-') : '');
      });
    } catch (e) { /* leave unmapped; the page shows the name without a chart link */ }
  }
  return Object.fromEntries(cusips.map(c => [c, tickerCache.get(c) || '']));
}

async function getFiler(cik) {
  return cached('f:' + cik, 6 * 3600000, async () => {
    const id = String(parseInt(cik, 10)).padStart(10, '0');
    const sub = await (await secGet('https://data.sec.gov/submissions/CIK' + id + '.json')).json();
    const rec = (sub.filings || {}).recent || {};
    const filings = [];
    (rec.form || []).forEach((f, i) => { if (f === '13F-HR') filings.push({ acc: rec.accessionNumber[i], report: rec.reportDate[i], filed: rec.filingDate[i] }); });
    filings.sort((a, b) => b.report.localeCompare(a.report));
    if (!filings.length) throw new Error('no 13F filings found');
    const tables = await Promise.all(filings.slice(0, 3).map(f => infoTable(cik, f.acc).catch(() => null)));
    const cur = tables[0];
    if (!cur) throw new Error('could not read the latest 13F');
    const prev = tables[1], old = tables[2] || tables[1];
    const top = [...cur.pos.values()].sort((a, b) => b.value - a.value);
    const newPos = old ? top.filter(p => !old.pos.has(p.cusip)) : [];
    const syms = await tickersFor([...top.slice(0, 10), ...newPos].map(p => p.cusip));
    const act = p => {
      if (!prev) return '';
      const q = prev.pos.get(p.cusip);
      if (!q) return 'New';
      const ch = (p.shares / q.shares - 1) * 100;
      return Math.abs(ch) < 1 ? '' : (ch > 0 ? 'Add ' : 'Reduce ') + Math.abs(ch).toFixed(0) + '%';
    };
    return {
      period: quarterOf(filings[0].report), date: filings[0].report, filed: filings[0].filed, source: 'SEC 13F',
      holdings: top.slice(0, 10).map(p => ({ s: syms[p.cusip] || '', n: p.n, pct: p.value / cur.total * 100, act: act(p), shares: p.shares })),
      newBuys: old ? {
        quarters: [quarterOf(filings[0].report), quarterOf((filings[1] || filings[0]).report)],
        buys: newPos.sort((a, b) => b.value - a.value).slice(0, 12).map(p => ({
          s: syms[p.cusip] || '', n: p.n, pct: p.value / cur.total * 100,
          q: quarterOf((prev && !prev.pos.has(p.cusip) ? filings[0] : filings[1] || filings[0]).report)
        }))
      } : null
    };
  });
}

// ---- Insider filings (Forms 3/4/5) for people whose funds file no 13F ------------------
async function getInsider(cik) {
  return cached('i:' + cik, 6 * 3600000, async () => {
    const id = String(parseInt(cik, 10)).padStart(10, '0');
    const sub = await (await secGet('https://data.sec.gov/submissions/CIK' + id + '.json')).json();
    const rec = (sub.filings || {}).recent || {};
    const docs = [];
    (rec.form || []).forEach((f, i) => { if (f === '4' || f === '5') docs.push({ acc: rec.accessionNumber[i], doc: rec.primaryDocument[i], filed: rec.filingDate[i] }); });
    docs.sort((a, b) => b.filed.localeCompare(a.filed));
    const xmls = await Promise.all(docs.slice(0, 14).map(async d => {
      try {
        const u = 'https://www.sec.gov/Archives/edgar/data/' + parseInt(cik, 10) + '/' + d.acc.replace(/-/g, '') + '/' + d.doc.replace(/^xsl[^/]*\//, '');
        return { d, x: await (await secGet(u)).text() };
      } catch (e) { return null; }
    }));
    const issuers = new Map();
    for (const f of xmls.filter(Boolean)) {
      const sym = ((f.x.match(/<issuerTradingSymbol>([^<]*)</i) || [])[1] || '').trim();
      const name = textOf((f.x.match(/<issuerName>([^<]*)</i) || [])[1] || '');
      if (!sym) continue;
      const it = issuers.get(sym) || { symbol: sym, name, trades: [], position: null, asOf: null };
      for (const m of f.x.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)) {
        const b = m[1], g = (t) => ((b.match(new RegExp('<' + t + '>\\s*(?:<value>)?([^<]*)', 'i')) || [])[1] || '').trim();
        const sh = parseFloat(g('transactionShares')), px = parseFloat(g('transactionPricePerShare')), after = parseFloat(g('sharesOwnedFollowingTransaction'));
        const date = g('transactionDate');
        if (!isFinite(sh) || !date) continue;
        it.trades.push({ date, act: g('transactionAcquiredDisposedCode') === 'D' ? 'Sell' : 'Buy', shares: sh, price: isFinite(px) ? px : null });
        if (isFinite(after) && (!it.asOf || date > it.asOf || (date === it.asOf && after > it.position))) { it.position = after; it.asOf = date; }
      }
      issuers.set(sym, it);
    }
    const out = [];
    for (const it of issuers.values()) {
      const seen = new Set();
      it.trades = it.trades.filter(t => { const k = t.date + t.act + t.shares; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
      const px = await fetchChart(it.symbol).then(m => num(m.regularMarketPrice)).catch(() => null);
      out.push({ ...it, price: px, value: px && it.position ? px * it.position : null });
    }
    if (!out.length) throw new Error('no insider transactions found');
    return { source: 'SEC Forms 4/5', issuers: out };
  });
}

// ---- Recent posts from an X (Twitter) account, via X's public embed timeline --------------
async function getTweets(handle) {
  return cached('t:' + handle.toLowerCase(), 1800000, async () => {
    const r = await fetch('https://syndication.twitter.com/srv/timeline-profile/screen-name/' + encodeURIComponent(handle), {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' }
    });
    if (!r.ok) throw new Error('X HTTP ' + r.status);
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) throw new Error('X returned no timeline');
    const data = JSON.parse(m[1]);
    const entries = (((data.props || {}).pageProps || {}).timeline || {}).entries || [];
    const out = [];
    for (const e of entries) {
      const t = e && e.content && e.content.tweet;
      if (!t || !t.full_text && !t.text) continue;
      const text = textOf(String(t.full_text || t.text)).replace(/https:\/\/t\.co\/\w+/g, '').trim();
      if (!text || /^RT @/.test(text)) continue;
      const id = t.id_str || e.entry_id && String(e.entry_id).replace(/\D/g, '');
      out.push({ text: text.slice(0, 280), url: 'https://x.com/' + handle + '/status/' + id, t: Date.parse(t.created_at) || null });
    }
    if (!out.length) throw new Error('no posts found');
    return { posts: out.slice(0, 8) };
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


// ---- Stock screener (Screener page) ---------------------------------------
// Filters come in as simple query parameters and are turned into a Yahoo screener query.
const SCREEN_FIELDS = {
  pe_max: ['LT', 'peratio.lasttwelvemonths'], pe_min: ['GT', 'peratio.lasttwelvemonths'],
  pb_max: ['LT', 'pricebookratio.quarterly'],
  peg_max: ['LT', 'pegratio_5y'],
  roe_min: ['GT', 'returnonequity.lasttwelvemonths'],
  roa_min: ['GT', 'returnonassets.lasttwelvemonths'],
  margin_min: ['GT', 'netincomemargin.lasttwelvemonths'],
  de_max: ['LT', 'totaldebtequity.lasttwelvemonths'],
  revg_min: ['GT', 'quarterlyrevenuegrowth.quarterly'],
  epsg_min: ['GT', 'epsgrowth.lasttwelvemonths'],
  dy_min: ['GT', 'forward_dividend_yield'],
  mcap_min: ['GTE', 'intradaymarketcap'], mcap_max: ['LTE', 'intradaymarketcap'],
  price_min: ['GTE', 'intradayprice'],
  vol_min: ['GT', 'avgdailyvol3m'],
  chg52_max: ['LT', 'fiftytwowkpercentchange']
};
const SCREEN_SORTS = ['intradaymarketcap', 'peratio.lasttwelvemonths', 'pricebookratio.quarterly', 'returnonequity.lasttwelvemonths',
  'forward_dividend_yield', 'fiftytwowkpercentchange', 'percentchange', 'pegratio_5y'];
const SCREEN_SECTORS = ['Technology', 'Healthcare', 'Financial Services', 'Consumer Cyclical', 'Industrials', 'Energy', 'Utilities',
  'Real Estate', 'Basic Materials', 'Communication Services', 'Consumer Defensive'];
const SCREEN_REGIONS = ['us', 'ca', 'gb', 'de', 'fr', 'ch', 'nl', 'se', 'no', 'dk', 'fi', 'it', 'es', 'be', 'at', 'ie', 'pt', 'jp', 'kr', 'tw', 'hk', 'cn', 'sg', 'in', 'au', 'nz', 'br', 'mx', 'ar', 'cl', 'za', 'il', 'tr', 'pl'];
// Index membership. Yahoo's screener cannot filter by index, so we fetch the member list
// (Wikipedia tables or iShares fund holdings) and keep only matching rows.
const WIKI = 'https://en.wikipedia.org/wiki/';
const IDX_SOURCES = {
  sp500: { wiki: 'List_of_S%26P_500_companies' },
  dow: { wiki: 'Dow_Jones_Industrial_Average' },
  nasdaq100: { wiki: 'Nasdaq-100' },
  sp400: { wiki: 'List_of_S%26P_400_companies' },
  sp600: { wiki: 'List_of_S%26P_600_companies' },
  russell1000: { ishares: 'https://www.ishares.com/us/products/239707/ishares-russell-1000-etf/1467271812596.ajax?fileType=csv&fileName=IWB_holdings&dataType=fund' },
  russell2000: { ishares: 'https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/1467271812596.ajax?fileType=csv&fileName=IWM_holdings&dataType=fund' },
  russell3000: { ishares: 'https://www.ishares.com/us/products/239714/ishares-russell-3000-etf/1467271812596.ajax?fileType=csv&fileName=IWV_holdings&dataType=fund' }
};
const NASDAQ_LISTED = ['NMS', 'NGM', 'NCM'];
const cellText = h => h.replace(/<sup[\s\S]*?<\/sup>/g, '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#160;|&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const normSym = t => String(t || '').trim().toUpperCase().replace(/\./g, '-').replace(/[^A-Z0-9\-]/g, '');
function wikiSymbols(html) {
  const tables = [...html.matchAll(/<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/g)].map(m => m[1]);
  let best = [];
  for (const t of tables) {
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => cellText(c[2])));
    const head = rows.find(r => r.some(c => /^(symbol|ticker)$/i.test(c)));
    if (!head) continue;
    const col = head.findIndex(c => /^(symbol|ticker)$/i.test(c));
    const syms = rows.filter(r => r !== head && r.length > col).map(r => normSym(r[col])).filter(x => /^[A-Z][A-Z0-9\-]{0,5}$/.test(x));
    if (syms.length > best.length) best = syms;
  }
  return best;
}
function csvSymbols(text) {
  const lines = text.split(/\r?\n/);
  const hi = lines.findIndex(l => /^"?Ticker"?,/i.test(l));
  if (hi < 0) return [];
  const out = [];
  for (const l of lines.slice(hi + 1)) {
    const m = /^"([^"]+)"/.exec(l);
    if (!m) continue;
    const t = normSym(m[1]);
    if (/^[A-Z][A-Z0-9\-]{0,5}$/.test(t)) out.push(t);
  }
  return out;
}
async function getIndexMembers(code) {
  const src = IDX_SOURCES[code];
  if (!src) throw new Error('unknown index');
  return cached('idx:' + code, 86400000, async () => {
    let syms = [];
    if (src.wiki) {
      const r = await fetch(WIKI + src.wiki, { headers: { 'User-Agent': 'PersonalMarketsDashboard/1.0 (personal use)', Accept: 'text/html' } });
      if (!r.ok) throw new Error('index list HTTP ' + r.status);
      syms = wikiSymbols(await r.text());
    } else {
      const r = await fetch(src.ishares, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/csv,*/*' } });
      if (!r.ok) throw new Error('index list HTTP ' + r.status);
      syms = csvSymbols(await r.text());
    }
    const min = { sp500: 400, dow: 25, nasdaq100: 80, sp400: 300, sp600: 500, russell1000: 800, russell2000: 1500, russell3000: 2500 }[code];
    if (syms.length < min) throw new Error('could not read the ' + code + ' member list');
    return { symbols: [...new Set(syms)] };
  });
}
async function screenPage(operands, sortField, sortType, size, offset) {
  const s = await getSession();
  const r = await fetch(
    'https://query1.finance.yahoo.com/v1/finance/screener?lang=en-US&region=US&formatted=false&corsDomain=finance.yahoo.com&crumb=' + encodeURIComponent(s.crumb),
    {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Cookie: s.cookie },
      body: JSON.stringify({ size, offset, sortField, sortType, quoteType: 'EQUITY', userId: '', userIdType: 'guid',
        query: { operator: 'AND', operands } })
    }
  );
  if (!r.ok) {
    const t = (await r.text()).slice(0, 200).replace(/\s+/g, ' ');
    if (r.status === 401 || r.status === 403) session = null;
    throw new Error('screener HTTP ' + r.status + ' ' + t);
  }
  const res = ((await r.json()).finance || {}).result;
  if (!res || !res[0]) throw new Error('no screener result');
  return { quotes: res[0].quotes || [], total: res[0].total };
}
const screenRow = q => ({
  s: q.symbol, n: q.shortName || q.longName || '', x: q.fullExchangeName || q.exchange || '',
  p: q.regularMarketPrice, c: q.regularMarketChangePercent, mc: q.marketCap,
  pe: q.trailingPE, fpe: q.forwardPE, pb: q.priceToBook, eps: q.epsTrailingTwelveMonths,
  dy: q.dividendYield != null ? q.dividendYield : q.trailingAnnualDividendYield != null ? q.trailingAnnualDividendYield * 100 : null,
  lo: q.fiftyTwoWeekLow, hi: q.fiftyTwoWeekHigh, ch52: q.fiftyTwoWeekChangePercent,
  ar: q.averageAnalystRating || '', bv: q.bookValue
});

// Latest annual debt / cash / SBC for one symbol (used by the screener's balance-sheet filters).
async function getBal(sym) {
  return cached('bal:' + sym, 43200000, async () => {
    const now = Math.floor(Date.now() / 1000);
    const types = ['TotalDebt', 'CashCashEquivalentsAndShortTermInvestments', 'CashAndCashEquivalents', 'StockBasedCompensation'];
    const r = await fetch('https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/' + encodeURIComponent(sym) +
      '?type=' + types.map(t => 'annual' + t).join(',') + '&merge=false&padTimeSeries=false&period1=' + (now - 3 * 366 * 86400) + '&period2=' + (now + 86400),
      { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const out = {};
    for (const it of ((await r.json()).timeseries || {}).result || []) {
      const type = it.meta && it.meta.type && it.meta.type[0];
      const rows = type && it[type]; if (!rows) continue;
      let best = null;
      for (const row of rows) { const v = row && row.reportedValue && row.reportedValue.raw; if (typeof v === 'number' && row.asOfDate && (!best || row.asOfDate > best.d)) best = { d: row.asOfDate, v }; }
      if (best) out[type.replace(/^annual/, '')] = best.v;
    }
    return { debt: out.TotalDebt, cash: out.CashCashEquivalentsAndShortTermInvestments != null ? out.CashCashEquivalentsAndShortTermInvestments : out.CashAndCashEquivalents, sbc: out.StockBasedCompensation };
  });
}
const BAL_KEYS = ['debt_max', 'cash_min', 'sbc_max'];
async function enrichBal(rows, params, want) {
  const debtMax = params.get('debt_max'), cashMin = params.get('cash_min'), sbcMax = params.get('sbc_max');
  const cand = rows.slice(0, 120), out = [];
  for (let i = 0; i < cand.length; i += 10) {
    await Promise.all(cand.slice(i, i + 10).map(async r => {
      try { Object.assign(r, await getBal(r.s)); } catch (e) { r.balErr = String(e.message || e); }
    }));
  }
  for (const r of cand) {
    if (debtMax !== null && debtMax !== '' && !(typeof r.debt === 'number' && r.debt <= Number(debtMax))) continue;
    if (cashMin !== null && cashMin !== '' && !(typeof r.cash === 'number' && r.cash >= Number(cashMin))) continue;
    if (sbcMax !== null && sbcMax !== '' && typeof r.sbc === 'number' && r.sbc > Number(sbcMax)) continue;
    out.push(r);
  }
  return out;
}
async function runScreen(params) {
  const operands = [];
  const region = (params.get('region') || 'us').toLowerCase();
  if (region !== 'all') {
    if (!SCREEN_REGIONS.includes(region)) throw new Error('unknown country');
    operands.push({ operator: 'EQ', operands: ['region', region] });
  }
  for (const [k, [op, field]] of Object.entries(SCREEN_FIELDS)) {
    const raw = params.get(k);
    if (raw === null || raw === '') continue;
    const v = Number(raw);
    if (!isFinite(v)) throw new Error('bad value for ' + k);
    operands.push({ operator: op, operands: [field, v] });
  }
  if (params.get('pe_max') && !params.get('pe_min')) operands.push({ operator: 'GT', operands: ['peratio.lasttwelvemonths', 0] });
  const sector = params.get('sector');
  if (sector) {
    if (!SCREEN_SECTORS.includes(sector)) throw new Error('unknown sector');
    operands.push({ operator: 'EQ', operands: ['sector', sector] });
  }
  let sortField = params.get('sort') || 'intradaymarketcap';
  if (!SCREEN_SORTS.includes(sortField)) sortField = 'intradaymarketcap';
  const sortType = params.get('dir') === 'ASC' ? 'ASC' : 'DESC';
  const index = params.get('index') || '';
  if (index === 'nasdaq') {
    operands.push({ operator: 'IS-IN', operands: ['exchange', ...NASDAQ_LISTED] });
  }
  if (index && index !== 'nasdaq') {
    // Walk the filtered universe a page at a time and keep only index members.
    const members = new Set((await getIndexMembers(index)).symbols);
    const want = BAL_KEYS.some(k => params.get(k)) ? 120 : Math.min(Math.max(parseInt(params.get('size') || '100', 10) || 100, 10), 600);
    const rows = []; let total = null, pages = 0;
    for (let offset = 0; offset < 6000 && pages < 24 && rows.length < want; offset += 250, pages++) {
      const pg = await screenPage(operands, sortField, sortType, 250, offset);
      if (total === null) total = pg.total;
      for (const q of pg.quotes) if (members.has(normSym(q.symbol)) && rows.length < want) rows.push(screenRow(q));
      if (pg.quotes.length < 250) break;
    }
    return finishScreen({ total: rows.length, count: rows.length, members: members.size, rows }, params);
  }
  const size = BAL_KEYS.some(k => params.get(k)) ? 120 : Math.min(Math.max(parseInt(params.get('size') || '100', 10) || 100, 10), 250);
  const pg = await screenPage(operands, sortField, sortType, size, 0);
  return finishScreen({ total: pg.total, count: pg.quotes.length, rows: pg.quotes.map(screenRow) }, params);
}
async function finishScreen(res, params) {
  if (!BAL_KEYS.some(k => params.get(k))) return res;
  const before = res.rows.length;
  res.rows = await enrichBal(res.rows, params);
  res.checked = Math.min(before, 120); res.total = res.rows.length; res.count = res.rows.length;
  return res;
}

// ---- Basic financials for the Charts page ---------------------------------
const FIN_TYPES = ['TotalRevenue', 'GrossProfit', 'OperatingIncome', 'EBITDA', 'NetIncome', 'DilutedEPS',
  'CashAndCashEquivalents', 'TotalAssets', 'TotalDebt', 'TotalLiabilitiesNetMinorityInterest', 'StockholdersEquity',
  'OperatingCashFlow', 'CapitalExpenditure', 'FreeCashFlow', 'OrdinarySharesNumber', 'CashCashEquivalentsAndShortTermInvestments', 'StockBasedCompensation'];
const FIN_STATS = {
  financialData: ['currentPrice', 'targetMeanPrice', 'recommendationKey', 'totalCash', 'totalDebt', 'debtToEquity', 'currentRatio', 'quickRatio',
    'returnOnEquity', 'returnOnAssets', 'profitMargins', 'grossMargins', 'operatingMargins', 'ebitdaMargins', 'revenueGrowth', 'earningsGrowth', 'freeCashflow', 'operatingCashflow', 'totalRevenue'],
  defaultKeyStatistics: ['enterpriseValue', 'enterpriseToEbitda', 'enterpriseToRevenue', 'pegRatio', 'priceToBook', 'forwardPE', 'forwardEps', 'trailingEps',
    'bookValue', 'sharesOutstanding', 'floatShares', 'shortPercentOfFloat', 'beta', 'payoutRatio', 'heldPercentInsiders', 'heldPercentInstitutions'],
  summaryDetail: ['marketCap', 'trailingPE', 'priceToSalesTrailing12Months', 'dividendYield', 'dividendRate', 'fiftyTwoWeekHigh', 'fiftyTwoWeekLow', 'averageVolume']
};

// ---- Ten-year history from SEC filings (US filers), Yahoo fills gaps -------
let tickerMap = null, tickerMapAt = 0;
async function secCik(sym) {
  if (!tickerMap || Date.now() - tickerMapAt > 86400000) {
    const j = await (await secGet('https://www.sec.gov/files/company_tickers.json')).json();
    tickerMap = {};
    for (const k of Object.keys(j)) tickerMap[String(j[k].ticker).toUpperCase()] = j[k].cik_str;
    tickerMapAt = Date.now();
  }
  return tickerMap[sym.toUpperCase()] || tickerMap[sym.toUpperCase().replace('-', '.')] || tickerMap[sym.toUpperCase().replace('.', '-')] || null;
}
const DAY = 86400000;
function annualFacts(gaap, tags, unit, kind) {
  // returns {endDate: value} using 10-K style annual facts; latest filing wins
  for (const tag of tags) {
    const f = gaap[tag] && gaap[tag].units && gaap[tag].units[unit];
    if (!f) continue;
    const out = {}, filed = {};
    for (const x of f) {
      if (!/^10-K/.test(x.form || '') || typeof x.val !== 'number') continue;
      if (kind === 'dur') {
        if (!x.start) continue;
        const days = (Date.parse(x.end) - Date.parse(x.start)) / DAY;
        if (days < 340 || days > 390) continue;
      }
      if (!filed[x.end] || x.filed >= filed[x.end]) { out[x.end] = x.val; filed[x.end] = x.filed; }
    }
    if (Object.keys(out).length) return out;
  }
  return {};
}
async function getTen(sym, yahooYears) {
  const rows = {};
  const put = (d, k, v) => { if (typeof v === 'number' && isFinite(v)) (rows[d] = rows[d] || {})[k] = v; };
  let source = '';
  try {
    const cik = await secCik(sym);
    if (cik) {
      const j = await (await secGet('https://data.sec.gov/api/xbrl/companyfacts/CIK' + String(cik).padStart(10, '0') + '.json')).json();
      const g = (j.facts || {})['us-gaap'] || {}, dei = (j.facts || {}).dei || {};
      const eps = annualFacts(g, ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'], 'USD/shares', 'dur');
      const sbc = annualFacts(g, ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'], 'USD', 'dur');
      const cash1 = annualFacts(g, ['CashCashEquivalentsAndShortTermInvestments'], 'USD', 'inst');
      const cash2 = annualFacts(g, ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'], 'USD', 'inst');
      const sti = annualFacts(g, ['ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'], 'USD', 'inst');
      const dComb = annualFacts(g, ['DebtLongtermAndShorttermCombinedAmount'], 'USD', 'inst');
      const dNon = annualFacts(g, ['LongTermDebtNoncurrent'], 'USD', 'inst');
      const dCur = annualFacts(g, ['LongTermDebtCurrent', 'DebtCurrent'], 'USD', 'inst');
      const dShort = annualFacts(g, ['ShortTermBorrowings', 'CommercialPaper'], 'USD', 'inst');
      const dLt = annualFacts(g, ['LongTermDebt'], 'USD', 'inst');
      const sh = annualFacts(g, ['CommonStockSharesOutstanding'], 'shares', 'inst');
      const shCover = (() => { const f = (dei.EntityCommonStockSharesOutstanding || {}).units; const a = f && f.shares; const o = {}; (a || []).forEach(x => { if (/^10-K/.test(x.form || '')) o[x.end] = x.val; }); return o; })();
      const ends = [...new Set([...Object.keys(eps), ...Object.keys(sbc), ...Object.keys(cash1), ...Object.keys(cash2)])].sort();
      const fy = ends.filter(e => eps[e] !== undefined || sbc[e] !== undefined);
      for (const d of fy) {
        put(d, 'eps', eps[d]); put(d, 'sbc', sbc[d]);
        put(d, 'cash', cash1[d] !== undefined ? cash1[d] : cash2[d] !== undefined ? cash2[d] + (sti[d] || 0) : undefined);
        let debt;
        if (dComb[d] !== undefined) debt = dComb[d];
        else if (dNon[d] !== undefined || dCur[d] !== undefined) debt = (dNon[d] || 0) + (dCur[d] || 0) + (dCur[d] === undefined ? (dShort[d] || 0) : 0);
        else if (dLt[d] !== undefined) debt = dLt[d];
        put(d, 'debt', debt);
        let shares = sh[d];
        if (shares === undefined) {
          // cover-page count filed within ~5 months after the fiscal year end
          const t0 = Date.parse(d);
          const c = Object.keys(shCover).filter(e => Date.parse(e) >= t0 && Date.parse(e) - t0 < 150 * DAY).sort()[0];
          if (c) shares = shCover[c];
        }
        put(d, 'shares', shares);
      }
      if (Object.keys(rows).length) source = 'SEC filings';
    }
  } catch (e) { /* fall back to Yahoo below */ }
  // Yahoo fills missing years and fields
  const near = d => Object.keys(rows).find(r => Math.abs(Date.parse(r) - Date.parse(d)) < 20 * DAY);
  const map = { eps: 'DilutedEPS', shares: 'OrdinarySharesNumber', debt: 'TotalDebt', cash: 'CashCashEquivalentsAndShortTermInvestments', sbc: 'StockBasedCompensation' };
  let used = false;
  for (const [d, y] of Object.entries(yahooYears || {})) {
    let key = near(d) || d;
    for (const [k, yk] of Object.entries(map)) {
      if (typeof y[yk] === 'number' && !(rows[key] && typeof rows[key][k] === 'number')) { put(key, k, y[yk]); used = true; }
    }
  }
  if (used) source = source ? source + ' + Yahoo Finance' : 'Yahoo Finance';
  const list = Object.keys(rows).sort().reverse().slice(0, 10).map(d => ({ d, ...rows[d] }));
  return { source, rows: list };
}

async function getFin(sym) {
  return cached('fin:' + sym, 1800000, async () => {
    const out = { symbol: sym, stats: {}, years: {} };
    try {
      const s = await getSession();
      const r = await fetch('https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(sym) +
        '?modules=' + Object.keys(FIN_STATS).join(',') + '&crumb=' + encodeURIComponent(s.crumb), { headers: { 'User-Agent': UA, Cookie: s.cookie } });
      if (!r.ok) { if (r.status === 401 || r.status === 403) session = null; throw new Error('HTTP ' + r.status); }
      const res = ((await r.json()).quoteSummary.result || [])[0] || {};
      for (const [mod, keys] of Object.entries(FIN_STATS)) {
        for (const k of keys) {
          const v = res[mod] && res[mod][k];
          const raw = v && typeof v === 'object' ? v.raw : v;
          if (raw !== undefined && raw !== null && raw !== '') out.stats[k] = raw;
        }
      }
    } catch (e) { out.statsError = String(e.message || e); }
    try {
      const now = Math.floor(Date.now() / 1000);
      const r = await fetch('https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/' + encodeURIComponent(sym) +
        '?type=' + FIN_TYPES.map(t => 'annual' + t).join(',') + '&merge=false&padTimeSeries=false&period1=' + (now - 11 * 366 * 86400) + '&period2=' + (now + 86400),
        { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      for (const it of ((j.timeseries || {}).result || [])) {
        const type = it.meta && it.meta.type && it.meta.type[0];
        const rows = type && it[type];
        if (!rows) continue;
        const key = type.replace(/^annual/, '');
        for (const row of rows) {
          const v = row && row.reportedValue && row.reportedValue.raw;
          if (typeof v !== 'number' || !row.asOfDate) continue;
          (out.years[row.asOfDate] = out.years[row.asOfDate] || {})[key] = v;
        }
      }
    } catch (e) { out.yearsError = String(e.message || e); }
    try { out.ten = await getTen(sym, out.years); } catch (e) { out.tenError = String(e.message || e); }
    return out;
  });
}


// ---- Shiller CAPE (cyclically adjusted P/E) for the Home page -------------
const CAPE_MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
async function getCape() {
  return cached('cape', 6 * 3600000, async () => {
    const r = await fetch('https://www.multpl.com/shiller-pe/table/by-month', { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } });
    if (!r.ok) throw new Error('CAPE source HTTP ' + r.status);
    const html = await r.text();
    const rows = [], seen = new Set();
    for (const m of html.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*([A-Z][a-z]{2})\s+\d{1,2},\s+(\d{4})\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
      const num = parseFloat(m[3].replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, ' ').replace(/,/g, '').match(/-?\d+(\.\d+)?/)?.[0]);
      const mo = CAPE_MONTHS[m[1]];
      if (!mo || !isFinite(num) || num <= 0) continue;
      const key = m[2] + '-' + String(mo).padStart(2, '0');
      if (seen.has(key)) continue;
      seen.add(key); rows.push([key, num]);
    }
    if (rows.length < 500) throw new Error('could not read the CAPE table');
    rows.sort((a, b) => a[0].localeCompare(b[0]));
    return { rows, source: 'multpl.com (Robert Shiller data)' };
  });
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
        t('sec_filer_SemperAugustus', async () => { const d = await getFiler('1115373'); return d.period + ', ' + d.holdings.length + ' holdings, top ' + JSON.stringify(d.holdings[0]) + ', new ' + (d.newBuys ? d.newBuys.buys.length : 'n/a'); }),
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
      const match = (url.searchParams.get('match') || '').replace(/[^A-Za-z0-9\/_\-.]/g, '').slice(0, 40);
      let host = '';
      try { const u = new URL(src); host = u.protocol === 'https:' ? u.hostname : ''; } catch (e) {}
      if (!host || !/\.[a-z]{2,}$/i.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !['letters', 'posts', 'podcast'].includes(kind)) {
        return new Response(JSON.stringify({ error: 'needs a public https address' }), { status: 400, headers });
      }
      const d = await getSource(src, kind, match).catch(e => ({ error: String(e.message || e) }));
      return new Response(JSON.stringify(d), { headers: { ...headers, 'cache-control': 'public, max-age=1800' } });
    }

    // Look up who files 13Fs under a name: /?findfiler=focused%20compounding
    if (url.searchParams.get('findfiler')) {
      const q = url.searchParams.get('findfiler').replace(/[^A-Za-z0-9 .&,\-]/g, '').slice(0, 60);
      try {
        const r = await secGet('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&company=' + encodeURIComponent(q) + '&type=13F-HR&owner=include&count=40&output=atom');
        const x = await r.text();
        const found = [...new Set([...x.matchAll(/<title>([^<]*13F[^<]*)<\/title>/gi)].map(m => textOf(m[1])))].slice(0, 20);
        const r2 = await secGet('https://www.sec.gov/cgi-bin/browse-edgar?company=' + encodeURIComponent(q) + '&type=13F-HR&owner=include&count=40&action=getcompany&output=atom');
        const y = await r2.text();
        const cos = [...y.matchAll(/<conformed-name>([^<]*)<\/conformed-name>|<cik>(\d+)<\/cik>/gi)].map(m => m[1] || m[2]);
        return new Response(JSON.stringify({ recentFilings: found, companies: cos.slice(0, 40), bytes: [x.length, y.length] }, null, 2), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { headers });
      }
    }

    if (url.searchParams.get('insider')) {
      const cik = url.searchParams.get('insider');
      if (!/^\d{1,10}$/.test(cik)) return new Response('{}', { status: 400, headers });
      const d = await getInsider(cik).catch(e => ({ error: String(e.message || e) }));
      return new Response(JSON.stringify(d), { headers: { ...headers, 'cache-control': 'public, max-age=3600' } });
    }

    if (url.searchParams.get('tweets')) {
      const handle = url.searchParams.get('tweets');
      if (!/^\w{1,15}$/.test(handle)) return new Response('{}', { status: 400, headers });
      const d = await getTweets(handle).catch(e => ({ error: String(e.message || e) }));
      return new Response(JSON.stringify(d), { headers: { ...headers, 'cache-control': 'public, max-age=900' } });
    }

    if (url.searchParams.get('filer')) {
      const cik = url.searchParams.get('filer');
      if (!/^\d{1,10}$/.test(cik)) return new Response('{}', { status: 400, headers });
      const d = await getFiler(cik).catch(e => ({ error: String(e.message || e) }));
      return new Response(JSON.stringify(d), { headers: { ...headers, 'cache-control': 'public, max-age=3600' } });
    }

    if (url.searchParams.get('wagn')) {
      const d = await getWagn().catch(e => ({ error: String(e.message || e) }));
      return new Response(JSON.stringify(d), { headers: { ...headers, 'cache-control': 'public, max-age=1800' } });
    }

    if (url.searchParams.get('fred')) {
      const id = url.searchParams.get('fred');
      if (id !== 'DGS2') return new Response('{}', { status: 400, headers });
      const m = await fetchFredDaily(id).catch(() => ({}));
      return new Response(JSON.stringify(m), { headers: { ...headers, 'cache-control': 'public, max-age=900' } });
    }

    if (url.searchParams.get('mortgage')) {
      const m = await fetchMortgage().catch(() => ({}));
      return new Response(JSON.stringify(m), { headers });
    }

    // Biggest winners and losers across the US market (Home page).
    if (url.searchParams.get('fin')) {
      const sym = url.searchParams.get('fin').toUpperCase();
      if (!/^[A-Z0-9.\-^=]{1,14}$/.test(sym)) return new Response('{}', { status: 400, headers });
      const d = await getFin(sym).catch(e => ({ error: String(e.message || e) }));
      return new Response(JSON.stringify(d), { headers: { ...headers, 'cache-control': 'public, max-age=900' } });
    }

    if (url.searchParams.get('cape')) {
      try {
        return new Response(JSON.stringify(await getCape()), { headers: { ...headers, 'cache-control': 'public, max-age=3600' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { headers });
      }
    }

    if (url.searchParams.get('screen')) {
      try {
        const d = await runScreen(url.searchParams);
        return new Response(JSON.stringify(d), { headers: { ...headers, 'cache-control': 'public, max-age=300' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { headers });
      }
    }

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
