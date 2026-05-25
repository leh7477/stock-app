/**
 * KIS API 응답 필드 확인용 디버그 엔드포인트
 * /api/debug-kis?code=005930 으로 호출
 * 실제 응답 필드 목록 + 샘플값 반환
 */

async function getKisToken() {
  const redisUrl   = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  const cached = await fetch(`${redisUrl}/get/kis_token`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  }).then(r => r.json());
  if (cached.result) return cached.result;

  const data = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
  }).then(r => r.json());
  return data.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const code = req.query?.code || '005930'; // 기본: 삼성전자

  try {
    const token = await getKisToken();
    const H = (trId) => ({
      Authorization: `Bearer ${token}`,
      appkey:        process.env.KIS_APP_KEY,
      appsecret:     process.env.KIS_APP_SECRET,
      'tr_id':       trId,
      custtype:      'P',
      'Content-Type': 'application/json',
    });

    // ① FHKST01010400 일봉 (기존에 쓰는 것) → output2[0] 필드 확인
    const daily = await fetch(
      `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-price` +
      `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}&fid_input_date_1=&fid_input_date_2=&fid_period_div_code=D&fid_org_adj_prc=0`,
      { headers: H('FHKST01010400') }
    ).then(r => r.json()).catch(e => ({ _error: e.message }));

    // ② FHKST01010900 투자자현황 (기존에 쓰는 것) → output / output2 필드 확인
    const investor = await fetch(
      `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor` +
      `?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`,
      { headers: H('FHKST01010900') }
    ).then(r => r.json()).catch(e => ({ _error: e.message }));

    // 일봉은 output (배열) 에 있음
    const dailyRow  = Array.isArray(daily?.output)  ? daily.output[0]  : daily?.output;
    // 투자자는 output (배열, 30일치) 에 있음
    const invRow    = Array.isArray(investor?.output) ? investor.output[0] : investor?.output;
    const invRow2   = investor?.output2?.[0] ?? null;

    const result = {
      code,
      // ① 일봉 output[0] 필드 목록 + 값
      daily_output_fields: dailyRow
        ? Object.entries(dailyRow).map(([k, v]) => `${k}: ${v}`)
        : `없음 (rt_cd=${daily?.rt_cd}, msg=${daily?.msg1})`,
      daily_output_count: Array.isArray(daily?.output) ? daily.output.length : (daily?.output ? 1 : 0),

      // ② 투자자 output[0] 필드 목록 + 값 (가장 최근 1일)
      investor_output0_fields: invRow
        ? Object.entries(invRow).map(([k, v]) => `${k}: ${v}`)
        : `없음 (rt_cd=${investor?.rt_cd}, msg=${investor?.msg1})`,
      investor_output_count: Array.isArray(investor?.output) ? investor.output.length : 0,

      // ② 투자자 output2 필드 (혹시 있는 경우)
      investor_output2_fields: invRow2
        ? Object.entries(invRow2).map(([k, v]) => `${k}: ${v}`)
        : `output2 없음`,
    };

    return res.status(200).json(result);
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
}
