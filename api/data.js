// Edge Runtime — runs globally, zero cold start, ~50ms response
export const config = { runtime: 'edge' };

const NSE_BASE = 'https://www.nseindia.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/',
  'Origin': 'https://www.nseindia.com',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

async function getNSECookie() {
  const r = await fetch(NSE_BASE, {
    headers: {
      'User-Agent': HEADERS['User-Agent'],
      'Accept': 'text/html,application/xhtml+xml,*/*',
    },
  });
  const setCookie = r.headers.get('set-cookie') || '';
  return setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ');
}

async function nse(path, cookie) {
  const r = await fetch(NSE_BASE + path, {
    headers: { ...HEADERS, 'Cookie': cookie },
  });
  if (!r.ok) throw new Error(`NSE ${r.status}: ${path}`);
  return r.json();
}

async function safeNse(path, cookie) {
  try { return await nse(path, cookie); } catch (e) { return null; }
}

export default async function handler(req) {
  const url = new URL(req.url);
  const type = url.searchParams.get('type') || 'overview';
  const sym  = (url.searchParams.get('sym') || 'NIFTY').toUpperCase();

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });

  try {
    const cookie = await getNSECookie();
    let data = {};
    let ttl = 25;

    if (type === 'overview') {
      // Fetch indices + nifty50 in parallel — ONE browser request
      const [indices, nifty50] = await Promise.all([
        safeNse('/api/allIndices', cookie),
        safeNse('/api/equity-stockIndices?index=NIFTY%2050', cookie),
      ]);
      data = { indices, nifty50, ts: Date.now() };
      ttl = 25;
    }
    else if (type === 'stocks') {
      const IDXS = [
        'NIFTY%2050','NIFTY%20NEXT%2050','NIFTY%20BANK','NIFTY%20IT',
        'NIFTY%20PHARMA','NIFTY%20AUTO','NIFTY%20FMCG','NIFTY%20METAL',
        'NIFTY%20REALTY','NIFTY%20ENERGY','NIFTY%20INFRA','NIFTY%20200',
      ];
      const results = await Promise.all(IDXS.map(i => safeNse(`/api/equity-stockIndices?index=${i}`, cookie)));
      const seen = new Set(); const stocks = [];
      results.forEach((r, i) => {
        if (!r) return;
        const grp = decodeURIComponent(IDXS[i]).replace(/%20/g,' ');
        (r.data || []).forEach(s => { if (s.symbol && !seen.has(s.symbol)) { seen.add(s.symbol); stocks.push({...s, indexGroup: grp}); } });
      });
      data = { stocks, count: stocks.length, ts: Date.now() };
      ttl = 60;
    }
    else if (type === 'oi') {
      const isIdx = ['NIFTY','BANKNIFTY','FINNIFTY'].includes(sym);
      const path = isIdx ? `/api/option-chain-indices?symbol=${sym}` : `/api/option-chain-equities?symbol=${encodeURIComponent(sym)}`;
      data = { oi: await safeNse(path, cookie), ts: Date.now() };
      ttl = 35;
    }
    else if (type === 'quote') {
      data = { quote: await safeNse(`/api/quote-equity?symbol=${encodeURIComponent(sym)}`, cookie), ts: Date.now() };
      ttl = 20;
    }
    else if (type === 'chain') {
      const isIdx = ['NIFTY','BANKNIFTY','FINNIFTY'].includes(sym);
      const path = isIdx ? `/api/option-chain-indices?symbol=${sym}` : `/api/option-chain-equities?symbol=${encodeURIComponent(sym)}`;
      data = { chain: await safeNse(path, cookie), ts: Date.now() };
      ttl = 30;
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        ...cors,
        // Vercel CDN edge cache — serves from nearest global node
        'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=120`,
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: cors,
    });
  }
}
