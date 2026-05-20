// 서버 메모리에 토큰 저장 (알림톡 최소화)
let cachedToken = "";
let tokenExpireTime = 0;

export default async function handler(req, res) {
  try {
    const now = Date.now();

    // 1. 토큰 갱신 (만료 1시간 전까지만 재사용)
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
      } else {
        // 토큰 발급 실패 시 0이 아니라 실패 사유를 보냄
        return res.status(500).json({ success: false, msg: "TOKEN_FAIL", detail: authData });
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
    
    if (data.output && data.output.length > 0) {
      const v = data.output[0];
      // 숫자가 없으면 0이 아니라 null로 보냄
      res.status(200).json({
        success: true,
        personalNet: v.pru_ntby_amt ? Math.round(Number(v.pru_ntby_amt) / 100) : null,
        foreignNet: v.frgn_ntby_amt ? Math.round(Number(v.frgn_ntby_amt) / 100) : null,
        instNet: v.orgn_ntby_amt ? Math.round(Number(v.orgn_ntby_amt) / 100) : null
      });
    } else {
      // 데이터가 없으면 에러로 처리
      res.status(500).json({ success: false, msg: "NO_DATA", raw: data });
    }
  } catch (e) {
    // 에러 발생 시 0을 주지 않고 에러 내용을 보냄
    res.status(500).json({ success: false, msg: "SERVER_ERROR", error: e.message });
  }
}
