async function getKisToken() {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  const getRes = await fetch(`${redisUrl}/get/kis_token`, {
    headers: { Authorization: `Bearer ${redisToken}` }
  });
  const getData = await getRes.json();
  if (getData.result) return getData.result;

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

  await fetch(`${redisUrl}/set/kis_token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: token, ex: 82800 })
  });

  return token;
}

function isMarketOpen() {
  // 한국 시간 기준 09:00 ~ 15:30
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hours = kst.getUTCHours();
  const minutes = kst.getUTCMinutes();
  const day = kst.getUTCDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return false;
  const timeNum = hours * 100 + minutes;
  return timeNum >= 900 && timeNum <= 1530;
}

function getTodayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth()+1).padStart(2,'0');
  const d = String(kst.getUTCDate()).padStart(2,'0');
  return `${y}${m}${d}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  let foreignNet = 0, instNet = 0, personalNet = 0;
  let isMock = false;

  try {
    const token = await getKisToken();
    const today = getTodayKST();
    const marketOpen = isMarketOpen();

    let supplyRes;

    if (marketOpen) {
      // 장중: 실시간 투자자별 매매동향
      console.log('장중 실시간 수급 조회');
      supplyRes = await fetch(
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
      console.log('실시간 수급:', JSON.stringify(supplyData));
      const output = supplyData?.output;
      foreignNet = parseInt(output?.frgn_ntby_qty || 0);
      instNet = parseInt(output?.orgn_ntby_qty || 0);
      personalNet = parseInt(output?.indv_ntby_qty || 0);

    } else {
      // 장 마감 후: 일별 투자자 매매동향
      console.log('장 마감 후 일별 수급 조회');
      supplyRes = await fetch(
        `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=0001`,
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
      console.log('마감 수급:', JSON.stringify(supplyData));
      const output = supplyData?.output;
      foreignNet = parseInt(output?.frgn_ntby_qty || 0);
      instNet = parseInt(output?.orgn_ntby_qty || 0);
      personalNet = parseInt(output?.indv_ntby_qty || 0);
    }

  } catch(e) {
    console.error('수급 오류:', e.message);
    isMock = true;
  }

  res.status(200).json({ success: true, foreignNet, instNet, personalNet, isMock });
}
