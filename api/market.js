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

  const today = new Date();
  const end    = today.toISOString().slice(0, 10).replace(/-/g, '');
  // 30일 → 7일로 축소: 최근 2개 값만 필요하고 ECOS는 영업일 기준이라 7일이면 충분
  const start7 = new Date(today - 7 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const ecosUrl = `https://ecos.bok.or.kr/api/StatisticSearch/${process.env.ECOS_API_KEY}/json/kr/1/2/731Y001/DD/${start7}/${end}/0000001`;

  // ECOS(USD)와 네이버(KOSPI)를 병렬 호출 — 순차 → 동시 실행으로 변경
  const [usdResult, kospiResult] = await Promise.allSettled([
    timedFetch(ecosUrl).then(r => r.json()),
    timedFetch('https://m.stock.naver.com/api/index/KOSPI/basic', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        'Referer': 'https://m.stock.naver.com',
      },
    }).then(r => r.json()),
  ]);

  let usd = null;
  if (usdResult.status === 'fulfilled') {
    const rows = usdResult.value?.StatisticSearch?.row || [];
    if (rows.length >= 2) {
      const cur  = parseFloat(rows[rows.length - 1].DATA_VALUE);
      const prev = parseFloat(rows[rows.length - 2].DATA_VALUE);
      usd = { val: Math.round(cur).toLocaleString(), chg: (cur - prev).toFixed(1) };
    }
  } else {
    console.error('USD fetch error:', usdResult.reason?.message);
  }

  let kospi = null;
  if (kospiResult.status === 'fulfilled') {
    const d = kospiResult.value;
    kospi = {
      val: parseFloat(d.closePrice.replace(/,/g, '')).toFixed(2),
      chg: parseFloat(d.compareToPreviousClosePrice).toFixed(2),
    };
  } else {
    console.error('KOSPI fetch error:', kospiResult.reason?.message);
  }

  res.status(200).json({ success: true, rate: '2.50%', usd, kospi });
}
