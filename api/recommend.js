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

    // ── 5종류 Top (필터 무관, 전체 기준 / ETF·레버리지 제외) ──────────────
    const pureStocks = all.filter(s => !isETF(s));

    // KOSPI/KOSDAQ 각각 N개씩 뽑아 합치는 헬퍼
    const mergeByMarket = (sorted, n = 20) => {
      const kospi  = sorted.filter(s => (s.market || '').includes('KOSPI')).slice(0, n);
      const kosdaq = sorted.filter(s => (s.market || '').includes('KOSDAQ')).slice(0, n);
      const seen   = new Set();
      const merged = [...kospi, ...kosdaq].filter(s => seen.has(s.code) ? false : seen.add(s.code));
      return merged.sort((a, b) => sorted.indexOf(a) - sorted.indexOf(b));
    };

    const d5NetBuy = s => {
      const d5 = s.investorSupply?.d5;
      if (d5 != null) return (d5.foreign || 0) + (d5.inst || 0);
      return s.frgnBuyQty || 0;
    };
    const d5Foreign = s => s.investorSupply?.d5?.foreign || 0;

    // ── 1. AI추천: 퀀트점수(50%) + 수급(30%) + 모멘텀(20%) 복합 ──────────────
    const aiScore = s => {
      const supply  = d5NetBuy(s) > 0 ? 15 : d5NetBuy(s) < 0 ? -10 : 0;
      const momentum = s.ma5Signal === 'up' ? 10 : s.ma5Signal === 'down' ? -5 : 0;
      return (s.score || 0) * 0.5 + supply + momentum;
    };
    const top20AiPick = mergeByMarket(
      [...pureStocks].sort((a, b) => aiScore(b) - aiScore(a))
    );

    // ── 2. 매수신호: 퀀트 55점+ + MA5 매수권 ────────────────────────────────
    const top20Buy = mergeByMarket(
      pureStocks.filter(s => s.ma5 && s.price && s.score >= 55
                          && Math.abs(s.price - s.ma5) / s.ma5 <= 0.04)
    );

    // ── 3. 퀀트랭킹: 점수 순 ──────────────────────────────────────────────
    const top20Score = mergeByMarket(pureStocks);

    // ── 4. 모멘텀: MA5 상승 + 양봉 + 점수 40점+ ────────────────────────────
    const top20Momentum = mergeByMarket(
      pureStocks
        .filter(s => s.ma5Signal === 'up' && (s.chgRate || 0) > 0 && (s.score || 0) >= 40)
        .sort((a, b) => (b.chgRate || 0) - (a.chgRate || 0))
    );

    // ── 5. 가치주: PBR ≤ 1.0 + 점수 기준 ──────────────────────────────────
    const top20Value = mergeByMarket(
      pureStocks
        .filter(s => (s.pbr || 0) > 0 && (s.pbr || 0) <= 1.0 && (s.score || 0) >= 30)
        .sort((a, b) => (a.pbr || 99) - (b.pbr || 99))
    );

    // ── 6. 급등예비: 거래량 감소(조용한 수렴) + MA20 상승 ──────────────────
    const top20Surge = mergeByMarket(
      pureStocks
        .filter(s => (s.avgVol5 || 0) > 0 && (s.volume || 0) < (s.avgVol5 || 0) * 0.8
                  && s.ma20Signal === 'up' && (s.score || 0) >= 45)
        .sort((a, b) => {
          const ra = (a.volume || 0) / ((a.avgVol5 || 1));
          const rb = (b.volume || 0) / ((b.avgVol5 || 1));
          return ra - rb; // 거래량 감소폭 클수록 상위
        })
    );

    // ── 7. 외인집중: 외인 순매수 상위 ──────────────────────────────────────
    const top20Foreign = mergeByMarket(
      pureStocks
        .filter(s => d5Foreign(s) > 0)
        .sort((a, b) => (d5Foreign(b) * (b.price || 0)) - (d5Foreign(a) * (a.price || 0)))
    );

    // ── 8. 거래대금 상위 ─────────────────────────────────────────────────
    const top20Volume = mergeByMarket(
      pureStocks
        .filter(s => (s.avgVol5 || s.volume || 0) > 0)
        .sort((a, b) => ((b.avgVol5 || b.volume || 0) * (b.price || 0)) - ((a.avgVol5 || a.volume || 0) * (a.price || 0)))
    );

    // 하위 호환 유지
    const top10Score    = top20Score;
    const top10Buy      = top20Buy;
    const top10FrgnBuy  = top20Foreign;
    const top10FrgnSell = mergeByMarket(
      pureStocks.filter(s => d5NetBuy(s) < 0)
        .sort((a, b) => (d5NetBuy(a) * (a.price||0)) - (d5NetBuy(b) * (b.price||0)))
    );
    const top10Volume = top20Volume;

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
      // TOP20 신규
      top20AiPick, top20Buy, top20Score,
      top20Momentum, top20Value, top20Surge,
      top20Foreign, top20Volume,
      // 하위 호환
      top10: top10Score, top10Score, top10Buy,
      top10FrgnBuy, top10FrgnSell, top10Volume,
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
