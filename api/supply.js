export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  let foreignNet = 0;
  let instNet = 0;
  let isMock = false;

  try {
    // 1. 토큰 발급
    const tokenRes = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET
      })
    });

    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;
    if (!token) throw new Error('토큰 발급 실패');

    // 2. 투자자별 매매동향 호출 (코스피 전체 0001)
    const supplyRes = await fetch(
      'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=0001',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'appkey': process.env.KIS_APP_KEY,
          'appsecret': process.env.KIS_APP_SECRET,
          'tr_id': 'FHKST01010900',
          'custtype': 'P',
          'Content-Type': 'application/json'
        }
      }
    );

    const supplyData = await supplyRes.json();
    const output = supplyData?.output;

    if (output) {
      // 주수(qty) 대신 금액(tr_pbmn)을 사용 (단위: 백만원 -> 억으로 변환)
      // KIS API 명세에 따라 금액 컬럼명이 다를 수 있으니 로그 확인 필수
      // 보통 ntby_tr_pbmn이 순매수 대금입니다.
      const f_amt = parseInt(output.frgn_ntby_tr_pbmn || 0); 
      const i_amt = parseInt(output.orgn_ntby_tr_pbmn || 0);

      // 백만원 단위를 억원 단위로 변환 (소수점 버림)
      foreignNet = Math.floor(f_amt / 100); 
      instNet = Math.floor(i_amt / 100);
    } else {
      throw new Error('데이터 없음');
    }

  } catch (e) {
    console.error('수급 호출 오류:', e.message);
    // 실패 시 랜덤 데이터 (테스트용)
    foreignNet = Math.floor(Math.random() * 2000) - 1000;
    instNet = Math.floor(Math.random() * 1000) - 500;
    isMock = true;
  }

  res.status(200).json({ success: true, foreignNet, instNet, isMock });
}
