export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  try {
    // 1. 토큰 발급 - 실전투자 서버 규격에 맞게 헤더 보강
    const authRes = await fetch("https://openapi.koreainvestment.com:9443/oauth2/tokenP", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json; charset=UTF-8" 
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY.trim(), // 앞뒤 공백 강제 제거
        appsecret: process.env.KIS_APP_SECRET.trim()
      }),
    });

    const authData = await authRes.json();

    if (!authData.access_token) {
      console.error("한투 서버 거절 사유:", authData);
      return res.status(401).json({ 
        success: false, 
        msg: "한투 서버가 토큰 발급을 거절함",
        reason: authData.error_description 
      });
    }

    // 2. 수급 데이터 호출
    const supplyRes = await fetch("https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor", {
      method: "GET",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "authorization": `Bearer ${authData.access_token}`,
        "appkey": process.env.KIS_APP_KEY.trim(),
        "appsecret": process.env.KIS_APP_SECRET.trim(),
        "tr_id": "FHKST01010900", // 투자자별 매매동향
        "custtype": "P" // 개인 고객 설정
      }
    });

    const supplyData = await supplyRes.json();
    
    if (supplyData.output && supplyData.output.length > 0) {
      const data = supplyData.output[0];
      res.status(200).json({
        success: true,
        foreignNet: Math.round(parseInt(data.fore_ntby_qty) / 100), // 억 단위
        instNet: Math.round(parseInt(data.orgn_ntby_qty) / 100),
        isMock: false
      });
    } else {
      throw new Error("데이터 응답 형식이 다릅니다.");
    }

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
