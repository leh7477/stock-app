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

function getKstDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ── 1순위: KRX 공개 API (인증 불필요, 장 마감 후 확정 데이터 제공) ──
async function getKrxInvestorData() {
  const trdDd = getKstDateStr(0);

  const body = new URLSearchParams({
    bld:          'dbms/MDC/STAT/standard/MDCSTAT02303',
    mktId:        'STK',   // 코스피
    trdDd,
    share:        '1',
    money:        '1',
    csvxls_isNo:  'false',
  });

  const res = await timedFetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin':  'https://data.krx.co.kr',
      'Referer': 'https://data.krx.co.kr/',
      'User-Agent': 'Mozilla/5.0',
    },
    body: body.toString(),
  });

  const data = await res.json();
  console.log('[supply] KRX raw:', JSON.stringify(data).slice(0, 400));

  const rows = data.OutBlock_1 || [];
  if (rows.length === 0) throw new Error('KRX 데이터 없음 (장 전 또는 주말)');

  const find = (keyword) => rows.find(r =>
    (r.invstTpNm || r.ISU_NM || '').includes(keyword)
  );

  // KRX 금액 단위: 백만원 → renderSupply에서 /100 하면 억원
  const toVal = (row) => {
    const raw = row?.ntby_tr_pbmn ?? row?.NET_TR_PRC ?? '0';
    return parseInt(String(raw).replace(/,/g, '')) || 0;
  };

  const foreign  = find('외국인');
  const inst     = find('기관');
  const personal = find('개인');

  if (!foreign && !inst) throw new Error('KRX: 외국인/기관 행 없음');

  return {
    foreignNet:  toVal(foreign),
    instNet:     toVal(inst),
    personalNet: toVal(personal),
  };
}

// ── 2순위: KIS API (장중 실시간 전용) ──
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
    throw new Error('KIS 전부 0 (장 마감 후 실시간 API 미지원)');
  }
  return { foreignNet, instNet, personalNet };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const sources = [
    { name: 'KRX', fn: getKrxInvestorData },
    { name: 'KIS', fn: getKisInvestorData },
  ];

  for (const { name, fn } of sources) {
    try {
      const data = await fn();
      console.log(`[supply] success via ${name}:`, JSON.stringify(data));
      return res.status(200).json({ success: true, ...data, isMock: false, source: name });
    } catch (e) {
      console.error(`[supply] ${name} failed:`, e.message);
    }
  }

  res.status(200).json({ success: true, foreignNet: 0, instNet: 0, personalNet: 0, isMock: true });
}
