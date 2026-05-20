export default async function handler(req, res) {
  try {
    // 1. 토큰 발급
    const authRes = await fetch("https://openapi.koreainvestment.com:9443/oauth2/tokenP", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY.trim(),
        appsecret: process.env.KIS_APP_SECRET.trim()
      }),
    });
    const { access_token } = await authRes.json();

    // 2. 거래량 순위 조회 API 호출 (tr_id: FHPST01710000)
    const rankRes = await fetch(
      "https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/ranking/volume?FID_COND_MRKT_DIV_CODE=J&FID_COND_SCR_DIV_CODE=20171&FID_INPUT_ISCD=0000&FID_DIV_CLS_CODE=0&FID_BLNG_CLS_CODE=0&FID_TRGT_CLS_CODE=0&FID_TRGT_EXLS_CLS_CODE=0&FID_INPUT_PRICE_1=&FID_INPUT_PRICE_2=&FID_VOL_CNT=",
      {
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${access_token}`,
          "appkey": process.env.KIS_APP_KEY.trim(),
          "appsecret": process.env.KIS_APP_SECRET.trim(),
          "tr_id": "FHPST01710000",
          "custtype": "P"
        }
      }
    );

    const rankData = await rankRes.json();

    if (rankData.output && rankData.output.length > 0) {
      // 상위 5개 종목만 추출하여 화면 규격에 맞게 변환
      const topStocks = rankData.output.slice(0, 5).map(item => ({
        name: item.hts_kor_isnm,         // 종목명
        code: item.mksc_shrn_iscd,      // 종목코드
        sector: "거래량 " + Number(item.avrg_vol).toLocaleString() + "주", // 거래량 정보
        price: Number(item.stck_prpr).toLocaleString(), // 현재가
        change: `${item.prdy_ctrt}%`,    // 등락률
        trend: Number(item.prdy_vrss) > 0 ? "up" : "down" // 상승/하락 여부
      }));

      res.status(200).json({ success: true, stocks: topStocks });
    } else {
      res.status(200).json({ success: true, stocks: [] });
    }

  } catch (e) {
    console.error("추천주 에러:", e);
    res.status(200).json({ success: false, stocks: [] });
  }
}
