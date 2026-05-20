async function getKisToken() {
  // Upstash Redis에서 토큰 조회
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  // 저장된 토큰 확인
  const getRes = await fetch(`${redisUrl}/get/kis_token`, {
    headers: { Authorization: `Bearer ${redisToken}` }
  });
  const getData = await getRes.json();
  
  if (getData.result) {
    console.log('캐시된 토큰 사용');
    return getData.result;
  }

  // 토큰 없으면 새로 발급
  console.log('새 토큰 발급');
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
  if (!token) throw new Error('토큰 발급 실패: ' + JSON.stringify(tokenData));

  // 토큰을 Redis에 저장 (23시간 유지)
  await fetch(`${redisUrl}/set/kis_token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ value: token, ex: 82800 })
  });

  return token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  let foreignNet = 0;
  let instNet = 0;
  let personalNet = 0;
  let isMock = false;

  try {
    const token = await getKisToken();

    const supplyRes = await fetch(
      'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=0001',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'appkey': process.env.KIS_APP_KEY,
          'appsecret': process.env.KIS_APP_SECRET,
          'tr_id': 'FHKST01010900',
          'Content-Type': 'application/json'
        }
      }
    );

    const supplyData = await supplyRes.json();
    console.log('수급 응답:', JSON.stringify(supplyData));
    const output = supplyData?.output;

    foreignNet = parseInt(output?.frgn_ntby_qty || 0);
    instNet = parseInt(output?.orgn_ntby_qty || 0);
    personalNet = parseInt(output?.indv_ntby_qty || 0);

  } catch(e) {
    console.error('수급 오류:', e.message);
    foreignNet = Math.round((Math.random()*6000-3000)/100)*100;
    instNet = Math.round((Math.random()*4000-2000)/100)*100;
    personalNet = Math.round((Math.random()*4000-2000)/100)*100;
    isMock = true;
  }

  res.status(200).json({ success: true, foreignNet, instNet, personalNet, isMock });
}
