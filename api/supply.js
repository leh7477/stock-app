export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  let foreignNet = 0;
  let instNet = 0;
  let isMock = false;

  try {
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
    console.log('토큰결과:', JSON.stringify(tokenData));
    const token = tokenData.access_token;
    if (!token) throw new Error('토큰없음: ' + JSON.stringify(tokenData));

    const supplyRes = await fetch(
      'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=0001',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'appkey': process.env.KIS_APP_KEY,
          'appsecret': process.env.KIS_APP_SECRET,
          'tr_id': 'FHKST01010900',
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );

    const supplyData = await supplyRes.json();
    console.log('수급결과:', JSON.stringify(supplyData));
    const output = supplyData?.output;
    foreignNet = parseInt(output?.frgn_ntby_qty || 0);
    instNet = parseInt(output?.orgn_ntby_qty || 0);

  } catch(e) {
    console.error('오류:', e.message);
    foreignNet = Math.round((Math.random()*6000-3000)/100)*100;
    instNet = Math.round((Math.random()*4000-2000)/100)*100;
    isMock = true;
  }

  res.status(200).json({ success: true, foreignNet, instNet, isMock });
}
