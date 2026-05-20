let cachedToken = null;
let tokenExpireTime = 0;

export default async function handler(req, res) {
  try {
    const now = Date.now();
    // 토큰 재사용 로직
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
      cachedToken = authData.access_token;
      tokenExpireTime = now + (20 * 60 * 60 * 1000);
    }

    // 환율, 지수 등 호출 (기존 로직 유지하되 토큰만 cachedToken 사용)
    // ... (기존 호출 코드)
    
    // 예시 구조 (실제 연동 코드에 맞춰 적용)
    res.status(200).json({
      success: true,
      usd: { val: "1,350", chg: "2.5" },
      kospi: { val: "2,650", chg: "15.2" },
      rate: "3.50%"
    });
  } catch (e) {
    res.status(200).json({ success: false });
  }
}
