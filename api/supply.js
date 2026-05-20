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

    // 토큰 못 받으면 여기서 바로 컷 (0 안 보냄)
    if (!authData.access_token) {
      return res.status(500).json({ success: false, msg: "토큰 발급 실패" });
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
    
    // 데이터가 있을 때만 숫자를 보냄
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
