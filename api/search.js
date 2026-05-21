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

const STOCK_MAP = {
  '삼성전자': '005930', 'sk하이닉스': '000660', '하이닉스': '000660',
  'lg에너지솔루션': '373220', 'lg에너지': '373220',
  '삼성바이오로직스': '207940', '삼성바이오': '207940',
  '현대차': '005380', '현대자동차': '005380',
  '셀트리온': '068270', '기아': '000270', '기아차': '000270',
  'kb금융': '105560', '신한지주': '055550', '하나금융': '086790',
  '포스코': '005490', 'posco': '005490', 'posco홀딩스': '005490',
  '카카오': '035720', '네이버': '035420', 'naver': '035420',
  'lg화학': '051910', 'sk이노베이션': '096770',
  '현대모비스': '012330', '삼성물산': '028260', 'lg전자': '066570',
  'sk텔레콤': '017670', 'kt': '030200', 'lg유플러스': '032640',
  '한국전력': '015760', '한전': '015760',
  '크래프톤': '259960', '엔씨소프트': '036570',
  '카카오뱅크': '323410', '카카오페이': '377300',
  '현대제철': '004020', '고려아연': '010130',
  '두산에너빌리티': '034020', '한화에어로스페이스': '012450',
  '삼성전기': '009150', '삼성sds': '018260',
};

