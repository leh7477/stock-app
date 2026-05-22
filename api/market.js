export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  let usd = null;
  let kospi = null;

  // 원/달러 환율 (ECOS 한국은행)
  try {
    const today = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const fmt = d => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}${m}${day}`;
    };
    const ecosUrl = `https://ecos.bok.or.kr/api/StatisticSearch/${process.env.ECOS_API_KEY}/json/kr/1/10/731Y001/DD/${fmt(from)}/${fmt(today)}/0000001`;
    const ecosRes = await fetch(ecosUrl);
    const ecosData = await ecosRes.json();
    const rows = ecosData?.StatisticSearch?.row;
    if (rows?.length >= 2) {
      const cur = parseFloat(rows[rows.length - 1].DATA_VALUE);
      const prev = parseFloat(rows[rows.length - 2].DATA_VALUE);
      usd = { val: Math.round(cur).toLocaleString(), chg: (cur - prev).toFixed(1) };
    }
  } catch (e) {
    console.error('환율 오류:', e.message);
  }

  // 코스피 (네이버 금융) ← Yahoo Finance 대신
  try {
    const kospiRes = await fetch(
      'https://m.stock.naver.com/api/index/KOSPI/basic',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
          'Referer': 'https://m.stock.naver.com/',
        }
      }
    );
    const kospiData = await kospiRes.json();
    console.log('네이버 코스피:', JSON.stringify(kospiData).slice(0, 200));

    if (kospiData?.closePrice && kospiData?.compareToPreviousClosePrice) {
      const val = parseFloat(kospiData.closePrice.replace(/,/g, ''));
      const chg = parseFloat(kospiData.compareToPreviousClosePrice.replace(/,/g, ''));
      kospi = {
        val: val.toFixed(2),
        chg: chg.toFixed(2)
      };
    }
  } catch (e) {
    console.error('코스피 오류:', e.message);
  }

  res.status(200).json({ success: true, rate: '2.50%', usd, kospi });
}
