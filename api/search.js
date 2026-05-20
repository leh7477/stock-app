async function getKisToken() {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  const getRes = await fetch(`${redisUrl}/get/kis_token`, {
    headers: { Authorization: `Bearer ${redisToken}` }
  });
  const getData = await getRes.json();
  if (getData.result) return getData.result;

  const tokenRes = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET
    })
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;
  if (!token) throw new Error('토큰 발급 실패');

  await fetch(`${redisUrl}/set/kis_token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: token, ex: 82800 })
  });

  return token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const query = req.query?.query || '';
  if (!query) return res.status(200).json({ success: false, error: '검색어 없음' });

  try {
    const token = await getKisToken();

    // 종목 검색
    const searchRes = await fetch(
      `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/search-stock-info?PDNO=${encodeURIComponent(query)}&PRDT_TYPE_CD=300`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'appkey': process.env.KIS_APP_KEY,
          'appsecret': process.env.KIS_APP_SECRET,
          'tr_id': 'CTPF1002R',
          'Content-Type': 'application/json'
        }
      }
    );
    const searchData = await searchRes.json();
    console.log('검색 응답:', JSON.stringify(searchData).slice(0, 300));

    const code = searchData?.output?.shtn_pdno || query;
    const name = searchData?.output?.prdt_abrv_name || query;

    // 현재가 조회
    const priceRes = await fetch(
      `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'appkey': process.env.KIS_APP_KEY,
          'appsecret': process.env.KIS_APP_SECRET,
          'tr_id': 'FHKST01010100',
          'Content-Type': 'application/json'
        }
      }
    );
    const priceData = await priceRes.json();
    console.log('시세 응답:', JSON.stringify(priceData).slice(0, 300));
    const output = priceData?.output;

    const price = parseInt(output?.stck_prpr || 0);
    const chgRate = parseFloat(output?.prdy_ctrt || 0);
    const volume = parseInt(output?.acml_vol || 0);
    const foreignNet = parseInt(output?.frgn_ntby_qty || 0);
    const marketCap = parseInt(output?.hts_avls || 0);

    res.status(200).json({
      success: true,
      stock: {
        name,
        code,
        price: price.toLocaleString(),
        chgRate: chgRate.toFixed(2),
        volume: (volume/10000).toFixed(0) + '만주',
        foreignNet,
        marketCap: (marketCap/100000000).toFixed(0) + '억'
      }
    });

  } catch(e) {
    console.error('검색 오류:', e.message);
    res.status(200).json({ success: false, error: e.message });
  }
}
