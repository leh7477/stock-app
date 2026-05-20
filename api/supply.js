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

    if (!authData.access_token) {
      // 1분 제한에 걸린 경우 가짜 데이터 대신 0으로 표시 (앱 유지)
      return res.status(200).json({ success: true, foreignNet: 0, instNet: 0, msg: "대기 중" });
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
    res.status(200).json({
      success: true,
      foreignNet: Math.round(parseInt(data.output[0].fore_ntby_qty) / 100),
      instNet: Math.round(parseInt(data.output[0].orgn_ntby_qty) / 100)
    });
  } catch (e) {
    res.status(200).json({ success: true, foreignNet: 0, instNet: 0 });
  }
}
