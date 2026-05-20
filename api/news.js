export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const query = encodeURIComponent('코스피 외인 기관 주식 증권');
    const url = `https://openapi.naver.com/v1/search/news.json?query=${query}&display=8&sort=date`;

    const response = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
      }
    });

    const data = await response.json();

    const news = data.items.map(item => {
      // pubDate 예시: "Wed, 20 May 2026 11:23:00 +0900"
      const pubDate = item.pubDate;
      let timeStr = '방금 전';
      try {
        const d = new Date(pubDate);
        const now = new Date();
        const diff = Math.floor((now - d) / 60000);
        if (diff < 1) timeStr = '방금 전';
        else if (diff < 60) timeStr = `${diff}분 전`;
        else if (diff < 1440) timeStr = `${Math.floor(diff/60)}시간 전`;
        else timeStr = `${Math.floor(diff/1440)}일 전`;
      } catch(e) {}

      return {
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
        time: timeStr,
        url: item.originallink || item.link
      };
    });

    res.status(200).json({ success: true, news });
  } catch (error) {
    console.error('뉴스 오류:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}
