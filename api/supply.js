let cachedToken = "";
let tokenExpireTime = 0;

export default async function handler(req, res) {
  try {
    const now = Date.now();

    // 1. 토큰 재사용 로직
    if (!cachedToken || now > (tokenExpireTime - 3600000)) {
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
      
      if (authData.access_token) {
        cachedToken = authData.access_token;
        tokenExpireTime = now + (authData.expires_in * 1000);
        console.log("✅ 새 토큰 발급 성공");
      } else {
        console.error("❌ 토큰 발급 실패:", authData);
        return res.status(500).json({ success: false, msg: "TOKEN_ERROR", detail: authData });
      }
    }

    // 2. 수급 데이터 호출
    const supplyRes = await fetch("https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor", {
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${cachedToken}`,
        "appkey": process.env.KIS_APP_KEY.trim(),
        "appsecret": process.env.KIS_APP_SECRET.trim(),
        "tr_id": "FHKST01010900",
        "custtype": "P"
      }
    });

    const data = await supplyRes.json();
    
    // 3. 한투 응답 데이터 검증 (핵심!)
    if (data.output && data.output.length > 0) {
      const v = data.output[0];
      return res.status(200).json({
        success: true,
        personalNet: v.pru_ntby_amt ? Math.round(Number(v.pru_ntby_amt) / 100) : null,
        foreignNet: v.frgn_ntby_amt ? Math.round(Number(v.frgn_ntby_amt) / 100) : null,
        instNet: v.orgn_ntby_amt ? Math.round(Number(v.orgn_ntby_amt) / 100) : null
      });
    } else {
      // 여기가 500 에러의 주범일 가능성이 큼
      console.error("❌ 한투 데이터 응답 이상:", data);
      return res.status(500).json({ success: false, msg: "API_RESPONSE_ERROR", raw: data });
    }
  } catch (e) {
    console.error("❌ 서버 내부 에러:", e.message);
    return res.status(500).json({ success: false, msg: "SERVER_CRASH", error: e.message });
  }
}
