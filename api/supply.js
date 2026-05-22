const TIMEOUT_MS = 7000;

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
  const redisUrl   = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  const getData = await timedFetch(`${redisUrl}/get/kis_token`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  }).then(r => r.json());
  if (getData.result) return getData.result;

  const tokenData = await timedFetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
    }),
  }).then(r => r.json());

  const token = tokenData.access_token;
  if (!token) throw new Error('KIS 토큰 발급 실패');

  // Redis에 토큰 저장 (pipeline SET ... EX)
  await timedFetch(`${redisUrl}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', 'kis_token', token, 'EX', '82800']]),
  });
  return token;
}

async function getKisInvestorData() {
  const token = await getKisToken();
  const data = await timedFetch(
    'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=0001',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        appkey:    process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
        tr_id:     'FHKST01010900',
        'Content-Type': 'application/json',
      },
    }
  ).then(r => r.json());

  console.log('[supply] KIS raw:', JSON.stringify(data).slice(0, 300));

  const output     = data?.output;
  const foreignNet  = parseInt(output?.frgn_ntby_qty || 0);
  const instNet     = parseInt(output?.orgn_ntby_qty  || 0);
  const personalNet = parseInt(output?.indv_ntby_qty  || 0);

  if (foreignNet === 0 && instNet === 0 && personalNet === 0) {
    throw new Error('KIS 전부 0 (장 마감 후)');
  }
  return { foreignNet, instNet, personalNet };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const redisUrl   = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  // 1순위: KIS 장중 실시간
  try {
    const data = await getKisInvestorData();
    console.log('[supply] KIS success:', JSON.stringify(data));

    // 성공 시 Redis에 캐싱 (25시간 — 다음 영업일 장중까지 유효)
    await timedFetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['SET', 'supply_cache', JSON.stringify(data), 'EX', '90000'],
      ]),
    }).catch(() => {});

    return res.status(200).json({ success: true, ...data, isMock: false, source: 'KIS' });
  } catch (e) {
    console.error('[supply] KIS failed:', e.message);
  }

  // 2순위: Redis 캐시 (전날/당일 장중 마지막 값)
  try {
    const cached = await timedFetch(`${redisUrl}/get/supply_cache`, {
      headers: { Authorization: `Bearer ${redisToken}` },
    }).then(r => r.json());

    if (cached.result) {
      const data = JSON.parse(cached.result);
      console.log('[supply] returning cached data');
      return res.status(200).json({ success: true, ...data, isMock: false, source: 'cache' });
    }
  } catch (e) {
    console.error('[supply] cache read failed:', e.message);
  }

  res.status(200).json({ success: true, foreignNet: 0, instNet: 0, personalNet: 0, isMock: true });
}
