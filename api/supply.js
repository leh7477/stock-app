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

function isMarketOpen() {
  const kst = new Date(Date.now() + 9 * 3600000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hhmm = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  return hhmm >= 900 && hhmm <= 1530;
}

function getTodayKST() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  // 장 마감 후에는 데이터가 안 바뀌므로 더 길게 캐시 가능하지만 단순하게 5분 통일
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  try {
    const token = await getKisToken();
    const kisHeaders = {
      Authorization: `Bearer ${token}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      'Content-Type': 'application/json',
    };

    let foreignNet, instNet, personalNet;

    if (isMarketOpen()) {
      // 실시간 수급
      const url = 'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=0001';
      const r = await timedFetch(url, { headers: { ...kisHeaders, tr_id: 'FHKST01010900' } });
      const d = await r.json();
      const row = d?.output?.[0] ?? {};
      foreignNet  = parseInt(row.frgn_ntby_qty  || 0);
      instNet     = parseInt(row.orgn_ntby_qty   || 0);
      personalNet = parseInt(row.indv_ntby_qty   || 0);
    } else {
      // 일별 수급
      const today = getTodayKST();
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?fid_cond_mrkt_div_code=J&fid_input_iscd=0001&fid_input_date_1=${today}&fid_input_date_2=${today}&fid_period_div_code=D&fid_org_adj_prc=0`;
      const r = await timedFetch(url, { headers: { ...kisHeaders, tr_id: 'FHKST03010100' } });
      const d = await r.json();
      const row = d?.output2?.[0] ?? {};
      foreignNet  = parseInt(row.frgn_ntby_qty  || 0);
      instNet     = parseInt(row.orgn_ntby_qty   || 0);
      personalNet = parseInt(row.indv_ntby_qty   || 0);
    }

    res.status(200).json({ success: true, foreignNet, instNet, personalNet, isMock: false });
  } catch (error) {
    console.error('수급 오류:', error.message);
    // 폴백: 빈 값 대신 isMock 플래그와 함께 0 반환해 UI가 깨지지 않도록
    res.status(200).json({ success: true, foreignNet: 0, instNet: 0, personalNet: 0, isMock: true });
  }
}
