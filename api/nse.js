// /api/nse.js — Vercel Serverless Proxy for NSE India
// Handles NSE's cookie-based auth + CORS
// Deploy free at vercel.com

const https = require('https');

// NSE requires these headers + a session cookie to serve data
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

// Cache the NSE session cookie (lasts ~5 minutes)
let sessionCache = { cookie: null, timestamp: 0 };

// Step 1: Visit NSE homepage to get session cookie
async function getNSESession() {
  const now = Date.now();
  // Reuse cookie if less than 4 minutes old
  if (sessionCache.cookie && (now - sessionCache.timestamp) < 240000) {
    return sessionCache.cookie;
  }

  return new Promise((resolve, reject) => {
    const req = https.get('https://www.nseindia.com', {
      headers: {
        'User-Agent': NSE_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      const cookies = res.headers['set-cookie'] || [];
      const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
      sessionCache = { cookie: cookieStr, timestamp: Date.now() };
      resolve(cookieStr);
      res.resume();
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Session timeout')); });
  });
}

// Step 2: Fetch actual NSE endpoint with session cookie
async function fetchNSE(path, cookie) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.nseindia.com',
      path: path,
      method: 'GET',
      headers: { ...NSE_HEADERS, 'Cookie': cookie },
    };

    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`NSE returned non-JSON: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('NSE fetch timeout')); });
  });
}

// ── ROUTE MAP ──
// Maps our clean endpoint names to NSE paths
const ROUTES = {
  '/api/nse/indices':         '/api/allIndices',
  '/api/nse/nifty50':         '/api/equity-stockIndices?index=NIFTY%2050',
  '/api/nse/banknifty':       '/api/equity-stockIndices?index=NIFTY%20BANK',
  '/api/nse/oi-nifty':        '/api/option-chain-indices?symbol=NIFTY',
  '/api/nse/oi-banknifty':    '/api/option-chain-indices?symbol=BANKNIFTY',
  '/api/nse/oi-finnifty':     '/api/option-chain-indices?symbol=FINNIFTY',
};

// Dynamic routes (with query params)
function resolveNSEPath(url) {
  const { pathname, searchParams } = new URL(url, 'https://dummy.com');

  // Static routes
  if (ROUTES[pathname]) return ROUTES[pathname];

  // /api/nse/quote?symbol=RELIANCE
  if (pathname === '/api/nse/quote') {
    const sym = searchParams.get('symbol');
    if (!sym) throw new Error('symbol param required');
    return `/api/quote-equity?symbol=${encodeURIComponent(sym.toUpperCase())}`;
  }

  // /api/nse/optchain?symbol=RELIANCE (equity)
  if (pathname === '/api/nse/optchain') {
    const sym = searchParams.get('symbol');
    if (!sym) throw new Error('symbol param required');
    const indices = ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY'];
    if (indices.includes(sym.toUpperCase())) {
      return `/api/option-chain-indices?symbol=${sym.toUpperCase()}`;
    }
    return `/api/option-chain-equities?symbol=${encodeURIComponent(sym.toUpperCase())}`;
  }

  // /api/nse/sector?index=NIFTY%20IT
  if (pathname === '/api/nse/sector') {
    const idx = searchParams.get('index');
    if (!idx) throw new Error('index param required');
    return `/api/equity-stockIndices?index=${encodeURIComponent(idx)}`;
  }

  throw new Error(`Unknown route: ${pathname}`);
}

// ── MAIN HANDLER ──
module.exports = async function handler(req, res) {
  // CORS headers — allow any origin (your frontend)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const nsePath = resolveNSEPath(req.url);
    const cookie  = await getNSESession();
    const data    = await fetchNSE(nsePath, cookie);

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(data);

  } catch (err) {
    console.error('NSE proxy error:', err.message);
    return res.status(502).json({
      error: 'NSE fetch failed',
      message: err.message,
      hint: 'NSE may be down or blocking — try again in 30 seconds'
    });
  }
};
