export default async function handler(req, res) {
  try {
    const authRes = await fetch("https://openapi.koreainvestment.com:9443/oauth2/tokenP", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY.trim(),
        appsecret: process.env.KIS_APP_SECRET.trim()
      }),
    });
    const authData = await authRes.json();

    const supplyRes = await fetch("https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor", {
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${authData.access_token}`,
        "appkey": process.env.KIS_APP_KEY.trim(),
        "appsecret": process.env.KIS_APP_SECRET.trim(),
        "tr_id": "FHKST01010900",
        "custtype": "P"
      }
    });

    const data = await supplyRes.json();
    
    if (data.output && data.output.length > 0) {
      const v = data.output[0];
      // 한투 API 금액 단위는 보통 '백만원'입니다. 이를 '억'으로 환산 (/100)
      res.status(200).json({
        success: true,
        personalNet: Math.round(Number(v.pru_ntby_amt) / 100), // 개인
        foreignNet: Math.round(Number(v.frgn_ntby_amt) / 100),  // 외인
        instNet: Math.round(Number(v.orgn_ntby_amt) / 100)      // 기관
      });
    } else {
      res.status(200).json({ success: true, personalNet: 0, foreignNet: 0, instNet: 0 });
    }
  } catch (e) {
    res.status(200).json({ success: true, personalNet: 0, foreignNet: 0, instNet: 0 });
  }
}
