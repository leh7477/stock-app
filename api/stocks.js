export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    // KIS 토큰 발급
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

    // 외인 순매수 상위 종목 자동으로 가져오기
    const frgnRes = await fetch(
      'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/ranking/investor?fid_cond_mrkt_div_code=J&fid_cond_scr_div_code=20221&fid_input_iscd=0000&fid_div_cls_code=0&fid_statutory_cls_code=0&fid_trgt_cls_code=111111111&fid_trgt_exls_cls_code=000000&fid_input_price_1=0&fid_input_price_2=0&fid_vol_cnt=0&fid_input_date_1=',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'appkey': process.env.KIS_APP_KEY,
          'appsecret': process.env.KIS_APP_SECRET,
          'tr_id': 'FHPST02210000',
          'Content-Type': 'application/json'
        }
      }
    );
    const frgnData = await frgnRes.json();
    const items = frgnData?.output?.slice(0, 5) || [];

    // 외인 순매수 많은 순으로 이미 정렬되어 나옴
    const stocks = items.map((s, i) => {
      const price = parseInt(s.stck_prpr || 0);
      const frgnNet = parseInt(s.frgn_ntby_qty || 0);
      const frgnAvg = parseInt(s.frgn_avg_pchs_pric || 0);
      const diff = frgnAvg > 0 ? ((price - frgnAvg) / frgnAvg * 100).toFixed(1) : null;
      const signal = diff === null ? 'watch' : parseFloat(diff) < -2 ? 'buy' : parseFloat(diff) > 2 ? 'caution' : 'watch';
      const signalText = signal === 'buy' ? '매수 매력' : signal === 'caution' ? '주의' : '관심 종목';
      const reason = diff === null
        ? `외인 순매수 ${frgnNet.toLocaleString()}주`
        : parseFloat(diff) < 0
          ? `외인 평단가 대비 ${Math.abs(diff)}% 저평가 · 순매수 ${frgnNet.toLocaleString()}주`
          : `외인 순매수 ${frgnNet.toLocaleString()}주 · 평단가 대비 ${diff}% 고평가`;

      return {
        rank: i + 1,
        name: s.hts_kor_isnm,
        price: price > 0 ? price.toLocaleString() + '원' : '-',
        reason,
        signal,
        signalText
      };
    });

    res.status(200).json({ success: true, stocks });

  } catch (error) {
    console.error('추천주 오류:', error.message);
    res.status(200).json({
      success: true,
      isMock: true,
      stocks: [
        { rank:1, name:'삼성전자', reason:'외인 순매수 1위', price:'-', signal:'buy', signalText:'매수 매력' },
        { rank:2, name:'SK하이닉스', reason:'외인 순매수 2위', price:'-', signal:'buy', signalText:'매수 매력' },
        { rank:3, name:'KB금융', reason:'외인 순매수 3위', price:'-', signal:'watch', signalText:'관심 종목' },
        { rank:4, name:'LG에너지솔루션', reason:'외인 순매수 4위', price:'-', signal:'watch', signalText:'관심 종목' },
        { rank:5, name:'POSCO홀딩스', reason:'외인 순매수 5위', price:'-', signal:'caution', signalText:'주의' },
      ]
    });
  }
}
