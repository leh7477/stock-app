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

// 자주 쓰는 종목 코드 매핑
const STOCK_MAP = {
  '삼성전자': '005930', 'sk하이닉스': '000660', 'sk하이닉스': '000660',
  '하이닉스': '000660', 'lg에너지솔루션': '373220', 'lg에너지': '373220',
  '삼성바이오로직스': '207940', '삼성바이오': '207940',
  '현대차': '005380', '현대자동차': '005380',
  '셀트리온': '068270', '기아': '000270', '기아차': '000270',
  'kb금융': '105560', '신한지주': '055550', '하나금융': '086790',
  '포스코': '005490', 'posco': '005490', 'posco홀딩스': '005490',
  '카카오': '035720', '네이버': '035420', 'naver': '035420',
  'lg화학': '051910', 'sk이노베이션': '096770', 'sk이노': '096770',
  '현대모비스': '012330', '삼성물산': '028260', 'lg전자': '066570',
  '삼성에스디에스': '018260', '삼성sds': '018260',
  'sk텔레콤': '017670', 'kt': '030200', 'lg유플러스': '032640',
  '두산에너빌리티': '034020', '한국전력': '015760', '한전': '015760',
  '크래프톤': '259960', '엔씨소프트': '036570', '엔씨': '036570',
  '카카오뱅크': '323410', '카카오페이': '377300',
  '현대제철': '004020', '고려아연': '010130',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const query = req.query?.query || '';
  if (!query) return res.status(200).json({ success: false });

  try {
    const token = await getKisToken();

    // 종목코드 찾기 (숫자면 바로 사용, 아니면 매핑 테이블 조회)
    const isCode = /^\d{6}$/.test(query);
    let code = isCode ? query : (STOCK_MAP[query.toLowerCase()] || STOCK_MAP[query] || null);
    let name = query;

    // 매핑에 없으면 KIS 검색 API 시도
    if (!code) {
      try {
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
        if (searchData?.output?.shtn_pdno) {
          code = searchData.output.shtn_pdno;
          name = searchData.output.prdt_abrv_name || query;
        }
      } catch(e) { console.error('검색 오류:', e.message); }
    }

    if (!code) {
      return res.status(200).json({ success: false, error: '종목을 찾을 수 없습니다.' });
    }

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
    const o = priceData?.output;
    if (o?.prdt_abrv_name) name = o.prdt_abrv_name;

    // 투자자 동향
    const investRes = await fetch(
      `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'appkey': process.env.KIS_APP_KEY,
          'appsecret': process.env.KIS_APP_SECRET,
          'tr_id': 'FHKST01010900',
          'Content-Type': 'application/json'
        }
      }
    );
    const investData = await investRes.json();
    const inv = investData?.output;

    const price = parseInt(o?.stck_prpr || 0);
    const chgRate = parseFloat(o?.prdy_ctrt || 0);
    const chgAmt = parseInt(o?.prdy_vrss || 0);
    const open = parseInt(o?.stck_oprc || 0);
    const close = parseInt(o?.stck_clpr || 0);
    const high = parseInt(o?.stck_hgpr || 0);
    const low = parseInt(o?.stck_lwpr || 0);
    const high52 = parseInt(o?.stck_dryy_hgpr || 0);
    const low52 = parseInt(o?.stck_dryy_lwpr || 0);
    const volume = parseInt(o?.acml_vol || 0);
    const tradingValue = parseInt(o?.acml_tr_pbmn || 0);
    const marketCap = parseInt(o?.hts_avls || 0);
    const foreignNet = parseInt(inv?.frgn_ntby_qty || 0);
    const instNet = parseInt(inv?.orgn_ntby_qty || 0);
    const personalNet = parseInt(inv?.indv_ntby_qty || 0);

    res.status(200).json({
      success: true,
      stock: {
        name, code,
        price: price.toLocaleString(),
        chgRate: chgRate.toFixed(2),
        chgAmt: chgAmt.toLocaleString(),
        open: open.toLocaleString(),
        close: close.toLocaleString(),
        high: high.toLocaleString(),
        low: low.toLocaleString(),
        high52: high52.toLocaleString(),
        low52: low52.toLocaleString(),
        volume: volume.toLocaleString(),
        tradingValue: (tradingValue/100000000).toFixed(0) + '억',
        marketCap: (marketCap/100000000).toFixed(0) + '억',
        foreignNet: foreignNet.toLocaleString(),
        instNet: instNet.toLocaleString(),
        personalNet: personalNet.toLocaleString()
      }
    });

  } catch(e) {
    console.error('검색 오류:', e.message);
    res.status(200).json({ success: false, error: e.message });
  }
}
