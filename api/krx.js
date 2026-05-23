const TIMEOUT_MS = 7000;
const KRX_BASE = 'https://openapi.krx.co.kr';

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

function latestTradingDate() {
  const now = new Date(Date.now() + 9 * 3600 * 1000); // KST
  const hour = now.getUTCHours();
  // 15:30 KST (06:30 UTC) 이전이면 전일 날짜
  if (hour < 6 || (hour === 6 && now.getUTCMinutes() < 30)) {
    now.setUTCDate(now.getUTCDate() - 1);
  }
  const dow = now.getUTCDay();
  if (dow === 0) now.setUTCDate(now.getUTCDate() - 2); // 일 → 금
  if (dow === 6) now.setUTCDate(now.getUTCDate() - 1); // 토 → 금
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

export async function getKrxInvestorData() {
  const apiKey = process.env.KRX_API_KEY;

  // 1. 토큰 발급
  const tokenRes = await timedFetch(`${KRX_BASE}/contents/COM/GenerateTokenP.jspx`, {
    method: 'POST',
    headers: { 'AUTH_KEY': apiKey },
  }).then(r => r.json());

  const token = tokenRes.output?.TOKEN;
  if (!token) throw new Error('KRX 토큰 없음: ' + JSON.stringify(tokenRes).slice(0, 200));

  // 2. KOSPI 투자자별 매매동향
  const trdDd = latestTradingDate();
  const dataRes = await timedFetch(
    `${KRX_BASE}/contents/MDI/StatisticsSearch/MDIs0020202/MDIs0020202_ALL?trdDd=${trdDd}&mktId=STK`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  ).then(r => r.json());

  console.log('[krx] raw:', JSON.stringify(dataRes).slice(0, 500));

  // 투자자 유형별 순매수 파싱 (응답 구조에 따라 조정 필요)
  const list = dataRes.output || dataRes.OutBlock_1 || dataRes.items || [];

  // 개인(01), 외국인(02), 기관(04) 순매수 추출
  let foreignNet = 0, instNet = 0, personalNet = 0;
  for (const row of list) {
    const tp = row.CONV_OBJ_TP_CD || row.invstTpCd || row.investor_type || '';
    const net = parseInt((row.NETBNS_TRDVAL || row.netBuyAmt || row.net_buy || '0').replace(/,/g, '')) || 0;
    if (tp === '01' || tp === '1') personalNet = net;
    else if (tp === '02' || tp === '2') foreignNet = net;
    else if (tp === '04' || tp === '4') instNet = net;
  }

  if (foreignNet === 0 && instNet === 0 && personalNet === 0) {
    throw new Error('KRX 파싱 실패 또는 데이터 없음, trdDd=' + trdDd + ', list=' + JSON.stringify(list).slice(0, 200));
  }

  return { foreignNet, instNet, personalNet, trdDd };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  try {
    const data = await getKrxInvestorData();
    res.status(200).json({ success: true, ...data, source: 'KRX' });
  } catch (e) {
    console.error('[krx]', e.message);
    res.status(200).json({ success: false, error: e.message });
  }
}
