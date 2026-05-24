/**
 * 전종목 MA 분석 결과 API
 * - GitHub Actions (scripts/update-recommend.js) 가 매일 장 마감 후 Redis에 저장
 * - 여기서는 Redis 읽기만 함 → 항상 빠름 (외부 API 호출 없음)
 *
 * Query params:
 *   ?market=KOSPI|KOSDAQ   시장 필터
 *   ?filter=golden|ma5|ma20|ma60   신호 필터
 *   ?limit=N               반환 개수 (기본 100)
 *   ?offset=N              페이지네이션 시작 위치 (기본 0)
 */

const TIMEOUT_MS = 5000;

async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=900');

  const redisUrl   = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  const market = req.query?.market || '';            // KOSPI | KOSDAQ | '' = 전체
  const filter = req.query?.filter || '';            // golden | ma5 | ma20 | ma60 | ''
  const limit  = Math.min(parseInt(req.query?.limit  || '100'), 500);
  const offset = Math.max(parseInt(req.query?.offset || '0'),   0);

  try {
    const raw = await timedFetch(`${redisUrl}/get/recommend_v2`, {
      headers: { Authorization: `Bearer ${redisToken}` },
    }).then(r => r.json());

    if (!raw.result) {
      return res.status(200).json({
        success: false,
        error:   '분석 데이터가 아직 없습니다.',
        hint:    'GitHub Actions → update-stocks 워크플로우를 수동으로 한 번 실행해주세요.',
      });
    }

    const payload = JSON.parse(raw.result);
    let stocks = payload.stocks || [];
    const totalAll = stocks.length;

    // 필터 적용
    if (market) {
      stocks = stocks.filter(s => s.market === market);
    }
    if (filter === 'golden') {
      stocks = stocks.filter(s => s.signals?.some(t => t.includes('골든크로스')));
    } else if (filter === 'ma5') {
      stocks = stocks.filter(s => s.ma5Signal  === 'up');
    } else if (filter === 'ma20') {
      stocks = stocks.filter(s => s.ma20Signal === 'up');
    } else if (filter === 'ma60') {
      stocks = stocks.filter(s => s.ma60Signal === 'up');
    }

    const totalFiltered = stocks.length;

    // 페이지네이션
    stocks = stocks.slice(offset, offset + limit);

    return res.status(200).json({
      success:       true,
      stocks,
      baseDate:      payload.baseDate,
      updatedAt:     payload.updatedAt,
      total:         totalFiltered,   // 필터 후 전체 수
      totalAll,                       // 분석된 전체 종목 수
      offset,
      limit,
      source:        'cache',
    });
  } catch (e) {
    return res.status(200).json({ success: false, error: e.message });
  }
}
