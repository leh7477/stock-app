export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    // 환율 (ECOS)
    const today = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 15);
    const fmt = d => d.toISOString().slice(0,10).replace(/-/g,'');
    
    const ecosUrl = `https://ecos.bok.or.kr/api/StatisticSearch/${process.env.ECOS_API_KEY}/json/kr/1/10/731Y001/DD/${fmt(from)}/${fmt(today)}/0000001`;
    const ecosRes = await fetch(ecosUrl);
    const ecosData = await ecosRes.json();
    const rows = ecosData?.StatisticSearch?.row;
    let usd = { val: '1,375', chg: '0' };
    if (rows?.length) {
      const cur = parseFloat(rows[rows.length-1].DATA_VALUE);
      const prev = parseFloat(rows[rows.length-2]?.DATA_VALUE || cur);
      usd = { val: Math.round(cur).toLocaleString(), chg: (cur-prev).toFixed(1) };
    }

    // 코스피 (Yahoo Finance)
    const kospiRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=5d');
    const kospiData = await kospiRes.json();
    const closes = kospiData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v);
    let kospi = { val: '2,687.45', chg: '0' };
    if (closes?.length >= 2) {
      const cur = closes[closes.length-1];
      const prev = closes[closes.length-2];
      kospi = { val: cur.toFixed(2), chg: (cur-prev).toFixed(2) };
    }

    res.status(200).json({
      success: true,
      rate: '2.50%',
      usd,
      kospi
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
