export default async function handler(req, res) {
  // 1. Vercel 서버에 10분(600초) 동안 이 데이터를 기억하라고 명령 (캐싱)
  // stale-while-revalidate는 백그라운드에서 갱신하는 동안 이전 데이터를 보여줘서 로딩을 없앰
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=30');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const query = encodeURIComponent('주식 증권 코스피 외인 기관');
    
    // 2. 10분 단위의 숫자를 생성 (매 10분마다 url이 미세하게 변해서 최신화를 강제함)
    const timeStep = Math.floor(Date.now() / 600000);
    const url = `https://openapi.naver.com/v1/search/news.json?query=${query}&display=8&sort=date&t=${timeStep}`;

    const response = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID.trim(),
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET.trim(),
      }
    });

    const data = await response.json();

    if (!data.items) {
      throw new Error("네이버 API 응답에 items가 없습니다.");
    }

    const news = data.items.map(item => ({
      title: item.title.replace(/<[^>]*>?/g, '').replace(/&quot;/g, '').replace(/&amp;/g, '&'),
      source: item.originallink?.includes('mk.co.kr') ? '매일경제' :
              item.originallink?.includes('hankyung') ? '한국경제' :
              item.originallink?.includes('chosun') ? '조선비즈' :
              item.originallink?.includes('yna.co.kr') ? '연합뉴스' : '경제뉴스',
      time: item.pubDate,
      url: item.originallink || item.link
    }));

    res.status(200).json({ success: true, news });
  } catch (error) {
    console.error("뉴스 에러:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}
