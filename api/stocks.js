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

async function getKisToken() {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  const getRes = await timedFetch(`${redisUrl}/get/kis_token`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  });
  const getData = await getRes.json();
  if (getData.result) return getData.result;

  const tokenRes = await timedFetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
    }),
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;
  if (!token) throw new Error('토큰 발급 실패: ' + JSON.stringify(tokenData));

  await timedFetch(`${redisUrl}/set/kis_token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: token, ex: 82800 }),
  });

  return token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  try {
    const token = await getKisToken();

    const volRes = await timedFetch(
      'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/ranking/volume?fid_cond_mrkt_div_code=J&fid_cond_scr_div_code=20171&fid_input_iscd=0000&fid_div_cls_code=0&fid_blng_cls_code=0&fid_trgt_cls_code=111111111&fid_trgt_exls_cls_code=000000&fid_input_price_1=0&fid_input_price_2=0&fid_vol_cnt=100000&fid_input_date_1=',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          appkey: process.env.KIS_APP_KEY,
          appsecret: process.env.KIS_APP_SECRET,
          tr_id: 'FHPST01710000',
          'Content-Type': 'application/json',
        },
      }
    );

    const volData = await volRes.json();
    const items = volData?.output?.slice(0, 5) || [];

    if (items.length === 0) {
      return res.status(200).json({ success: true, stocks: [] });
    }

    const stocks = items.map((s, i) => {
      const price   = parseInt(s.stck_prpr || 0);
      const volume  = parseInt(s.acml_vol  || 0);
      const chgRate = parseFloat(s.prdy_ctrt || 0);
      const signal     = chgRate > 3 ? 'buy' : chgRate < -3 ? 'caution' : 'watch';
      const signalText = signal === 'buy' ? '상승 강세' : signal === 'caution' ? '하락 주의' : '보합';
      return {
        rank: i + 1,
        name: s.hts_kor_isnm,
        price: price > 0 ? price.toLocaleString() + '원' : '-',
        reason: `거래량 ${(volume / 10000).toFixed(0)}만주 · 전일대비 ${chgRate > 0 ? '+' : ''}${chgRate}%`,
        signal,
        signalText,
      };
    });

    res.status(200).json({ success: true, stocks });
  } catch (error) {
    console.error('거래량 오류:', error.message);
    res.status(200).json({ success: true, stocks: [] });
  }
}
