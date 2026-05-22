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
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  // KOSPI(NAVER)와 USD/KRW(Frankfurter) 병렬 호출
  const [kospiResult, usdResult] = await Promise.allSettled([
    timedFetch('https://m.stock.naver.com/api/index/KOSPI/basic', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        'Referer': 'https://m.stock.naver.com',
      },
    }).then(r => r.json()),
    timedFetch('https://api.frankfurter.app/latest?from=USD&to=KRW').then(r => r.json()),
  ]);

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

  let usd = null;
  if (usdResult.status === 'fulfilled') {
    const krw = usdResult.value?.rates?.KRW;
    if (krw) {
      // 전일 대비 변동은 별도 호출 없이 생략하고 현재 환율만 표시
      usd = { val: Math.round(krw).toLocaleString(), chg: '0.0' };
    }
  } else {
    console.error('USD fetch error:', usdResult.reason?.message);
  }

  res.status(200).json({ success: true, rate: '2.50%', usd, kospi });
}
