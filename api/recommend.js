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
  res.setHeader('Cache-Control', 'no-store');  // CDN 캐시 비활성화 — 클라이언트 localStorage로만 캐시

  const redisUrl   = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  const market   = req.query?.market   || '';        // KOSPI | KOSDAQ | '' = 전체
  const filter   = req.query?.filter   || '';        // golden | ma5 | ma20 | ma60 | ''
  const frgnbuy  = req.query?.frgnbuy  === '1';     // 외인 순매수 > 0 필터
  const limit    = Math.min(parseInt(req.query?.limit  || '100'), 500);
  const offset   = Math.max(parseInt(req.query?.offset || '0'),   0);

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

    // ETF·레버리지·인버스 판별 (TOP10 및 종목 리스트에서 제외)
    const ETF_PREFIX = /^(KODEX|TIGER|ARIRANG|KINDEX|KOSEF|KBSTAR|HANARO|TIMEFOLIO|TREX|FOCUS|PLUS|SOL |ACE )/i;
    const ETF_WORD   = /레버리지|인버스|선물|스팩|ETF|리츠|인프라|부동산/;
    const isETF = s => ETF_PREFIX.test(s.name || '') || ETF_WORD.test(s.name || '');

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

    // 외인 순매수 필터 (다른 필터와 AND 조건)
    if (frgnbuy) {
      stocks = stocks.filter(s => (s.frgnBuyQty ?? 0) > 0);
    }

    const totalFiltered = stocks.length;

    const all = payload.stocks || [];

    // ── 5종류 Top10 (필터 무관, 전체 기준 / ETF·레버리지 제외) ──────────────
    const pureStocks = all.filter(s => !isETF(s));

    // 분석 상위
    const top10Score = pureStocks.slice(0, 10);

    // 추천 매수: 점수 ≥ 55 + 현재가가 MA5 ±4% 이내 (매수 구간) → MA5 이격도 오름차순 (가장 근접한 순)
    const top10Buy = pureStocks
      .filter(s => s.ma5 && s.price && s.score >= 55
                && Math.abs(s.price - s.ma5) / s.ma5 <= 0.04)
      .sort((a, b) => Math.abs(a.price - a.ma5) / a.ma5 - Math.abs(b.price - b.ma5) / b.ma5)
      .slice(0, 10);

    // 외인+기관 합산 순매수 상위 (5일 누적, 금액 기준)
    const d5NetBuy = s => ((s.investorSupply?.d5?.foreign || 0) + (s.investorSupply?.d5?.inst || 0)) || (s.frgnBuyQty || 0);
    const top10FrgnBuy = pureStocks
      .filter(s => d5NetBuy(s) > 0)
      .sort((a, b) => (d5NetBuy(b) * (b.price || 0)) - (d5NetBuy(a) * (a.price || 0)))
      .slice(0, 10);

    // 외인+기관 합산 순매도 상위 (5일 누적, 금액 기준, 절댓값 큰 순)
    const top10FrgnSell = pureStocks
      .filter(s => d5NetBuy(s) < 0)
      .sort((a, b) => (d5NetBuy(a) * (a.price || 0)) - (d5NetBuy(b) * (b.price || 0)))
      .slice(0, 10);

    // 거래량 상위 (5일 평균 거래대금 기준)
    const top10Volume = pureStocks
      .filter(s => (s.avgVol5 || s.volume || 0) > 0)
      .sort((a, b) => ((b.avgVol5 || b.volume || 0) * (b.price || 0)) - ((a.avgVol5 || a.volume || 0) * (a.price || 0)))
      .slice(0, 10);

    // 인기 섹터 집계 (전체 종목 기준)
    const sectorMap = {};
    all.forEach(s => {
      if (!s.sector) return;
      if (!sectorMap[s.sector]) sectorMap[s.sector] = { name: s.sector, count: 0, scoreSum: 0 };
      sectorMap[s.sector].count++;
      sectorMap[s.sector].scoreSum += s.score;
    });
    const sectors = Object.values(sectorMap)
      .map(s => ({ name: s.name, count: s.count, avgScore: Math.round(s.scoreSum / s.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);  // 테마 매핑용으로 더 많이 전달

    // 페이지네이션
    stocks = stocks.slice(offset, offset + limit);

    return res.status(200).json({
      success:       true,
      stocks,
      top10:         top10Score,   // 하위 호환성 유지
      top10Score,
      top10Buy,
      top10FrgnBuy,
      top10FrgnSell,
      top10Volume,
      sectors,
      baseDate:      payload.baseDate,
      updatedAt:     payload.updatedAt,
      total:         totalFiltered,
      totalAll,
      offset,
      limit,
      source:        'cache',
    });
  } catch (e) {
    return res.status(200).json({ success: false, error: e.message });
  }
}
