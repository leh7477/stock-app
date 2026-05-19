export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    // 환율 (ECOS)
    const today = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 15);
    const fmt = d => {
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      return `${y}${m}${day}`;
    };

    let usd = { val: '1,375', chg: '0' };
    try {
      const ecosUrl = `https://ecos.bok.or.kr/api/StatisticSearch/${process.env.ECOS_API_KEY}/json/kr/1/10/731Y001/DD/${fmt(from)}/${fmt(today)}/0000001`;
      const ecosRes = await fetch(ecosUrl);
      const ecosData = await ecosRes.json();
      const rows = ecosData?.StatisticSearch?.row;
      if (rows?.length >= 2) {
        const cur = parseFloat(rows[rows.length-1].DATA_VALUE);
        const prev = parseFloat(rows[rows.length-2].DATA_VALUE);
        usd = { val: Math.round(cur).toLocaleString(), chg: (cur-prev).toFixed(1) };
      }
    } catch(e) { console.error('환율 오류:', e); }

    // 코스피 (Yahoo Finance - 원화 기준)
    let kospi = { val: '2,600.00', chg: '0' };
    try {
      const kospiRes = await fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=5d',
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const kospiData = await kospiRes.json();
      const result = kospiData?.chart?.result?.[0];
      const closes = result?.indicators?.quote?.[0]?.close?.filter(v => v != null);
      if (closes?.length >= 2) {
        const cur = closes[closes.length-1];
        const prev = closes[closes.length-2];
        // 코스피 포인트 단위
      if (cur > 500 && cur < 15000) {
          kospi = { val: cur.toFixed(2), chg: (cur-prev).toFixed(2) };
        }
      }
    } catch(e) { console.error('코스피 오류:', e); }

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
