function parseNaverDate(pubDate) {
  try {
    // "Wed, 20 May 2026 10:07:00 +0900" 형식
    // new Date()는 +0900 오프셋 자동 처리하므로 UTC로 변환됨
    const d = new Date(pubDate);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diff = Math.floor(diffMs / 60000);
    if (diff < 0) return '방금 전';
    if (diff < 1) return '방금 전';
    if (diff < 60) return `${diff}분 전`;
    if (diff < 1440) return `${Math.floor(diff/60)}시간 전`;
    return `${Math.floor(diff/1440)}일 전`;
  } catch(e) {
    return '최근';
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const query = encodeURIComponent('코스피 외인 기관 주식 증권');
    const timestamp = Date.now();
    const url = `https://openapi.naver.com/v1/search/news.json?query=${query}&display=8&sort=date&start=1&_t=${timestamp}`;

    const response = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
      }
    });

    const data = await response.json();

    // 서버 현재 시간 로깅 (디버깅용)
    console.log('서버 현재시각(UTC):', new Date().toISOString());
    console.log('뉴스 pubDate 샘플:', data.items?.[0]?.pubDate);
    console.log('파싱 결과:', parseNaverDate(data.items?.[0]?.pubDate));

    const news = data.items.map(item => ({
      title: item.title
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>'),
      source: item.originallink?.includes('mk.co.kr') ? '매일경제' :
              item.originallink?.includes('hankyung') ? '한국경제' :
              item.originallink?.includes('chosun') ? '조선비즈' :
              item.originallink?.includes('yna.co.kr') ? '연합뉴스' :
              item.originallink?.includes('newsis') ? '뉴시스' :
              item.originallink?.includes('edaily') ? '이데일리' :
              item.originallink?.includes('mt.co.kr') ? '머니투데이' : '경제뉴스',
      time: parseNaverDate(item.pubDate),
      url: item.originallink || item.link
    }));

    res.status(200).json({ success: true, news });
  } catch (error) {
    console.error('뉴스 오류:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}
