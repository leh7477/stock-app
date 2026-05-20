export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  let usd = null;
  let kospi = null;

  try {
    const today = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 15);
    const fmt = d => {
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      return `${y}${m}${day}`;
    };
    const ecosUrl = `https://ecos.bok.or.kr/api/StatisticSearch/${process.env.ECOS_API_KEY}/json/kr/1/10/731Y001/DD/${fmt(from)}/${fmt(today)}/0000001`;
    const ecosRes = await fetch(ecosUrl);
    const ecosData = await ecosRes.json();
    const rows = ecosData?.StatisticSearch?.row;
    if (rows?.length >= 2) {
      const cur = parseFloat(rows[rows.length-1].DATA_VALUE);
      const prev = parseFloat(rows[rows.length-2].DATA_VALUE);
      usd = { val: Math.round(cur).toLocaleString(), chg: (cur-prev).toFixed(1) };
    }
  } catch(e) {
    console.error('환율 오류:', e.message);
  }

  try {
    const kospiRes = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=5d',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const kospiData = await kospiRes.json();
    const closes = kospiData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null);
    if (closes?.length >= 2) {
      const cur = closes[closes.length-1];
      const prev = closes[closes.length-2];
      kospi = { val: cur.toFixed(2), chg: (cur-prev).toFixed(2) };
    }
  } catch(e) {
    console.error('코스피 오류:', e.message);
  }

  res.status(200).json({ success: true, rate: '2.50%', usd, kospi });
}
