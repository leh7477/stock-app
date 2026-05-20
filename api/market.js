let cachedToken = null;
let tokenExpireTime = 0;

export default async function handler(req, res) {
  // 캐시 헤더 추가 (브라우저가 30초 동안은 서버에 묻지도 않고 지 화면 꺼 쓰게 함)
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=30');

  try {
    const now = Date.now();
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

    // 여러 API를 동시에 찌름 (순차 x, 병렬 o)
    const [kospiRes, usdRes] = await Promise.all([
      fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-index-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=0001`, {
        headers: { "content-type": "application/json", "authorization": `Bearer ${cachedToken}`, "appkey": process.env.KIS_APP_KEY, "appsecret": process.env.KIS_APP_SECRET, "tr_id": "FHKST01010100" }
      }),
      fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-price?FID_COND_MRKT_DIV_CODE=F&FID_INPUT_ISCD=FX@KRW&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`, {
        headers: { "content-type": "application/json", "authorization": `Bearer ${cachedToken}`, "appkey": process.env.KIS_APP_KEY, "appsecret": process.env.KIS_APP_SECRET, "tr_id": "FHKST03030100" }
      })
    ]);

    const kData = await kospiRes.json();
    const uData = await usdRes.json();

    res.status(200).json({
      success: true,
      kospi: { val: kData.output.stck_prpr, chg: kData.output.prdy_ctrt },
      usd: { val: uData.output[0].ovrs_nmix_prpr, chg: uData.output[0].prdy_ctrt },
      rate: "3.50%"
    });
  } catch (e) {
    res.status(200).json({ success: false });
  }
}
