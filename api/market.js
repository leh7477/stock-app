export default async function handler(req, res) {
  try {
    // 1. 한국은행 기준금리
    const ecosRes = await fetch(`https://ecos.bok.or.kr/api/StatisticSearch/${process.env.ECOS_API_KEY}/json/kr/1/1/722Y001/D/20260510/20260520/0101000`);
    const ecosData = await ecosRes.json();
    const rate = ecosData.StatisticSearch?.row?.[0]?.DATA_VALUE || "3.50";

    // 2. 환율 및 코스피 (Yahoo Finance)
    const [usdRes, kospiRes] = await Promise.all([
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDKRW=X'),
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/^KS11')
    ]);

    const usdData = await usdRes.json();
    const kospiData = await kospiRes.json();

    const usdVal = usdData.chart.result[0].meta.regularMarketPrice;
    const usdPrev = usdData.chart.result[0].meta.previousClose;
    const kospiVal = kospiData.chart.result[0].meta.regularMarketPrice;
    const kospiPrev = kospiData.chart.result[0].meta.previousClose;

    res.status(200).json({
      success: true,
      rate: rate + "%",
      usd: { val: usdVal.toLocaleString(), chg: (usdVal - usdPrev).toFixed(1) },
      kospi: { val: kospiVal.toLocaleString(), chg: (kospiVal - kospiPrev).toFixed(2) }
    });
  } catch (e) {
    res.status(200).json({ success: false, error: e.message });
  }
}
