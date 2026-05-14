// /api/data.js — Single unified endpoint
// Returns ALL data in one request instead of 4-5 separate calls
// Vercel CDN caches this at edge for 25 seconds
// Result: browser makes ONE request instead of many

const https = require('https');
const zlib  = require('zlib');

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

function getSession() {
  if (SESSION.cookie && Date.now() - SESSION.ts < 200000) return Promise.resolve(SESSION.cookie);
  return new Promise((res, rej) => {
    const req = https.get('https://www.nseindia.com', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Encoding': 'gzip, deflate, br' }
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
      s.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(new Error('parse')); } });
      s.on('error', rej);
    });
    req.on('error', rej);
    req.setTimeout(12000, () => { req.destroy(); rej(new Error('timeout')); });
  });
}

// Fetch with timeout — if one fails, return null (don't block others)
async function safeFetch(path, cookie) {
  try { return await fetchNSE(path, cookie); } catch(e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = new URL(req.url, 'https://x.com').searchParams.get('type') || 'overview';

  try {
    const cookie = await getSession();

    let result = {};

    if (type === 'overview') {
      // Fetch indices + nifty50 in PARALLEL — one request from browser
      const [indices, nifty50] = await Promise.all([
        safeFetch('/api/allIndices', cookie),
        safeFetch('/api/equity-stockIndices?index=NIFTY%2050', cookie),
      ]);
      result = { indices, nifty50, ts: Date.now() };
      // CDN caches for 25s
      res.setHeader('Cache-Control', 'public, s-maxage=25, stale-while-revalidate=120');
    }
    else if (type === 'oi') {
      const sym = new URL(req.url, 'https://x.com').searchParams.get('sym') || 'NIFTY';
      const data = await safeFetch(`/api/option-chain-indices?symbol=${sym}`, cookie);
      result = { oi: data, ts: Date.now() };
      res.setHeader('Cache-Control', 'public, s-maxage=35, stale-while-revalidate=120');
    }
    else if (type === 'stocks') {
      // Load multiple index stock lists in parallel
      const indexList = [
        'NIFTY%2050', 'NIFTY%20NEXT%2050', 'NIFTY%20BANK', 'NIFTY%20IT',
        'NIFTY%20PHARMA', 'NIFTY%20AUTO', 'NIFTY%20FMCG', 'NIFTY%20METAL',
        'NIFTY%20REALTY', 'NIFTY%20ENERGY', 'NIFTY%20INFRA', 'NIFTY%20200',
      ];
      const results = await Promise.all(
        indexList.map(idx => safeFetch(`/api/equity-stockIndices?index=${idx}`, cookie))
      );
      const seen = new Set();
      const stocks = [];
      results.forEach((r, i) => {
        if (!r) return;
        const idxName = decodeURIComponent(indexList[i]).replace(/%20/g,' ');
        (r.data || []).forEach(s => {
          if (s.symbol && !seen.has(s.symbol)) {
            seen.add(s.symbol);
            stocks.push({ ...s, indexGroup: idxName });
          }
        });
      });
      result = { stocks, count: stocks.length, ts: Date.now() };
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    }
    else if (type === 'quote') {
      const sym = new URL(req.url, 'https://x.com').searchParams.get('sym') || 'RELIANCE';
      const data = await safeFetch(`/api/quote-equity?symbol=${encodeURIComponent(sym.toUpperCase())}`, cookie);
      result = { quote: data, ts: Date.now() };
      res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
    }
    else if (type === 'chain') {
      const sym = (new URL(req.url, 'https://x.com').searchParams.get('sym') || 'NIFTY').toUpperCase();
      const isIdx = ['NIFTY','BANKNIFTY','FINNIFTY'].includes(sym);
      const path = isIdx
        ? `/api/option-chain-indices?symbol=${sym}`
        : `/api/option-chain-equities?symbol=${encodeURIComponent(sym)}`;
      const data = await safeFetch(path, cookie);
      result = { chain: data, ts: Date.now() };
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(result);

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
