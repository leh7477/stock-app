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
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const timeNum = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  return timeNum >= 900 && timeNum <= 1530;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  let foreignNet = 0, instNet = 0, personalNet = 0;
  let isMock = false;

  try {
    const token = await getKisToken();

    const supplyRes = await timedFetch(
      'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=0001',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          appkey: process.env.KIS_APP_KEY,
          appsecret: process.env.KIS_APP_SECRET,
          tr_id: 'FHKST01010900',
          'Content-Type': 'application/json',
        },
      }
    );
    const supplyData = await supplyRes.json();

    // output은 단일 객체 (배열 아님) — 이전 버전에서 output[0]으로 잘못 접근해서 항상 0이었음
    const output = supplyData?.output;
    foreignNet  = parseInt(output?.frgn_ntby_qty || 0);
    instNet     = parseInt(output?.orgn_ntby_qty  || 0);
    personalNet = parseInt(output?.indv_ntby_qty  || 0);

  } catch (e) {
    console.error('수급 오류:', e.message);
    isMock = true;
  }

  res.status(200).json({ success: true, foreignNet, instNet, personalNet, isMock });
}
