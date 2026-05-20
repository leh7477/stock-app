export default async function handler(req, res) {
  // 캐시 방지
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  try {
    // 1. KIS 접근 토큰 발급 (수급 데이터를 가져오기 위한 통행증)
    const authRes = await fetch("https://openapi.koreainvestment.com:9443/oauth2/tokenP", {
      method: "POST",
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
      }),
    });
    const authData = await authRes.json();
    const token = authData.access_token;

    if (!token) throw new Error("KIS 토큰 발급 실패. 앱키와 비밀키를 확인하세요.");

    // 2. 투자자별 매매동향 API 호출 (코스피 기준)
    // [항목코드] 0001: 코스피, 1001: 코스닥
    const supplyRes = await fetch("https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor", {
      headers: {
        "Content-Type": "application/json",
        "authorization": `Bearer ${token}`,
        "appkey": process.env.KIS_APP_KEY,
        "appsecret": process.env.KIS_APP_SECRET,
        "tr_id": "FHKST01010900", // 투자자별 매매동향 TR ID
      }
    });

    const supplyData = await supplyRes.json();
    
    // 3. 데이터 파싱 (단위: 억 원으로 변환)
    // output[0]은 현재 시점의 데이터를 담고 있습니다.
    const foreignNet = Math.round(parseInt(supplyData.output[0].fore_ntby_qty) / 100); 
    const instNet = Math.round(parseInt(supplyData.output[0].orgn_ntby_qty) / 100);

    res.status(200).json({
      success: true,
      foreignNet: foreignNet, // 외국인 순매수합계
      instNet: instNet,      // 기관 순매수합계
      isMock: false          // 이제 진짜 데이터이므로 false
    });

  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: "수급 데이터 호출 실패", 
      detail: error.message 
    });
  }
}
