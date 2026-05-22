const TIMEOUT_MS = 6000;

function parseNaverDate(pubDate) {
  try {
    const d = new Date(pubDate);
    const diff = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diff < 1)    return '방금 전';
    if (diff < 60)   return `${diff}분 전`;
    if (diff < 1440) return `${Math.floor(diff / 60)}시간 전`;
    return `${Math.floor(diff / 1440)}일 전`;
  } catch {
    return '최근';
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    // _t 캐시버스터 제거 — Vercel Edge Cache가 정상 작동하도록
    const query = encodeURIComponent('코스피 외인 기관 주식 증권');
    const url = `https://openapi.naver.com/v1/search/news.json?query=${query}&display=8&sort=date&start=1`;

    const response = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'X-Naver-Client-Id':     process.env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
      },
    });
    clearTimeout(id);

    const data = await response.json();

    const news = (data.items || []).map(item => ({
      title: item.title
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>'),
      source: item.originallink?.includes('mk.co.kr')    ? '매일경제'  :
              item.originallink?.includes('hankyung')    ? '한국경제'  :
              item.originallink?.includes('chosun')      ? '조선비즈'  :
              item.originallink?.includes('yna.co.kr')   ? '연합뉴스'  :
              item.originallink?.includes('newsis')      ? '뉴시스'    :
              item.originallink?.includes('edaily')      ? '이데일리'  :
              item.originallink?.includes('mt.co.kr')    ? '머니투데이' : '경제뉴스',
      time: parseNaverDate(item.pubDate),
      url: item.originallink || item.link,
    }));

    res.status(200).json({ success: true, news });
  } catch (error) {
    clearTimeout(id);
    console.error('뉴스 오류:', error.message);
    // 500 대신 200 + 빈 배열 반환 → 프론트 loadAll() catch 블록 방지
    res.status(200).json({ success: true, news: [] });
  }
}
