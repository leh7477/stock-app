export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    // 1. KIS 토큰 발급 (캐싱 없이 매번 발급 시 응답 속도가 느릴 수 있음)
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

    // 2. 외인 순매수 상위 종목 호출 (FHPST02210000)
    // fid_cond_mrkt_div_code: J(주식), fid_cond_scr_div_code: 20221(화면번호)
    const frgnRes = await fetch(
      'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/ranking/investor?fid_cond_mrkt_div_code=J&fid_cond_scr_div_code=20221&fid_input_iscd=0000&fid_div_cls_code=0&fid_statutory_cls_code=0&fid_trgt_cls_code=111111111&fid_trgt_exls_cls_code=000000&fid_input_price_1=0&fid_input_price_2=0&fid_vol_cnt=0&fid_input_date_1=',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'appkey': process.env.KIS_APP_KEY,
          'appsecret': process.env.KIS_APP_SECRET,
          'tr_id': 'FHPST02210000',
          'custtype': 'P', // 개인 고객 설정 추가
          'Content-Type': 'application/json'
        }
      }
    );
    
    const frgnData = await frgnRes.json();
    
    // 응답 데이터가 정상인지 확인
    if (frgnData.rt_cd !== '0' || !frgnData.output) {
      throw new Error(frgnData.msg1 || '데이터 로드 실패');
    }

    const items = frgnData.output.slice(0, 5);

    const stocks = items.map((s, i) => {
      const name = s.hts_kor_isnm || '알 수 없는 종목';
      const price = parseInt(s.stck_prpr || 0);
      const frgnNet = parseInt(s.frgn_ntby_qty || 0);
      const frgnAvg = parseInt(s.frgn_avg_pchs_pric || 0);
      
      let signal = 'watch';
      let signalText = '관심 종목';
      let reason = `외인 순매수 ${frgnNet.toLocaleString()}주`;

      if (frgnAvg > 0) {
        const diff = parseFloat(((price - frgnAvg) / frgnAvg * 100).toFixed(1));
        
        if (diff < -2) {
          signal = 'buy';
          signalText = '매수 매력';
          reason = `외인 평단 대비 ${Math.abs(diff)}% 저평가 · 매수 우위`;
        } else if (diff > 5) {
          signal = 'caution';
          signalText = '주의';
          reason = `외인 평단 대비 ${diff}% 고평가 · 차익실현 경계`;
        } else {
          reason = `외인 평단가 부근 (${diff}%) · 수급 유입 중`;
        }
      }

      return {
        rank: i + 1,
        name,
        price: price > 0 ? price.toLocaleString() + '원' : '-',
        reason,
        signal,
        signalText
      };
    });

    res.status(200).json({ success: true, stocks });

  } catch (error) {
    console.error('추천주 실데이터 호출 실패:', error.message);
    
    // API 실패 시 Fallback (샘플 데이터) 반환 로직은 유지하되 
    // isMock 플래그를 정확히 줌
    res.status(200).json({
      success: true,
      isMock: true, 
      stocks: [
        { rank: 1, name: '삼성전자', reason: '서버 연결 지연으로 샘플 데이터 표시', price: '82,500원', signal: 'buy', signalText: '매수 매력' },
        { rank: 2, name: 'SK하이닉스', reason: '외인 순매수 지속 유입 중', price: '182,100원', signal: 'buy', signalText: '매수 매력' },
        { rank: 3, name: '현대차', reason: '밸류업 프로그램 수혜 기대', price: '251,000원', signal: 'watch', signalText: '관심 종목' }
      ]
    });
  }
}
