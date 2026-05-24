/**
 * 전종목 MA 분석 업데이트 스크립트
 * GitHub Actions에서 매일 장 마감 후(KST 16:30) 자동 실행
 *
 * 흐름:
 *   1. KRX API → KOSPI + KOSDAQ 전종목 코드 조회
 *   2. KIS API → 각 종목 60일 일봉 종가 조회
 *   3. MA5 / MA20 / MA60 계산, 스코어링
 *   4. Redis에 저장 (TTL 28시간 - 다음 업데이트까지 여유)
 */

'use strict';

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KIS_KEY  = process.env.KIS_APP_KEY;
const KIS_SEC  = process.env.KIS_APP_SECRET;

const BATCH_SIZE = 15;       // KIS API: 초당 20건 제한, 여유있게 15
const BATCH_DELAY = 1100;    // ms - 배치 사이 대기
const FETCH_TIMEOUT = 10000; // 단건 fetch 타임아웃

// ─── 유틸 ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseNum(s) {
  return parseInt(String(s || '0').replace(/,/g, '')) || 0;
}

async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// ─── Redis ─────────────────────────────────────────────────────────────────

async function redisGet(key) {
  const r = await timedFetch(`${KV_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  }).then(r => r.json());
  return r.result;
}

async function redisSet(key, value, ttlSec) {
  await timedFetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', String(ttlSec)]]),
  });
}

// ─── KIS 토큰 ──────────────────────────────────────────────────────────────

async function getKisToken() {
  const cached = await redisGet('kis_token');
  if (cached) {
    console.log('[token] Redis 캐시 사용');
    return cached;
  }

  const data = await timedFetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: KIS_KEY,
      appsecret: KIS_SEC,
    }),
  }).then(r => r.json());

  if (!data.access_token) throw new Error('KIS 토큰 발급 실패: ' + JSON.stringify(data));

  await redisSet('kis_token', data.access_token, 82800);
  console.log('[token] 신규 발급 완료');
  return data.access_token;
}

// ─── KRX 전종목 목록 ───────────────────────────────────────────────────────

async function fetchKrxList(mktId) {
  // mktId: STK = KOSPI, KSQ = KOSDAQ
  const body = new URLSearchParams({
    bld:         'dbms/MDC/STAT/standard/MDCSTAT01901',
    locale:      'ko_KR',
    mktId,
    share:       '1',
    money:       '1',
    csvxls_isNo: 'false',
  }).toString();

  const res = await timedFetch(
    'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Referer':  'https://data.krx.co.kr/contents/MDC/STAT/standard/MDCSTAT01901.cmd',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body,
    }
  );

  const data = await res.json();
  const items = data.OutBlock_1 || [];

  return items.map(item => ({
    code:   item.ISU_SRT_CD,       // 6자리 단축코드
    name:   item.ISU_ABBRV,        // 종목명
    market: mktId === 'STK' ? 'KOSPI' : 'KOSDAQ',
    sector: item.SECT_TP_NM || '',
  })).filter(s => s.code && s.name);
}

// ─── KIS 일봉 조회 ─────────────────────────────────────────────────────────

async function fetchDailyCandles(token, code, market) {
  const now    = new Date();
  const endDt  = now.toISOString().slice(0, 10).replace(/-/g, '');
  const start  = new Date(now - 100 * 86400000); // 100일 전 (영업일 기준 ~72일)
  const startDt = start.toISOString().slice(0, 10).replace(/-/g, '');

  const mkCode = market === 'KOSPI' ? 'J' : 'Q';

  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: mkCode,
    fid_input_iscd:         code,
    fid_input_date_1:       startDt,
    fid_input_date_2:       endDt,
    fid_period_div_code:    'D',
    fid_org_adj_prc:        '0',
  });

  const res = await timedFetch(
    `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-price?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        appkey:    KIS_KEY,
        appsecret: KIS_SEC,
        'tr_id':   'FHKST01010100',
        custtype:  'P',
        'Content-Type': 'application/json',
      },
    }
  ).then(r => r.json());

  return res;
}

// ─── MA 계산 & 스코어 ──────────────────────────────────────────────────────

