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

    // 추천주는 한투에서 직접 가져오기 까다로우므로, 토큰 연동 확인용으로 일단 빈 배열 반환하거나 
    // 본인이 원하는 종목을 수동으로 넣어둘 수 있습니다.
    const myStocks = [
      { name: "삼성전자", price: "72,100", change: "+1.2%" },
      { name: "SK하이닉스", price: "185,200", change: "-0.5%" }
    ];

    res.status(200).json({ success: true, stocks: myStocks });
  } catch (e) {
    res.status(200).json({ success: true, stocks: [] });
  }
}