function analyzeTechnical(dailyData, currentPrice, foreignNet) {
  const prices = dailyData.map(d => parseFloat(d.stck_clpr || 0)).filter(p => p > 0);
  const volumes = dailyData.map(d => parseInt(d.acml_vol || 0)).filter(v => v > 0);
  const highs = dailyData.map(d => parseFloat(d.stck_hgpr || 0)).filter(h => h > 0);
  const lows = dailyData.map(d => parseFloat(d.stck_lwpr || 0)).filter(l => l > 0);

  if (prices.length < 20) return null;

  // 이동평균
  const avg = (arr, n) => arr.slice(0, n).reduce((a, b) => a + b, 0) / Math.min(n, arr.length);
  const ma5 = avg(prices, 5);
  const ma20 = avg(prices, 20);
  const ma60 = avg(prices, Math.min(60, prices.length));

  // 거래량 평균
  const vol5 = avg(volumes, 5);
  const vol20 = avg(volumes, 20);
  const vol60 = avg(volumes, Math.min(60, volumes.length));

  // 저항/지지선 (최근 20일 고점/저점)
  const resistance = Math.max(...highs.slice(0, 20));
  const support = Math.min(...lows.slice(0, 20));

  // 신호 분석
  const signals = [];
  let bullScore = 0, bearScore = 0;

  // 이평선 분석
  if (currentPrice > ma5 && ma5 > ma20) { signals.push('단기 이평선 위 → 상승 추세'); bullScore += 2; }
  if (currentPrice < ma5 && ma5 < ma20) { signals.push('단기 이평선 아래 → 하락 추세'); bearScore += 2; }
  if (ma5 > ma20 && ma20 > ma60) { signals.push('정배열 → 강한 상승 추세'); bullScore += 3; }
  if (ma5 < ma20 && ma20 < ma60) { signals.push('역배열 → 강한 하락 추세'); bearScore += 3; }

  // 골든/데드크로스
  if (ma5 > ma20 && prices[1] < prices[0]) { signals.push('골든크로스 근접'); bullScore += 2; }
  if (ma5 < ma20 && prices[1] > prices[0]) { signals.push('데드크로스 근접'); bearScore += 2; }

  // 거래량 분석
  const volRatio5vs60 = vol5 / vol60;
  if (volRatio5vs60 > 1.5) { signals.push(`거래량 급증 (60일 대비 ${(volRatio5vs60*100).toFixed(0)}%)`); bullScore += 2; }
  if (volRatio5vs60 < 0.5) { signals.push(`거래량 급감 (60일 대비 ${(volRatio5vs60*100).toFixed(0)}%)`); bearScore += 1; }

  // 외인 수급
  if (foreignNet > 0) { signals.push('외인 순매수 → 긍정적 수급'); bullScore += 2; }
  if (foreignNet < 0) { signals.push('외인 순매도 → 부정적 수급'); bearScore += 2; }

  // 저항/지지 분석
  const resistanceGap = ((resistance - currentPrice) / currentPrice * 100).toFixed(1);
  const supportGap = ((currentPrice - support) / currentPrice * 100).toFixed(1);

  // 최종 의견
  let opinion, opinionColor;
  if (bullScore > bearScore + 2) { opinion = '매수 우위'; opinionColor = '#22c55e'; }
  else if (bearScore > bullScore + 2) { opinion = '매도 우위'; opinionColor = '#ef4444'; }
  else { opinion = '중립 / 관망'; opinionColor = '#f59e0b'; }

  return {
    opinion, opinionColor,
    ma5: Math.round(ma5).toLocaleString(),
    ma20: Math.round(ma20).toLocaleString(),
    ma60: Math.round(ma60).toLocaleString(),
    vol5: Math.round(vol5/10000) + '만주',
    vol20: Math.round(vol20/10000) + '만주',
    vol60: Math.round(vol60/10000) + '만주',
    resistance: Math.round(resistance).toLocaleString(),
    support: Math.round(support).toLocaleString(),
    resistanceGap,
    supportGap,
    signals: signals.slice(0, 4),
    bullScore,
    bearScore
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const query = req.query?.query || '';
  if (!query) return res.status(200).json({ success: false });

  try {
    const token = await getKisToken();

    const isCode = /^\d{6}$/.test(query);
    let code = isCode ? query : (STOCK_MAP[query.toLowerCase()] || STOCK_MAP[query] || null);
    let name = query;

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
        if (searchData?.output?.shtn_pdno) {
          code = searchData.output.shtn_pdno;
          name = searchData.output.prdt_abrv_name || query;
        }
      } catch(e) {}
    }

    if (!code) return res.status(200).json({ success: false, error: '종목을 찾을 수 없습니다.' });

    // 현재가 + 투자자동향 + 일별데이터 동시 조회
    const headers = {
      'Authorization': `Bearer ${token}`,
      'appkey': process.env.KIS_APP_KEY,
      'appsecret': process.env.KIS_APP_SECRET,
      'Content-Type': 'application/json'
    };

    const [priceRes, investRes, dailyRes] = await Promise.all([
      fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`, { headers: { ...headers, 'tr_id': 'FHKST01010100' } }),
      fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`, { headers: { ...headers, 'tr_id': 'FHKST01010900' } }),
      fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}&fid_period_div_code=D&fid_org_adj_prc=0`, { headers: { ...headers, 'tr_id': 'FHKST01010400' } })
    ]);

    const [priceData, investData, dailyData] = await Promise.all([
      priceRes.json(), investRes.json(), dailyRes.json()
    ]);

    const o = priceData?.output;
    const inv = investData?.output;
    const daily = dailyData?.output || [];

    if (o?.hts_kor_isnm) name = o.hts_kor_isnm;

    const price = parseInt(o?.stck_prpr || 0);
    const foreignNet = parseInt(inv?.frgn_ntby_qty || 0);

    // 기술적 분석
    const analysis = analyzeTechnical(daily, price, foreignNet);

    res.status(200).json({
      success: true,
      stock: {
        name, code,
        price: price.toLocaleString(),
        chgRate: parseFloat(o?.prdy_ctrt || 0).toFixed(2),
        chgAmt: parseInt(o?.prdy_vrss || 0).toLocaleString(),
        open: parseInt(o?.stck_oprc || 0).toLocaleString(),
        close: parseInt(o?.stck_clpr || 0).toLocaleString(),
        high: parseInt(o?.stck_hgpr || 0).toLocaleString(),
        low: parseInt(o?.stck_lwpr || 0).toLocaleString(),
        high52: parseInt(o?.stck_dryy_hgpr || 0).toLocaleString(),
        low52: parseInt(o?.stck_dryy_lwpr || 0).toLocaleString(),
        volume: parseInt(o?.acml_vol || 0).toLocaleString(),
        tradingValue: (parseInt(o?.acml_tr_pbmn || 0)/100000000).toFixed(0) + '억',
        marketCap: (parseInt(o?.hts_avls || 0)/100000000).toFixed(0) + '억',
        foreignNet: foreignNet.toLocaleString(),
        instNet: parseInt(inv?.orgn_ntby_qty || 0).toLocaleString(),
        personalNet: parseInt(inv?.indv_ntby_qty || 0).toLocaleString(),
        analysis
      }
    });

  } catch(e) {
    console.error('검색 오류:', e.message);
    res.status(200).json({ success: false, error: e.message });
  }
}
