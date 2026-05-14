const https = require('https');
const zlib  = require('zlib');

// ═══════════════════════════════════════════════════════
// NSE PROXY — uses Vercel's CDN edge cache (s-maxage)
// This means Vercel's CDN serves the cached response
// from its global edge network — typically < 50ms
// Memory cache is bonus for same-instance hits
// ═══════════════════════════════════════════════════════

const CACHE = new Map(); // in-process bonus cache
let SESSION = { cookie: null, ts: 0 };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const NSE_H = {
  'User-Agent': UA, 'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/',
  'Origin': 'https://www.nseindia.com',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
};

// Cache TTL per endpoint (seconds for Vercel CDN)
const CDN_TTL = {
  '/api/nse/indices':      25,
  '/api/nse/nifty50':      25,
  '/api/nse/banknifty':    25,
  '/api/nse/oi-nifty':     35,
  '/api/nse/oi-banknifty': 35,
  '/api/nse/oi-finnifty':  35,
};

function getSession() {
  if (SESSION.cookie && Date.now() - SESSION.ts < 200000) return Promise.resolve(SESSION.cookie);
  return new Promise((res, rej) => {
    const req = https.get('https://www.nseindia.com', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.9', 'Accept-Encoding': 'gzip, deflate, br' }
    }, (r) => {
      SESSION = { cookie: (r.headers['set-cookie']||[]).map(c=>c.split(';')[0]).join('; '), ts: Date.now() };
      r.resume(); r.on('end', () => res(SESSION.cookie)); r.on('error', rej);
    });
    req.on('error', rej);
    req.setTimeout(8000, () => { req.destroy(); rej(new Error('session timeout')); });
  });
}

function fetchNSE(path, cookie) {
  return new Promise((res, rej) => {
    const req = https.get({ hostname: 'www.nseindia.com', path, headers: { ...NSE_H, 'Cookie': cookie } }, (r) => {
      const enc = r.headers['content-encoding'];
      let s = r;
      if (enc === 'gzip')    s = r.pipe(zlib.createGunzip());
      else if (enc === 'br') s = r.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') s = r.pipe(zlib.createInflate());
      let d = '';
      s.on('data', c => d += c);
      s.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(new Error('NSE parse error')); } });
      s.on('error', rej);
    });
    req.on('error', rej);
    req.setTimeout(12000, () => { req.destroy(); rej(new Error('NSE timeout')); });
  });
}

const ROUTES = {
  '/api/nse/indices':      '/api/allIndices',
  '/api/nse/nifty50':      '/api/equity-stockIndices?index=NIFTY%2050',
  '/api/nse/banknifty':    '/api/equity-stockIndices?index=NIFTY%20BANK',
  '/api/nse/oi-nifty':     '/api/option-chain-indices?symbol=NIFTY',
  '/api/nse/oi-banknifty': '/api/option-chain-indices?symbol=BANKNIFTY',
  '/api/nse/oi-finnifty':  '/api/option-chain-indices?symbol=FINNIFTY',
};
const IDX = {
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
  if (pathname === '/api/nse/quote')
    return `/api/quote-equity?symbol=${encodeURIComponent((searchParams.get('symbol')||'').toUpperCase())}`;
  if (pathname === '/api/nse/optchain') {
    const s = (searchParams.get('symbol')||'').toUpperCase();
    return ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY'].includes(s)
      ? `/api/option-chain-indices?symbol=${s}`
      : `/api/option-chain-equities?symbol=${encodeURIComponent(s)}`;
  }
  if (pathname === '/api/nse/sector') {
    const i = (searchParams.get('index')||'').toLowerCase();
    return `/api/equity-stockIndices?index=${IDX[i]||encodeURIComponent(searchParams.get('index'))}`;
  }
  if (pathname.startsWith('/api/nse/oi-'))
    return `/api/option-chain-indices?symbol=${pathname.replace('/api/nse/oi-','').toUpperCase()}`;
  throw new Error('Unknown: ' + pathname);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  // In-process memory cache (bonus — same lambda instance)
  const ckey = req.url;
  const mem  = CACHE.get(ckey);
  if (mem && Date.now() - mem.ts < 20000) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'MEM');
    // Tell Vercel CDN to cache this response at edge for 25s
    const seg = ckey.split('?')[0].replace('/api/nse/','');
    const ttl = CDN_TTL['/api/nse/'+seg] || 30;
    res.setHeader('Cache-Control', `public, s-maxage=${ttl}, stale-while-revalidate=120`);
    return res.status(200).json(mem.data);
  }

  try {
    const nsePath = resolvePath(req.url);
    const cookie  = await getSession();
    const data    = await fetchNSE(nsePath, cookie);

    // Store in memory
    CACHE.set(ckey, { data, ts: Date.now() });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'FRESH');
    // KEY: Tell Vercel CDN to cache at edge globally
    const seg = ckey.split('?')[0].replace('/api/nse/','');
    const ttl = CDN_TTL['/api/nse/'+seg] || 30;
    res.setHeader('Cache-Control', `public, s-maxage=${ttl}, stale-while-revalidate=120`);
    return res.status(200).json(data);

  } catch (err) {
    // Return stale memory on error
    const stale = CACHE.get(ckey);
    if (stale) {
      res.setHeader('X-Cache', 'STALE');
      res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=300');
      return res.status(200).json(stale.data);
    }
    return res.status(502).json({ error: 'NSE fetch failed', message: err.message });
  }
};
