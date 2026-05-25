/**
 * 전종목 이름·코드 목록 (클라이언트 검색용 경량 API)
 * recommend_v2 에서 code, name, market 만 추출해서 반환
 * 초성 검색 등 클라이언트 사이드 검색에 사용
 */

const TIMEOUT_MS = 5000;

async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) { clearTimeout(id); throw e; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 5분 캐시 (CDN 오래된 실패 응답 방지)
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const redisUrl   = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  try {
    const raw = await timedFetch(`${redisUrl}/get/recommend_v2`, {
      headers: { Authorization: `Bearer ${redisToken}` },
    }).then(r => r.json());

    if (!raw.result) {
      return res.status(200).json({ success: false, error: '데이터 없음' });
    }

    const payload = JSON.parse(raw.result);
    const stocks = (payload.stocks || []).map(s => ({
      code:   s.code,
      name:   s.name,
      market: s.market,
    }));

    return res.status(200).json({ success: true, stocks, total: stocks.length });
  } catch (e) {
    return res.status(200).json({ success: false, error: e.message });
  }
}
