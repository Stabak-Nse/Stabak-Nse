const https = require('https');
const zlib = require('zlib');

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

let sessionCache = { cookie: null, timestamp: 0 };

async function getNSESession() {
  const now = Date.now();
  if (sessionCache.cookie && (now - sessionCache.timestamp) < 240000) {
    return sessionCache.cookie;
  }
  return new Promise((resolve, reject) => {
    const req = https.get('https://www.nseindia.com', {
      headers: {
        'User-Agent': NSE_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      }
    }, (res) => {
      const cookies = res.headers['set-cookie'] || [];
      const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
      sessionCache = { cookie: cookieStr, timestamp: Date.now() };
      // drain response
      let body = [];
      res.on('data', chunk => body.push(chunk));
      res.on('end', () => resolve(cookieStr));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Session timeout')); });
  });
}

async function fetchNSE(path, cookie) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.nseindia.com',
      path: path,
      method: 'GET',
      headers: { ...NSE_HEADERS, 'Cookie': cookie },
    };
    const req = https.get(options, (res) => {
      const encoding = res.headers['content-encoding'];
      let stream = res;

      if (encoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      }

      let data = '';
      stream.on('data', chunk => data += chunk.toString());
      stream.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`NSE parse error: ${data.substring(0, 200)}`));
        }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('NSE timeout')); });
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

function resolveNSEPath(url) {
  const { pathname, searchParams } = new URL(url, 'https://dummy.com');
  if (ROUTES[pathname]) return ROUTES[pathname];
  if (pathname === '/api/nse/quote') {
    const sym = searchParams.get('symbol');
    if (!sym) throw new Error('symbol param required');
    return `/api/quote-equity?symbol=${encodeURIComponent(sym.toUpperCase())}`;
  }
  if (pathname === '/api/nse/optchain') {
    const sym = searchParams.get('symbol');
    if (!sym) throw new Error('symbol param required');
    const indices = ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY'];
    if (indices.includes(sym.toUpperCase())) {
      return `/api/option-chain-indices?symbol=${sym.toUpperCase()}`;
    }
    return `/api/option-chain-equities?symbol=${encodeURIComponent(sym.toUpperCase())}`;
  }
  if (pathname === '/api/nse/sector') {
    const idx = searchParams.get('index');
    if (!idx) throw new Error('index param required');
    return `/api/equity-stockIndices?index=${encodeURIComponent(idx)}`;
  }
  throw new Error(`Unknown route: ${pathname}`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

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
    });
  }
};
