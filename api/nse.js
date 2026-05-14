const https = require('https');
const zlib  = require('zlib');

// ═══════════════════════════════════════
// PERSISTENT CACHE across warm instances
// ═══════════════════════════════════════
const CACHE = new Map();
const TTL = {
  indices: 28000, nifty50: 28000, banknifty: 28000,
  'oi-nifty': 40000, 'oi-banknifty': 40000, 'oi-finnifty': 40000,
  default: 55000,
};
function cKey(url)  { return url.split('?')[0] + (url.includes('symbol=') ? '?' + url.split('?')[1] : ''); }
function getTTL(k)  { const seg = k.replace('/api/nse/',''); return TTL[seg] || TTL.default; }
function getCache(k){ const e = CACHE.get(k); if (!e) return null; if (Date.now()-e.ts > getTTL(k)) { CACHE.delete(k); return null; } return e; }
function setCache(k, d) { CACHE.set(k, { data: d, ts: Date.now() }); }

// ═══════════════════════════════════════
// NSE SESSION
// ═══════════════════════════════════════
let SESSION = { cookie: null, ts: 0 };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const NSE_H = {
  'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br', 'Referer': 'https://www.nseindia.com/',
  'Origin': 'https://www.nseindia.com', 'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
};

function getSession() {
  if (SESSION.cookie && Date.now() - SESSION.ts < 240000) return Promise.resolve(SESSION.cookie);
  return new Promise((res, rej) => {
    const req = https.get('https://www.nseindia.com', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9', 'Accept-Encoding': 'gzip, deflate, br' }
    }, (r) => {
      SESSION = { cookie: (r.headers['set-cookie']||[]).map(c=>c.split(';')[0]).join('; '), ts: Date.now() };
      r.resume(); r.on('end', () => res(SESSION.cookie));
    });
    req.on('error', rej);
    req.setTimeout(8000, () => { req.destroy(); rej(new Error('session timeout')); });
  });
}

function fetchNSE(path, cookie) {
  return new Promise((res, rej) => {
    const req = https.get({ hostname:'www.nseindia.com', path, headers:{...NSE_H,'Cookie':cookie} }, (r) => {
      const enc = r.headers['content-encoding'];
      let s = r;
      if (enc==='gzip')    s = r.pipe(zlib.createGunzip());
      else if (enc==='deflate') s = r.pipe(zlib.createInflate());
      else if (enc==='br') s = r.pipe(zlib.createBrotliDecompress());
      let d = '';
      s.on('data', c => d += c.toString());
      s.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(new Error('parse error')); } });
      s.on('error', rej);
    });
    req.on('error', rej);
    req.setTimeout(12000, () => { req.destroy(); rej(new Error('timeout')); });
  });
}

// ═══════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════
const ROUTES = {
  '/api/nse/indices':      '/api/allIndices',
  '/api/nse/nifty50':      '/api/equity-stockIndices?index=NIFTY%2050',
  '/api/nse/banknifty':    '/api/equity-stockIndices?index=NIFTY%20BANK',
  '/api/nse/oi-nifty':     '/api/option-chain-indices?symbol=NIFTY',
  '/api/nse/oi-banknifty': '/api/option-chain-indices?symbol=BANKNIFTY',
  '/api/nse/oi-finnifty':  '/api/option-chain-indices?symbol=FINNIFTY',
};
const IDX_MAP = {
  'nifty next 50':'NIFTY%20NEXT%2050','nifty 100':'NIFTY%20100','nifty 200':'NIFTY%20200',
  'nifty 500':'NIFTY%20500','nifty it':'NIFTY%20IT','nifty pharma':'NIFTY%20PHARMA',
  'nifty auto':'NIFTY%20AUTO','nifty fmcg':'NIFTY%20FMCG','nifty metal':'NIFTY%20METAL',
  'nifty realty':'NIFTY%20REALTY','nifty energy':'NIFTY%20ENERGY','nifty infra':'NIFTY%20INFRA',
  'nifty media':'NIFTY%20MEDIA','nifty midcap 50':'NIFTY%20MIDCAP%2050',
  'nifty midcap 100':'NIFTY%20MIDCAP%20100','nifty smallcap 100':'NIFTY%20SMALLCAP%20100',
};

function resolvePath(url) {
  const { pathname, searchParams } = new URL(url, 'https://x.com');
  if (ROUTES[pathname]) return ROUTES[pathname];
  if (pathname === '/api/nse/quote')    return `/api/quote-equity?symbol=${encodeURIComponent((searchParams.get('symbol')||'').toUpperCase())}`;
  if (pathname === '/api/nse/optchain') {
    const s = (searchParams.get('symbol')||'').toUpperCase();
    return ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY'].includes(s)
      ? `/api/option-chain-indices?symbol=${s}`
      : `/api/option-chain-equities?symbol=${encodeURIComponent(s)}`;
  }
  if (pathname === '/api/nse/sector') {
    const idx = (searchParams.get('index')||'').toLowerCase();
    return `/api/equity-stockIndices?index=${IDX_MAP[idx] || encodeURIComponent(searchParams.get('index'))}`;
  }
  if (pathname.startsWith('/api/nse/oi-')) return `/api/option-chain-indices?symbol=${pathname.replace('/api/nse/oi-','').toUpperCase()}`;
  throw new Error('Unknown route: ' + pathname);
}

// ═══════════════════════════════════════
// BACKGROUND WARMER
// Pre-fetches the 2 most-used endpoints
// so they're always in cache
// ═══════════════════════════════════════
async function warmCache() {
  try {
    const cookie = await getSession();
    const [idx, n50] = await Promise.all([
      fetchNSE('/api/allIndices', cookie),
      fetchNSE('/api/equity-stockIndices?index=NIFTY%2050', cookie),
    ]);
    setCache('/api/nse/indices', idx);
    setCache('/api/nse/nifty50', n50);
  } catch(e) { /* silent */ }
}

// Warm immediately on cold start + every 25s
warmCache();
setInterval(warmCache, 25000);

// ═══════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const key = cKey(req.url);
  const hit = getCache(key);

  // ── CACHE HIT → instant response ──
  if (hit) {
    const age = Math.round((Date.now() - hit.ts) / 1000);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', `HIT age=${age}s`);
    res.setHeader('Cache-Control', 'public, max-age=20, stale-while-revalidate=60');
    // Background revalidate if older than 20s
    if (Date.now() - hit.ts > 20000) {
      resolvePath(req.url); // validate route first
      getSession().then(c => fetchNSE(resolvePath(req.url), c)).then(d => setCache(key, d)).catch(()=>{});
    }
    return res.status(200).json(hit.data);
  }

  // ── CACHE MISS → fetch live ──
  try {
    const nsePath = resolvePath(req.url);
    const cookie  = await getSession();
    const data    = await fetchNSE(nsePath, cookie);
    setCache(key, data);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=20, stale-while-revalidate=60');
    return res.status(200).json(data);
  } catch (err) {
    // Return stale on error
    const stale = CACHE.get(key);
    if (stale) { res.setHeader('X-Cache','STALE'); return res.status(200).json(stale.data); }
    return res.status(502).json({ error: 'NSE fetch failed', message: err.message });
  }
};
