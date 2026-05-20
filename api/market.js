export default async function handler(req, res) {
  // CORS 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // 기본값 (데이터 호출 실패 시 보여줄 값)
  let usd = { val: '1,375', chg: '0.0' };
  let kospi = { val: '2,700.00', chg: '0.00' };

  const today = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 20); // 주말 대비 넉넉하게 20일치

  const fmt = d => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  };

  // 1. 환율 정보 (ECOS)
  if (process.env.ECOS_API_KEY) {
    try {
      const ecosUrl = `https://ecos.bok.or.kr/api/StatisticSearch/${process.env.ECOS_API_KEY}/json/kr/1/10/731Y001/DD/${fmt(from)}/${fmt(today)}/0000001`;
      const ecosRes = await fetch(ecosUrl);
      const ecosData = await ecosRes.json();
      const rows = ecosData?.StatisticSearch?.row;
      
      if (rows && rows.length >= 2) {
        const cur = parseFloat(rows[rows.length - 1].DATA_VALUE);
        const prev = parseFloat(rows[rows.length - 2].DATA_VALUE);
        usd = { 
          val: cur.toLocaleString(undefined, {minimumFractionDigits: 1}), 
          chg: (cur - prev).toFixed(1) 
        };
      }
    } catch (e) {
      console.error('환율 API 호출 실패:', e.message);
    }
  }

  // 2. 코스피 정보 (Yahoo Finance)
  try {
    const kospiRes = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=10d',
      { 
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'application/json'
        } 
      }
    );
    
    if (kospiRes.ok) {
      const kospiData = await kospiRes.json();
      const result = kospiData?.chart?.result?.[0];
      const closes = result?.indicators?.quote?.[0]?.close?.filter(v => v !== null && v !== undefined);
      
      if (closes && closes.length >= 2) {
        const cur = closes[closes.length - 1];
        const prev = closes[closes.length - 2];
        kospi = { 
          val: cur.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}), 
          chg: (cur - prev).toFixed(2) 
        };
      }
    }
  } catch (e) {
    console.error('코스피 API 호출 실패:', e.message);
  }

  // 최종 응답
  res.status(200).json({
    success: true,
    rate: '3.50%', // 현재 한국 기준금리 상향 반영
    usd,
    kospi
  });
}
