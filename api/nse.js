const https = require('https');
const zlib = require('zlib');

// ═══════════════════════════════════════════
// IN-MEMORY CACHE — responses cached 30s
// Vercel serverless keeps warm instances
// so cache survives between requests
// ═══════════════════════════════════════════
const CACHE = new Map();
const CACHE_TTL = {
  '/api/nse/indices':      30000,  // 30s  — indices update fast
  '/api/nse/nifty50':      30000,  // 30s
  '/api/nse/banknifty':    30000,
  '/api/nse/oi-nifty':     45000,  // 45s  — OI changes slower
  '/api/nse/oi-banknifty': 45000,
  '/api/nse/oi-finnifty':  45000,
  'default':               60000,  // 60s  — quotes, chains
};

function getCached(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  const ttl = CACHE_TTL[key] || CACHE_TTL['default'];
  if (Date.now() - entry.ts > ttl) { CACHE.delete(key); return null; }
  return entry.data;
}
function setCached(key, data) {
  CACHE.set(key, { data, ts: Date.now() });
}

// ═══════════════════════════════════════════
// NSE SESSION CACHE — cookie lasts 4 mins
// ═══════════════════════════════════════════
let SESSION = { cookie: null, ts: 0 };

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/',
  'Origin': 'https://www.nseindia.com',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

async function getSession() {
  if (SESSION.cookie && Date.now() - SESSION.ts < 240000) return SESSION.cookie;
  return new Promise((resolve, reject) => {
    const req = https.get('https://www.nseindia.com', {
      headers: {
        'User-Agent': NSE_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      }
    }, (res) => {
      const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      SESSION = { cookie: cookies, ts: Date.now() };
      let body = [];
      res.on('data', c => body.push(c));
      res.on('end', () => resolve(cookies));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Session timeout')); });
  });
}

async function fetchNSE(path, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'www.nseindia.com',
      path,
      method: 'GET',
      headers: { ...NSE_HEADERS, 'Cookie': cookie },
    }, (res) => {
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      let data = '';
      stream.on('data', c => data += c.toString());
      stream.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('NSE parse error: ' + data.substring(0, 100))); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('NSE timeout')); });
  });
}

// ═══════════════════════════════════════════
// ROUTE MAP
// ═══════════════════════════════════════════
const ROUTES = {
  '/api/nse/indices':      '/api/allIndices',
  '/api/nse/nifty50':      '/api/equity-stockIndices?index=NIFTY%2050',
  '/api/nse/banknifty':    '/api/equity-stockIndices?index=NIFTY%20BANK',
  '/api/nse/oi-nifty':     '/api/option-chain-indices?symbol=NIFTY',
  '/api/nse/oi-banknifty': '/api/option-chain-indices?symbol=BANKNIFTY',
  '/api/nse/oi-finnifty':  '/api/option-chain-indices?symbol=FINNIFTY',
};

// Dynamic index routes
const INDEX_MAP = {
  'nifty next 50':       'NIFTY%20NEXT%2050',
  'nifty 100':           'NIFTY%20100',
  'nifty 200':           'NIFTY%20200',
  'nifty 500':           'NIFTY%20500',
  'nifty it':            'NIFTY%20IT',
  'nifty pharma':        'NIFTY%20PHARMA',
  'nifty auto':          'NIFTY%20AUTO',
  'nifty fmcg':          'NIFTY%20FMCG',
  'nifty metal':         'NIFTY%20METAL',
  'nifty realty':        'NIFTY%20REALTY',
  'nifty energy':        'NIFTY%20ENERGY',
  'nifty infra':         'NIFTY%20INFRA',
  'nifty media':         'NIFTY%20MEDIA',
  'nifty midcap 50':     'NIFTY%20MIDCAP%2050',
  'nifty midcap 100':    'NIFTY%20MIDCAP%20100',
  'nifty smallcap 100':  'NIFTY%20SMALLCAP%20100',
  'nifty microcap 250':  'NIFTY%20MICROCAP250',
};

function resolveNSEPath(url) {
  const { pathname, searchParams } = new URL(url, 'https://dummy.com');
  if (ROUTES[pathname]) return ROUTES[pathname];

  if (pathname === '/api/nse/quote') {
    const sym = searchParams.get('symbol');
    if (!sym) throw new Error('symbol required');
    return `/api/quote-equity?symbol=${encodeURIComponent(sym.toUpperCase())}`;
  }
  if (pathname === '/api/nse/optchain') {
    const sym = searchParams.get('symbol');
    if (!sym) throw new Error('symbol required');
    const idxList = ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY'];
    return idxList.includes(sym.toUpperCase())
      ? `/api/option-chain-indices?symbol=${sym.toUpperCase()}`
      : `/api/option-chain-equities?symbol=${encodeURIComponent(sym.toUpperCase())}`;
  }
  if (pathname === '/api/nse/sector') {
    const idx = (searchParams.get('index') || '').toLowerCase();
    const mapped = INDEX_MAP[idx];
    if (mapped) return `/api/equity-stockIndices?index=${mapped}`;
    return `/api/equity-stockIndices?index=${encodeURIComponent(searchParams.get('index'))}`;
  }
  // Generic OI for any index
  if (pathname.startsWith('/api/nse/oi-')) {
    const sym = pathname.replace('/api/nse/oi-', '').toUpperCase();
    return `/api/option-chain-indices?symbol=${sym}`;
  }
  throw new Error(`Unknown route: ${pathname}`);
}

// ═══════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const cacheKey = req.url.split('?')[0] + (req.url.includes('symbol=') ? '?'+req.url.split('?')[1] : '');

  // ── Return cached response instantly ──
  const cached = getCached(cacheKey);
  if (cached) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, s-maxage=25, stale-while-revalidate=60');
    return res.status(200).json(cached);
  }

  try {
    const nsePath = resolveNSEPath(req.url);
    const cookie  = await getSession();
    const data    = await fetchNSE(nsePath, cookie);

    // Cache and respond
    setCached(cacheKey, data);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, s-maxage=25, stale-while-revalidate=60');
    return res.status(200).json(data);

  } catch (err) {
    console.error('NSE error:', err.message);
    // Return stale cache on error rather than failing
    const stale = CACHE.get(cacheKey);
    if (stale) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json(stale.data);
    }
    return res.status(502).json({ error: 'NSE fetch failed', message: err.message });
  }
};
