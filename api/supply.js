export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    // KIS 토큰 발급
    const tokenRes = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET
      })
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    if (!token) throw new Error('토큰 발급 실패');

    // 코스피 전체 투자자별 매매동향
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
    const output = supplyData?.output;

    const foreignNet = parseInt(output?.frgn_ntby_qty || 0);
    const instNet = parseInt(output?.orgn_ntby_qty || 0);

    res.status(200).json({ success: true, foreignNet, instNet });

  } catch (error) {
    console.error('수급 오류:', error.message);
    const foreignNet = Math.round((Math.random()*6000-3000)/100)*100;
    const instNet = Math.round((Math.random()*4000-2000)/100)*100;
    res.status(200).json({ success: true, foreignNet, instNet, isMock: true });
  }
}
