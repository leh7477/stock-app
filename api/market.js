const TIMEOUT_MS = 6000;

async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  // Vercel Edge Cache 5분 + stale-while-revalidate 1분
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  let usd = null;
  let kospi = null;

  // USD/KRW — 한국은행 ECOS
  try {
    const today = new Date();
    const end = today.toISOString().slice(0, 10).replace(/-/g, '');
    const start30 = new Date(today - 30 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const ecosUrl = `https://ecos.bok.or.kr/api/StatisticSearch/${process.env.ECOS_API_KEY}/json/kr/1/5/731Y001/DD/${start30}/${end}/0000001`;
    const ecosRes = await timedFetch(ecosUrl);
    const ecosData = await ecosRes.json();
    const rows = ecosData?.StatisticSearch?.row || [];
    if (rows.length >= 2) {
      const cur  = parseFloat(rows[rows.length - 1].DATA_VALUE);
      const prev = parseFloat(rows[rows.length - 2].DATA_VALUE);
      usd = { val: Math.round(cur).toLocaleString(), chg: (cur - prev).toFixed(1) };
    }
  } catch (e) {
    console.error('USD fetch error:', e.message);
  }

  // KOSPI — 네이버 금융 모바일 API
  try {
    const naverRes = await timedFetch('https://m.stock.naver.com/api/index/KOSPI/basic', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        'Referer': 'https://m.stock.naver.com',
      },
    });
    const naverData = await naverRes.json();
    kospi = {
      val: parseFloat(naverData.closePrice.replace(/,/g, '')).toFixed(2),
      chg: parseFloat(naverData.compareToPreviousClosePrice).toFixed(2),
    };
  } catch (e) {
    console.error('KOSPI fetch error:', e.message);
  }

  res.status(200).json({ success: true, rate: '2.50%', usd, kospi });
}
