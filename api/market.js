export default async function handler(req, res) {
  // 캐시 방지 (매번 새로 호출)
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  try {
    // 1. 한국은행 API 호출
    const ecosRes = await fetch(`https://ecos.bok.or.kr/api/StatisticSearch/${process.env.ECOS_API_KEY}/json/kr/1/1/722Y001/D/20260510/20260520/0101000`);
    const ecosData = await ecosRes.json();
    
    // 2. 야후 파이낸스 호출 (환율, 코스피)
    const [usdRes, kospiRes] = await Promise.all([
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDKRW=X', { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/^KS11', { headers: { 'User-Agent': 'Mozilla/5.0' } })
    ]);

    const usdData = await usdRes.json();
    const kospiData = await kospiRes.json();

    // 데이터 추출 (실패 시 여기서 바로 에러 발생 -> catch로 이동)
    const rate = ecosData.StatisticSearch.row[0].DATA_VALUE;
    const usdVal = usdData.chart.result[0].meta.regularMarketPrice;
    const usdPrev = usdData.chart.result[0].meta.previousClose;
    const kospiVal = kospiData.chart.result[0].meta.regularMarketPrice;
    const kospiPrev = kospiData.chart.result[0].meta.previousClose;

    // 성공 시에만 JSON 반환
    res.status(200).json({
      success: true,
      rate: rate + "%",
      usd: { 
        val: usdVal.toLocaleString(), 
        chg: (usdVal - usdPrev).toFixed(1) 
      },
      kospi: { 
        val: kospiVal.toLocaleString(), 
        chg: (kospiVal - kospiPrev).toFixed(2) 
      }
    });

  } catch (error) {
    // 실패하면 가짜 데이터 주지 말고, 에러 원인을 보냄
    res.status(500).json({ 
      success: false, 
      error: "API 호출 실패", 
      detail: error.message 
    });
  }
}
