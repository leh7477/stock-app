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

  // Redis 캐시 확인 (토큰 재발급 최소화)
  const cached = await timedFetch(`${redisUrl}/get/kiwoom_token`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  }).then(r => r.json());
  if (cached.result) return cached.result;

  // 신규 토큰 발급
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

  // 23시간 캐시
  await timedFetch(`${redisUrl}/set/kiwoom_token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: token, ex: 82800 }),
  });

  return token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  try {
    const token = await getKiwoomToken();

    // ka10131 — 기관외국인연속매매현황요청
    const data = await timedFetch(`${BASE}/api/dostk/frgnistt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'authorization': `Bearer ${token}`,
        'api-id': 'ka10131',
      },
      body: JSON.stringify({
        dt:          '1',   // 최근일
        mrkt_tp:     '001', // 코스피
        netslmt_tp:  '2',   // 순매수(고정값)
        stk_inds_tp: '0',   // 종목(주식)
        amt_qty_tp:  '0',   // 금액
        stex_tp:     '3',   // 통합
      }),
    }).then(r => r.json());

    console.log('[stocks] Kiwoom raw:', JSON.stringify(data).slice(0, 300));

    const list = data.orgn_frgnr_cont_trde_prst || [];
    if (list.length === 0) throw new Error('빈 응답: ' + JSON.stringify(data).slice(0, 200));

    const stocks = list.slice(0, 5).map((s, i) => {
      const orgAmt  = parseInt(String(s.orgn_nettrde_amt  || '0').replace(/,/g, '')) || 0;
      const frgAmt  = parseInt(String(s.frgnr_nettrde_amt || '0').replace(/,/g, '')) || 0;
      const chgRate = parseFloat(s.prid_stkpc_flu_rt || '0');
      const orgDays = parseInt(s.orgn_cont_netprps_dys  || '0');
      const frgDays = parseInt(s.frgnr_cont_netprps_dys || '0');

      // 시그널: 기관+외인 모두 순매수이고 주가 상승 → 매수
      const signal =
        orgAmt > 0 && frgAmt > 0 && chgRate > 0 ? 'buy' :
        orgAmt < 0 && frgAmt < 0               ? 'caution' : 'watch';
      const signalText =
        signal === 'buy' ? '상승 강세' : signal === 'caution' ? '하락 주의' : '보합';

      // 이유 문구 구성
      const parts = [];
      if (orgDays > 0) parts.push(`기관 ${orgDays}일 연속매수`);
      if (frgDays > 0) parts.push(`외인 ${frgDays}일 연속매수`);
      if (parts.length === 0) parts.push(`기관+외인 동반 수급`);

      // prid_stkpc_flu_rt를 가격 란에 표시 (현재가 미제공)
      const priceDisplay = chgRate >= 0
        ? `+${chgRate}%`
        : `${chgRate}%`;

      return {
        rank: i + 1,
        name: s.stk_nm || '-',
        price: priceDisplay,
        reason: parts.join(' · '),
        signal,
        signalText,
      };
    });

    res.status(200).json({ success: true, stocks });
  } catch (error) {
    console.error('[stocks] Kiwoom failed:', error.message);
    res.status(200).json({ success: true, stocks: [], _err: error.message });
  }
}
