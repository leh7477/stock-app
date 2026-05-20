// 서버가 켜져 있는 동안 토큰을 저장할 변수 (메모리 캐싱)
let cachedToken = null;
let tokenExpireTime = 0;

export default async function handler(req, res) {
  try {
    const now = Date.now();

    // 1. 토큰이 없거나 만료되었다면 (유효기간 24시간 중 여유있게 20시간 설정) 새로 발급
    if (!cachedToken || now > tokenExpireTime) {
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
        // 현재 시간 + 20시간 뒤를 만료 시간으로 설정 (한투 토큰은 보통 24시간 유효)
        tokenExpireTime = now + (20 * 60 * 60 * 1000);
        console.log("새 토큰 발급 완료");
      } else {
        return res.status(500).json({ success: false, msg: "토큰 발급 실패" });
      }
    } else {
      console.log("기존 토큰 재사용 중");
    }

    // 2. 저장된 토큰(cachedToken)으로 수급 데이터 호출
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
      res.status(200).json({
        success: true,
        personalNet: Math.round(Number(v.pru_ntby_amt) / 100),
        foreignNet: Math.round(Number(v.frgn_ntby_amt) / 100),
        instNet: Math.round(Number(v.orgn_ntby_amt) / 100)
      });
    } else {
      res.status(500).json({ success: false, msg: "데이터 없음" });
    }
  } catch (e) {
    res.status(500).json({ success: false, msg: "서버 에러" });
  }
}
