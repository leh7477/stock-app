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

    // 토큰 발급 제한(1분 1회)에 걸린 경우
    if (!authData.access_token) {
      return res.status(200).json({ 
        success: true, 
        personalNet: "대기", 
        foreignNet: "대기", 
        instNet: "대기" 
      });
    }

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
      // 숫자로 변환이 확실히 되도록 Number() 처리 및 억 단위 환산
      res.status(200).json({
        success: true,
        personalNet: Math.round(Number(v.pru_ntby_amt) / 100) || 0,
        foreignNet: Math.round(Number(v.frgn_ntby_amt) / 100) || 0,
        instNet: Math.round(Number(v.orgn_ntby_amt) / 100) || 0
      });
    } else {
      res.status(200).json({ success: true, personalNet: "점검", foreignNet: "점검", instNet: "점검" });
    }
  } catch (e) {
    res.status(200).json({ success: false, personalNet: "에러", foreignNet: "에러", instNet: "에러" });
  }
}
