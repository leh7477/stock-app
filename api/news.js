export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  try {
    const query = encodeURIComponent('주식 증권 코스피 외인 기관');
    const url = `https://openapi.naver.com/v1/search/news.json?query=${query}&display=8&sort=date`;
    
    const response = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
      }
    });
    
    const data = await response.json();
    
    const news = data.items.map(item => ({
      title: item.title.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
      source: item.originallink?.includes('mk.co.kr') ? '매일경제' :
              item.originallink?.includes('hankyung') ? '한국경제' :
              item.originallink?.includes('chosun') ? '조선비즈' :
              item.originallink?.includes('yna.co.kr') ? '연합뉴스' : '경제뉴스',
      time: item.pubDate,
      url: item.originallink || item.link
    }));
    
    res.status(200).json({ success: true, news });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