function calcMA(closes, n) {
  const i = closes.length - 1;
  if (i < n - 1) return null;
  return Math.round(closes.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
}

function calcMAArr(closes, n) {
  return closes.map((_, i) => {
    if (i < n - 1) return null;
    return Math.round(closes.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
  });
}

function maSignal(price, ma) {
  if (!ma || !price) return 'neutral';
  const ratio = (price - ma) / ma * 100;
  if (ratio > 1)  return 'up';
  if (ratio < -1) return 'down';
  return 'neutral';
}

function analyze(stock, closes) {
  if (closes.length < 22) return null;

  const n   = closes.length - 1;
  const cur = closes[n];
  const ma5  = calcMA(closes, 5);
  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, Math.min(60, closes.length));

  const ma5prev  = closes.length > 6  ? calcMA(closes.slice(0, -3), 5)  : null;
  const ma20prev = closes.length > 30 ? calcMA(closes.slice(0, -7), 20) : null;

  let score = 40;
  const signals = [];

  // ① 정배열 / 역배열
  if (ma5 && ma20 && ma60) {
    if (ma5 > ma20 && ma20 > ma60) {
      score += 30; signals.push('정배열 — 단기·중기·장기 모두 우상향');
    } else if (ma5 < ma20 && ma20 < ma60) {
      score -= 25; signals.push('역배열 — 하락 추세 지속 주의');
    } else if (ma5 > ma20) {
      score += 10; signals.push('단기 이평선 상향 — 중기 회복 진행 중');
    } else if (ma20 > ma60) {
      score += 5;  signals.push('중기 이평선 상향 — 장기 추세 전환 시도');
    }
  }

  // ② 현재가 vs 각 이평선
  if (ma5  && cur > ma5)  score += 8;
  if (ma20 && cur > ma20) score += 10;
  if (ma60 && cur > ma60) score += 5;

  // ③ 이평선 자체 추세
  if (ma5  && ma5prev  && ma5  > ma5prev)  score += 5;
  if (ma20 && ma20prev && ma20 > ma20prev) { score += 5; signals.push('20일선 상승 중'); }

  // ④ 골든크로스 / 데드크로스 (최근 5거래일)
  const ma5arr  = calcMAArr(closes, 5);
  const ma20arr = calcMAArr(closes, 20);
  let crossFound = false;
  for (let i = Math.max(1, n - 4); i <= n && !crossFound; i++) {
    if (ma5arr[i] && ma20arr[i] && ma5arr[i-1] && ma20arr[i-1]) {
      if (ma5arr[i] > ma20arr[i] && ma5arr[i-1] <= ma20arr[i-1]) {
        score += 15; signals.unshift('골든크로스 발생 — 단기 강세 신호 ✓'); crossFound = true;
      } else if (ma5arr[i] < ma20arr[i] && ma5arr[i-1] >= ma20arr[i-1]) {
        score -= 12; signals.unshift('데드크로스 발생 — 단기 주의 신호'); crossFound = true;
      }
    }
  }

  // ⑤ 5일 수익률
  const chg5d = closes.length >= 6
    ? (cur - closes[n - 5]) / closes[n - 5] * 100 : 0;
  score += Math.max(-10, Math.min(10, Math.round(chg5d)));

  score = Math.max(10, Math.min(95, Math.round(score)));

  const chgRate = closes.length >= 2
    ? ((cur - closes[n - 1]) / closes[n - 1] * 100).toFixed(2) : '0.00';

  return {
    ...stock,
    price:      cur,
    chgRate:    parseFloat(chgRate),
    ma5, ma20, ma60,
    ma5Signal:  maSignal(cur, ma5),
    ma20Signal: maSignal(cur, ma20),
    ma60Signal: maSignal(cur, ma60),
    score,
    signals: signals.slice(0, 2),
  };
}

// ─── 단일 종목 처리 ────────────────────────────────────────────────────────

async function processStock(token, stock) {
  try {
    const raw = await fetchDailyCandles(token, stock.code, stock.market);
    if (!raw?.output2?.length) return null;

    // KIS는 최신 → 과거 순서로 반환하므로 역정렬
    const closes = raw.output2.slice().reverse().map(d => parseNum(d.stck_clpr));
    if (closes.length < 22) return null;

    return analyze(stock, closes);
  } catch {
    return null;
  }
}

// ─── 메인 ──────────────────────────────────────────────────────────────────

async function main() {
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  console.log(`\n=== 전종목 MA 분석 시작: ${kstNow.toISOString().replace('T', ' ').slice(0, 19)} KST ===\n`);

  // 1. KRX 전종목 목록 조회
  console.log('[1/4] KRX 전종목 목록 조회...');
  let allStocks = [];
  try {
    const [kospi, kosdaq] = await Promise.all([
      fetchKrxList('STK'),
      fetchKrxList('KSQ'),
    ]);
    allStocks = [...kospi, ...kosdaq];
    console.log(`      KOSPI ${kospi.length}개 + KOSDAQ ${kosdaq.length}개 = 합계 ${allStocks.length}개`);
  } catch (e) {
    console.error('[1/4] KRX 목록 조회 실패:', e.message);
    process.exit(1);
  }

  // 2. KIS 토큰
  console.log('[2/4] KIS 토큰 확인...');
  let token;
  try {
    token = await getKisToken();
    console.log('      완료');
  } catch (e) {
    console.error('[2/4] KIS 토큰 실패:', e.message);
    process.exit(1);
  }

  // 3. 배치 처리 (KIS API 속도 제한 준수)
  console.log(`[3/4] 일봉 데이터 조회 및 MA 분석... (배치 ${BATCH_SIZE}개, ${BATCH_DELAY}ms 간격)`);
  const results = [];
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < allStocks.length; i += BATCH_SIZE) {
    const batch = allStocks.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(s => processStock(token, s)));

    batchResults.forEach(r => {
      if (r) results.push(r);
      else   failed++;
    });
    processed += batch.length;

    // 100종목마다 진행상황 로그
    if (processed % 100 === 0 || i + BATCH_SIZE >= allStocks.length) {
      const pct = ((processed / allStocks.length) * 100).toFixed(1);
      console.log(`      진행: ${processed}/${allStocks.length} (${pct}%) | 성공 ${results.length} / 실패 ${failed}`);
    }

    await sleep(BATCH_DELAY);
  }

  console.log(`      완료: ${results.length}개 분석 성공, ${failed}개 실패`);

  // 4. 스코어 정렬 후 Redis 저장
  console.log('[4/4] Redis 저장...');
  results.sort((a, b) => b.score - a.score);

  const baseDate = kstNow.toISOString().slice(0, 10);
  const payload = {
    stocks:   results,
    baseDate,
    total:    results.length,
    updatedAt: kstNow.toISOString(),
  };

  await redisSet('recommend_v2', payload, 28 * 3600); // 28시간 TTL
  console.log(`      완료: ${results.length}개 종목, 기준일 ${baseDate}, TTL 28시간`);

  console.log(`\n=== 전종목 MA 분석 완료 ===\n`);
}

main().catch(e => {
  console.error('치명적 오류:', e);
  process.exit(1);
});
