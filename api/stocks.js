const BASE = 'https://api.kiwoom.com';
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

async function getKiwoomToken() {
  const redisUrl   = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  const cached = await timedFetch(`${redisUrl}/get/kiwoom_token`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  }).then(r => r.json());
  if (cached.result) return cached.result;

  const data = await timedFetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey:    process.env.KIWOOM_APP_KEY,
      secretkey: process.env.KIWOOM_SECRET_KEY,
    }),
  }).then(r => r.json());

  const token = data.token;
  if (!token) throw new Error('키움 토큰 발급 실패: ' + JSON.stringify(data));

  await timedFetch(`${redisUrl}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', 'kiwoom_token', token, 'EX', '82800']]),
  });

  return token;
}

async function fetchFromKiwoom() {
  const token = await getKiwoomToken();

  const data = await timedFetch(`${BASE}/api/dostk/frgnistt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'authorization': `Bearer ${token}`,
      'api-id': 'ka10131',
    },
    body: JSON.stringify({
      dt:          '1',
      mrkt_tp:     '001',
      netslmt_tp:  '2',
      stk_inds_tp: '0',
      amt_qty_tp:  '0',
      stex_tp:     '3',
    }),
  }).then(r => r.json());

  console.log('[stocks] Kiwoom raw:', JSON.stringify(data).slice(0, 300));

  const list = data.orgn_frgnr_cont_trde_prst || [];
  if (list.length === 0) throw new Error('빈 응답');

  return list.slice(0, 5).map((s, i) => {
    const orgAmt  = parseInt(String(s.orgn_nettrde_amt  || '0').replace(/,/g, '')) || 0;
    const frgAmt  = parseInt(String(s.frgnr_nettrde_amt || '0').replace(/,/g, '')) || 0;
    const chgRate = parseFloat(s.prid_stkpc_flu_rt || '0');
    const orgDays = parseInt(s.orgn_cont_netprps_dys  || '0');
    const frgDays = parseInt(s.frgnr_cont_netprps_dys || '0');

    const signal =
      orgAmt > 0 && frgAmt > 0 && chgRate > 0 ? 'buy' :
      orgAmt < 0 && frgAmt < 0               ? 'caution' : 'watch';
    const signalText =
      signal === 'buy' ? '상승 강세' : signal === 'caution' ? '하락 주의' : '보합';

    const parts = [];
    if (orgDays > 0) parts.push(`기관 ${orgDays}일 연속매수`);
    if (frgDays > 0) parts.push(`외인 ${frgDays}일 연속매수`);
    if (parts.length === 0) parts.push('기관+외인 동반 수급');

    const priceDisplay = chgRate >= 0 ? `+${chgRate}%` : `${chgRate}%`;

    return {
      rank: i + 1,
      name: s.stk_nm || '-',
      price: priceDisplay,
      reason: parts.join(' · '),
      signal,
      signalText,
    };
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const redisUrl   = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  // 1순위: Kiwoom 직접 호출 (등록 IP에서만 성공)
  try {
    const stocks = await fetchFromKiwoom();

    // 성공 시 Redis에 캐싱 (25시간)
    await timedFetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', 'kiwoom_stocks', JSON.stringify(stocks), 'EX', '90000']]),
    }).catch(() => {});

    return res.status(200).json({ success: true, stocks });
  } catch (e) {
    console.error('[stocks] Kiwoom failed:', e.message);
    var _kiwoomErr = e.message;
  }

  // 2순위: Redis 캐시 (사용자 PC에서 갱신한 마지막 데이터)
  try {
    const cached = await timedFetch(`${redisUrl}/get/kiwoom_stocks`, {
      headers: { Authorization: `Bearer ${redisToken}` },
    }).then(r => r.json());

    if (cached.result) {
      const raw = JSON.parse(cached.result);
      const stocks = raw.map(s => {
        // reason/signalText가 없으면 (PowerShell 갱신 스크립트 데이터) 여기서 생성
        if (!s.signalText) {
          const parts = [];
          if ((s.orgDays || 0) > 0) parts.push(`기관 ${s.orgDays}일 연속매수`);
          if ((s.frgDays || 0) > 0) parts.push(`외인 ${s.frgDays}일 연속매수`);
          s.reason = parts.length > 0 ? parts.join(' · ') : '기관+외인 동반 수급';
          s.signalText = s.signal === 'buy' ? '상승 강세' : s.signal === 'caution' ? '하락 주의' : '보합';
        }
        return s;
      });
      console.log('[stocks] returning cached data, count:', stocks.length);
      return res.status(200).json({ success: true, stocks, source: 'cache' });
    }
  } catch (e) {
    console.error('[stocks] cache read failed:', e.message);
  }

  res.status(200).json({ success: true, stocks: [], _err: _kiwoomErr });
}
