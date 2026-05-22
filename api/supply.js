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

// ── 1순위: NAVER 모바일 API (장 마감 후에도 당일 수급 제공) ──
async function getNaverInvestorData() {
  const res = await timedFetch('https://m.stock.naver.com/api/index/KOSPI/investorTrade', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      'Referer': 'https://m.stock.naver.com/',
    },
  });
  if (!res.ok) throw new Error(`NAVER investorTrade ${res.status}`);
  const data = await res.json();
  console.log('[supply] NAVER raw:', JSON.stringify(data).slice(0, 300));

  // 응답 형태: [{investorType, netBuyVolume, netBuyAmount, ...}, ...]
  const find = (type) => data.find(d => d.investorType === type || d.name?.includes(type));
  const foreign  = find('외국인') ?? find('frgn');
  const inst     = find('기관') ?? find('orgn');
  const personal = find('개인') ?? find('indv');

  const toAmt = (d) => {
    // netBuyAmount(억원) 우선, 없으면 netBuyVolume
    const v = d?.netBuyAmount ?? d?.netBuyVolume ?? d?.ntby_tr_pbmn ?? 0;
    return parseInt(v) || 0;
  };

  return {
    foreignNet:  toAmt(foreign)  * (foreign?.netBuyAmount !== undefined ? 100 : 1),
    instNet:     toAmt(inst)     * (inst?.netBuyAmount    !== undefined ? 100 : 1),
    personalNet: toAmt(personal) * (personal?.netBuyAmount !== undefined ? 100 : 1),
  };
}

// ── 2순위: KIS API (원본 로직 유지) ──
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

  await timedFetch(`${redisUrl}/set/kis_token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: token, ex: 82800 }),
  });
  return token;
}

async function getKisInvestorData() {
  const token = await getKisToken();
  const supplyData = await timedFetch(
    'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=0001',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        appkey:    process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
        tr_id: 'FHKST01010900',
        'Content-Type': 'application/json',
      },
    }
  ).then(r => r.json());

  console.log('[supply] KIS raw:', JSON.stringify(supplyData).slice(0, 300));

  const output = supplyData?.output;
  const foreignNet  = parseInt(output?.frgn_ntby_qty || 0);
  const instNet     = parseInt(output?.orgn_ntby_qty  || 0);
  const personalNet = parseInt(output?.indv_ntby_qty  || 0);

  // KIS가 0만 반환하면 의미 없는 데이터
  if (foreignNet === 0 && instNet === 0 && personalNet === 0) {
    throw new Error('KIS returned all zeros (likely after-hours)');
  }
  return { foreignNet, instNet, personalNet };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  // NAVER 시도 → KIS 시도 → isMock
  const sources = [
    { name: 'NAVER', fn: getNaverInvestorData },
    { name: 'KIS',   fn: getKisInvestorData   },
  ];

  for (const { name, fn } of sources) {
    try {
      const data = await fn();
      console.log(`[supply] success via ${name}:`, data);
      return res.status(200).json({ success: true, ...data, isMock: false });
    } catch (e) {
      console.error(`[supply] ${name} failed:`, e.message);
    }
  }

  // 둘 다 실패
  res.status(200).json({ success: true, foreignNet: 0, instNet: 0, personalNet: 0, isMock: true });
}
