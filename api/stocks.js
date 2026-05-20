let cachedToken = null;
let tokenExpireTime = 0;

export default async function handler(req, res) {
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

    // 거래량 상위 조회 API (tr_id: FHPST01710000)
    const rankRes = await fetch(
      "https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/ranking/volume?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20171&FID_INPUT_ISCD=0000&FID_DIV_CLS_CODE=0&FID_BLNG_CLS_CODE=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_INPUT_PRICE_1=&FID_INPUT_PRICE_2=&FID_VOL_CNT=",
      {
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${cachedToken}`, // 캐시된 토큰 사용
          "appkey": process.env.KIS_APP_KEY.trim(),
          "appsecret": process.env.KIS_APP_SECRET.trim(),
          "tr_id": "FHPST01710000",
          "custtype": "P"
        }
      }
    );

    const rankData = await rankRes.json();
    const topStocks = rankData.output.slice(0, 5).map(item => ({
      name: item.hts_kor_isnm,
      price: Number(item.stck_prpr).toLocaleString(),
      change: `${item.prdy_ctrt}%`,
      trend: Number(item.prdy_vrss) > 0 ? "up" : "down",
      sector: "거래량 " + Math.round(Number(item.avrg_vol)/10000) + "만주"
    }));

    res.status(200).json({ success: true, stocks: topStocks });
  } catch (e) {
    res.status(200).json({ success: false, stocks: [] });
  }
}
