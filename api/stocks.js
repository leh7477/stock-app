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

    // 종목 리스트 (시총 상위)
    const symbols = [
      { code: '005930', name: '삼성전자' },
      { code: '000660', name: 'SK하이닉스' },
      { code: '105560', name: 'KB금융' },
      { code: '373220', name: 'LG에너지솔루션' },
      { code: '005490', name: 'POSCO홀딩스' },
    ];

    const stocks = await Promise.all(symbols.map(async (s, i) => {
      try {
        const r = await fetch(
          `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=${s.code}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'appkey': process.env.KIS_APP_KEY,
              'appsecret': process.env.KIS_APP_SECRET,
              'tr_id': 'FHKST01010900',
              'Content-Type': 'application/json'
            }
          }
        );
        const d = await r.json();
        const output = d?.output;
        const foreignNet = parseInt(output?.frgn_ntby_qty || 0);
        const price = parseInt(output?.stck_prpr || 0);
        const avgPrice = parseInt(output?.frgn_avg_pchs_pric || 0);
        const diff = avgPrice > 0 ? ((price - avgPrice) / avgPrice * 100).toFixed(1) : 0;
        const signal = diff < -2 ? 'buy' : diff < 2 ? 'watch' : 'caution';
        const signalText = signal === 'buy' ? '매수 매력' : signal === 'watch' ? '관심 종목' : '주의';
        const reason = avgPrice > 0
          ? (diff < 0 ? `외인 평단가 대비 ${Math.abs(diff)}% 저평가` : `외인 평단가 대비 ${diff}% 고평가`)
          : '수급 데이터 분석 중';

        return {
          rank: i + 1,
          name: s.name,
          price: price > 0 ? price.toLocaleString() + '원' : '-',
          reason,
          signal,
          signalText,
          foreignNet
        };
      } catch {
        return {
          rank: i + 1,
          name: s.name,
          price: '-',
          reason: '데이터 불러오는 중',
          signal: 'watch',
          signalText: '관심 종목',
          foreignNet: 0
        };
      }
    }));

    // 외인 순매수 기준 정렬
    stocks.sort((a, b) => b.foreignNet - a.foreignNet);
    stocks.forEach((s, i) => s.rank = i + 1);

    res.status(200).json({ success: true, stocks });
  } catch (error) {
    // fallback
    res.status(200).json({
      success: true,
      isMock: true,
      stocks: [
        { rank:1, name:'삼성전자', reason:'외인 평단가 대비 저평가 구간', price:'74,200원', signal:'buy', signalText:'매수 매력' },
        { rank:2, name:'SK하이닉스', reason:'수급 골든크로스 감지', price:'188,500원', signal:'buy', signalText:'매수 매력' },
        { rank:3, name:'KB금융', reason:'금리 동결 수혜 + 기관 순매수', price:'92,100원', signal:'watch', signalText:'관심 종목' },
        { rank:4, name:'LG에너지솔루션', reason:'공매도 잔고 감소 중', price:'312,000원', signal:'watch', signalText:'관심 종목' },
        { rank:5, name:'POSCO홀딩스', reason:'외인 매도 → 반등 구간 주의', price:'421,500원', signal:'caution', signalText:'주의' },
      ]
    });
  }
}
