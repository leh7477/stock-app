/**
 * 전종목 MA + 기본 정보 분석 업데이트 스크립트
 * - KRX → KOSPI·KOSDAQ 상장종목 목록 (비상장·코넥스 완전 제외)
 * - KIS (FHKST03010100) → 일봉 (거래량, 외인보유율, 외인순매수 포함)
 * - KIS (FHKST01010100) → 시가총액, PER, PBR, EPS, 업종명
 * - MA5/MA20/MA60 계산, 스코어링 → Redis 저장
 */

'use strict';

const KV_URL    = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;
const KIS_KEY   = process.env.KIS_APP_KEY;
const KIS_SEC   = process.env.KIS_APP_SECRET;

const BATCH_SIZE  = 6;     // 종목당 API 3회 → 6개 병렬 = 약 18 calls/sec (KIS 한도 20/sec)
const BATCH_DELAY = 1200;
const TIMEOUT_MS  = 10000;

// 분석 제외 키워드 (스팩, ETF, 레버리지, 특수 목적 법인)
const SKIP_KEYWORDS = [
  '기업인수목적', '스팩', 'SPAC', '선박투자회사',
  '부동산투자회사', '인프라투자회사', '위탁관리부동산',
];
// ETF·레버리지·인버스 제외 (이름 기준)
const ETF_PREFIX = /^(KODEX|TIGER|ARIRANG|KINDEX|KOSEF|KBSTAR|HANARO|TIMEFOLIO|TREX|FOCUS|PLUS|SOL |ACE )/i;
const ETF_WORD   = /레버리지|인버스|선물|스팩|ETF|리츠|인프라|부동산/;
const isETF = name => ETF_PREFIX.test(name || '') || ETF_WORD.test(name || '');

// ─── 유틸 ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseNum(s) { return parseInt(String(s || '0').replace(/,/g, '')) || 0; }
function parseF(s)   { return parseFloat(String(s || '0').replace(/,/g, '')) || 0; }

async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) { clearTimeout(id); throw e; }
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
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', String(ttlSec)]]),
  });
}

// ─── KIS 토큰 ──────────────────────────────────────────────────────────────

async function getKisToken() {
  const cached = await redisGet('kis_token');
  if (cached) { console.log('[token] Redis 캐시 사용'); return cached; }

  const data = await timedFetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_KEY, appsecret: KIS_SEC }),
  }).then(r => r.json());

  if (!data.access_token) throw new Error('KIS 토큰 실패: ' + JSON.stringify(data));
  await redisSet('kis_token', data.access_token, 82800);
  console.log('[token] 신규 발급 완료');
  return data.access_token;
}

// ─── KRX 상장종목 조회 (KOSPI + KOSDAQ만, 비상장·코넥스 제외) ───────────────

async function fetchAllListedStocks() {
  const KRX_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer':    'https://kind.krx.co.kr',
  };

  const fetchMarket = async (marketType, marketName) => {
    const url = `https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13&marketType=${marketType}`;
    const res  = await timedFetch(url, { headers: KRX_HEADERS });
    if (!res.ok) throw new Error(`KRX ${marketName} 응답 오류: ${res.status}`);
    // KRX HTML은 EUC-KR 인코딩 → ArrayBuffer로 받아서 명시적 디코딩
    const buf  = await res.arrayBuffer();
    const html = new TextDecoder('euc-kr').decode(buf);

    const stocks = [];
    // <tr> 행 추출 (첫 행은 헤더 → 건너뜀)
    const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch, isHeader = true;
    while ((rowMatch = rowRe.exec(html)) !== null) {
      if (isHeader) { isHeader = false; continue; }
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      while ((cm = cellRe.exec(rowMatch[1])) !== null) {
        cells.push(cm[1].replace(/<[^>]+>/g, '').trim());
      }
      if (cells.length < 3) continue;
      const name   = cells[0];
      const sector = cells[1] || '';  // 업종분류
      const code   = cells[2].replace(/\D/g, '').padStart(6, '0');  // 종목코드 (3번째 컬럼)
      if (!code || !/^\d{6}$/.test(code) || !name) continue;
      if (SKIP_KEYWORDS.some(kw => name.includes(kw))) continue;
      if (isETF(name)) continue;
      stocks.push({ code, name, corp_code: '', market: marketName, sector });
    }
    return stocks;
  };

  const [kospi, kosdaq] = await Promise.all([
    fetchMarket('stockMkt',  'KOSPI'),
    fetchMarket('kosdaqMkt', 'KOSDAQ'),
  ]);

  const all = [...kospi, ...kosdaq];
  console.log(`[krx] KOSPI ${kospi.length}개 + KOSDAQ ${kosdaq.length}개 = 총 ${all.length}개`);
  // 파싱 결과 샘플 출력 (코드·이름 확인용)
  console.log('[krx] 파싱 샘플:', all.slice(0, 5).map(s => `${s.code}(${s.market}) ${s.name}`).join(', '));
  if (all.length < 1000) throw new Error(`KRX 종목 수 이상 (${all.length}개) — 응답 확인 필요`);
  return all;
}

// ─── KIS 일봉 조회 (거래량·외인 포함) ─────────────────────────────────────

function kisHeaders(token, trId) {
  return {
    Authorization: `Bearer ${token}`,
    appkey: KIS_KEY, appsecret: KIS_SEC,
    'tr_id': trId, custtype: 'P',
    'Content-Type': 'application/json',
  };
}

async function fetchDailyCandles(token, code, mkCode) {
  // analyze.js와 완전히 동일한 엔드포인트 사용 → 같은 데이터 → 같은 점수
  // FHKST01010400(inquire-daily-price)는 반환 레코드 수가 달라 RSI 등 지표 차이 발생
  const now     = new Date();
  const endDt   = now.toISOString().slice(0, 10).replace(/-/g, '');
  const startDt = new Date(now - 240 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');

  // analyze.js와 동일하게 FID_COND_MRKT_DIV_CODE=J 고정
  // (FHKST03010100 엔드포인트는 J로 KOSPI/KOSDAQ 모두 조회 가능)
  const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice` +
    `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}` +
    `&FID_INPUT_DATE_1=${startDt}&FID_INPUT_DATE_2=${endDt}` +
    `&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

  return timedFetch(url, { headers: kisHeaders(token, 'FHKST03010100') }).then(r => r.json());
}

// ─── KIS 현재가 + 기본 정보 (PER·PBR·EPS·시가총액·업종) ───────────────────

async function fetchStockInfo(token, code, mkCode) {
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: mkCode,
    fid_input_iscd:         code,
  });

  return timedFetch(
    `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
    { headers: kisHeaders(token, 'FHKST01010100') }
  ).then(r => r.json());
}

// ─── MA 계산 ───────────────────────────────────────────────────────────────

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

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d; else lossSum -= d;
  }
  let ag = gainSum / period, al = lossSum / period;
  rsi[period] = al === 0 ? 100 : Math.round((100 - 100 / (1 + ag / al)) * 10) / 10;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = al === 0 ? 100 : Math.round((100 - 100 / (1 + ag / al)) * 10) / 10;
  }
  return rsi;
}

// ─── EMA / MACD / OBV / Bollinger (analyze.js와 동일) ─────────────────────

function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  if (arr.length < period) return out;
  out[period - 1] = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) out[i] = arr[i] * k + out[i - 1] * (1 - k);
  return out;
}

function calcMACDFull(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = closes.map((_, i) =>
    ema12[i] !== null && ema26[i] !== null ? ema12[i] - ema26[i] : null
  );
  const start = macdLine.findIndex(v => v !== null);
  if (start < 0) return null;
  const signal = new Array(closes.length).fill(null);
  const k = 2 / 10;
  let cnt = 0, seed = 0;
  for (let i = start; i < closes.length; i++) {
    if (macdLine[i] === null) continue;
    cnt++;
    seed += macdLine[i];
    if (cnt === 9) { signal[i] = seed / 9; }
    else if (cnt > 9) { signal[i] = macdLine[i] * k + signal[i - 1] * (1 - k); }
  }
  const n = closes.length - 1;
  if (macdLine[n] === null || signal[n] === null) return null;
  const hist = macdLine[n] - signal[n];
  const prevHist = n > 0 && macdLine[n - 1] !== null && signal[n - 1] !== null
    ? macdLine[n - 1] - signal[n - 1] : null;
  return { hist, prevHist };
}

function calcOBVArr(closes, volumes) {
  const obv = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const v = volumes[i] || 0;
    if      (closes[i] > closes[i - 1]) obv[i] = obv[i - 1] + v;
    else if (closes[i] < closes[i - 1]) obv[i] = obv[i - 1] - v;
    else                                 obv[i] = obv[i - 1];
  }
  return obv;
}

function calcBollingerWidths(closes, period = 20) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const s    = closes.slice(i - period + 1, i + 1);
    const mean = s.reduce((a, b) => a + b, 0) / period;
    const std  = Math.sqrt(s.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / period);
    return mean > 0 ? (std * 2 * 2) / mean : null; // band width ratio
  });
}

// ─── 통합 스코어 (analyze.js calcScore와 완전 동일) ───────────────────────

function calcScore(closes, volumes) {
  const n = closes.length - 1;
  const cur = closes[n];
  if (n < 21 || !cur) return 0;
  let score = 0;

  // 1. 추세 구조 (40점)
  const ma5a   = calcMAArr(closes, 5);
  const ma20a  = calcMAArr(closes, 20);
  const ma60a  = calcMAArr(closes, Math.min(60,  n + 1));
  const ma120a = calcMAArr(closes, Math.min(120, n + 1));
  const ma5   = ma5a[n]   || 0;
  const ma20  = ma20a[n]  || 0;
  const ma60  = ma60a[n]  || 0;
  const ma120 = ma120a[n] || 0;
  const pm5   = (n > 0 ? ma5a[n - 1]  : 0) || 0;
  const pm20  = (n > 0 ? ma20a[n - 1] : 0) || 0;

  // 1a. 이평선 배열 (20점) — 5단계
  if (ma5 && ma20 && ma60 && ma120 && ma5 > ma20 && ma20 > ma60 && ma60 > ma120)
    score += 20; // 완벽 정배열 5>20>60>120
  else if (ma5 && ma20 && ma60 && ma5 > ma20 && ma20 > ma60)
    score += 16; // 3선 정배열 5>20>60
  else if (pm5 && pm20 && ma5 && ma20 && pm5 <= pm20 && ma5 > ma20)
    score += 13; // 골든크로스
  else if (ma20 && ma60 && ma20 > ma60)
    score += 8;  // 중기 정배열 20>60
  else if (ma5 && ma20 && ma5 > ma20)
    score += 4;  // 단기 우위

  // 1b. MA20 이격도 (20점) — 5단계
  if (ma20) {
    const d = cur / ma20 * 100;
    if      (d >= 101 && d <= 106)                             score += 20; // 이상적 상승권
    else if ((d >= 100 && d <  101) || (d > 106 && d <= 109)) score += 16; // 안정 상승
    else if ((d >=  95 && d < 100)  || (d > 109 && d <= 112)) score += 10; // 소폭 이탈/과열
    else if ((d >=  92 && d <  95)  || (d > 112 && d <= 116)) score += 5;  // 중간 이탈/과열
    // 92% 미만 or 116% 초과: 0점
  }

  // 2. 모멘텀 (30점)
  // 2a. RSI (15점) — 6단계
  const rsiArr = calcRSI(closes);
  const rsi = rsiArr[n];
  if (rsi !== null) {
    if      (rsi >= 58 && rsi <  68) score += 15; // 최적 상승
    else if (rsi >= 52 && rsi <  58) score += 10; // 강세
    else if (rsi >= 68 && rsi <  73) score += 10; // 과매수 초입
    else if (rsi >= 47 && rsi <  52) score += 6;  // 중립
    else if (rsi >= 73)              score += 3;  // 과매수
    else if (rsi >= 40 && rsi <  47) score += 2;  // 약세
    // RSI < 40: 0점
  }

  // 2b. MACD (15점) — 5단계
  const macd = calcMACDFull(closes);
  if (macd) {
    if      (macd.hist > 0 && macd.prevHist !== null && macd.hist > macd.prevHist)
      score += 15; // 양수 확장 (양전환 포함)
    else if (macd.hist > 0 && macd.prevHist !== null && macd.prevHist > 0 && macd.hist > macd.prevHist * 0.7)
      score += 10; // 양수 미미 축소 (70% 이상 유지)
    else if (macd.hist > 0)
      score += 7;  // 양수 강한 축소
    else if (macd.hist !== null && macd.prevHist !== null && macd.hist < 0
          && macd.hist > macd.prevHist && macd.hist > macd.prevHist * 0.5)
      score += 5;  // 음수 강하게 수축
    else if (macd.hist !== null && macd.prevHist !== null && macd.hist < 0 && macd.hist > macd.prevHist)
      score += 3;  // 음수 수축
    // 음수 확장: 0점
  }

  // 3. 거래량 수급 (30점)
  if (volumes && volumes.length > 5) {
    // 3a. 거래량 5일 평균 대비 (15점) — 6단계
    const past5 = volumes.slice(Math.max(0, n - 5), n);
    const avg5  = past5.length ? past5.reduce((a, b) => a + b, 0) / past5.length : 0;
    if (avg5 > 0) {
      const ratio = volumes[n] / avg5;
      if      (ratio >= 3.0) score += 15; // 폭발적
      else if (ratio >= 2.0) score += 12; // 세력 개입
      else if (ratio >= 1.5) score += 9;  // 강한 관심
      else if (ratio >= 1.0) score += 6;  // 평균 이상
      else if (ratio >= 0.7) score += 3;  // 소폭 미달
      // 70% 미만: 0점
    }

    // 3b. OBV 60일 최고치 대비 (15점) — 5단계
    const obv    = calcOBVArr(closes, volumes);
    const window = obv.slice(Math.max(0, n - 60), n + 1);
    const obvMax = Math.max(...window);
    if      (obv[n] >= obvMax * 0.98) score += 15; // 신고치 갱신
    else if (obv[n] >= obvMax * 0.90) score += 11; // 최고치 근접
    else if (obv[n] >= obvMax * 0.80) score += 7;  // 접근
    else if (obv[n] >= obvMax * 0.65) score += 4;  // 중간
    // 65% 미만: 0점
  }

  // 볼린저 스퀴즈 레이어 (±10점)
  const widths = calcBollingerWidths(closes);
  const curW   = widths[n];
  const histW  = widths.slice(Math.max(0, n - 120), n).filter(x => x !== null);
  if (curW !== null && histW.length >= 20) {
    const minW = Math.min(...histW);
    if (curW <= minW * 1.1 && volumes && volumes.length > 5) {
      const vol5 = volumes.slice(Math.max(0, n - 5), n).reduce((a, b) => a + b, 0) / 5;
      // analyze.js calcBollinger와 동일: Math.round() 적용하여 반올림 일치
      const s20  = closes.slice(Math.max(0, n - 19), n + 1);
      const mean = s20.reduce((a, b) => a + b, 0) / s20.length;
      const std  = Math.sqrt(s20.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / s20.length);
      const bollUpper = Math.round(mean + std * 2);
      const bollLower = Math.round(mean - std * 2);
      if (cur > bollUpper && vol5 > 0 && volumes[n] > vol5 * 2) score += 10;
      else if (cur < bollLower)                                   score -= 10;
    }
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── 국장 특화 스코어 (30점) ─────────────────────────────────────────────────
// PBR 저평가(12) + PER 저평가(8) + 패닉셀링 감지(10)
// PBR·PER: 구간 점프 없는 연속 공식 (경계선 불이익 제거)
function calcKoreanScore(pbr, per, rsiLatest, closes) {
  const n   = closes.length - 1;
  const cur = closes[n];

  // PBR 저평가 (최대 12점) — 선형: PBR 0배=12점, 1.5배=0점
  const pbrScore = pbr > 0 ? Math.max(0, 12 * (1.5 - pbr) / 1.5) : 0;

  // PER 저평가 (최대 8점) — 선형: PER 0배=8점, 25배=0점 / 적자(≤0)는 0점
  const perScore = per > 0 ? Math.max(0, 8 * (25 - per) / 25) : 0;

  // 패닉셀링 감지 (최대 10점) — RSI·낙폭 조합 조건 → 구간 방식 유지
  const recentHigh = Math.max(...closes.slice(Math.max(0, n - 120), n + 1));
  const drawdown   = recentHigh > 0 ? (recentHigh - cur) / recentHigh * 100 : 0;
  let panicScore = 0;
  if (rsiLatest !== null && rsiLatest !== undefined) {
    if      (rsiLatest < 25 && drawdown >= 30) panicScore = 10;
    else if (rsiLatest < 35 && drawdown >= 20) panicScore = 7;
    else if (rsiLatest < 35)                   panicScore = 4;
    else if (rsiLatest < 40)                   panicScore = 2;
  }

  return Math.round(pbrScore + perScore + panicScore);
}

function maSignal(price, ma) {
  if (!ma || !price) return 'neutral';
  const r = (price - ma) / ma * 100;
  if (r > 1)  return 'up';
  if (r < -1) return 'down';
  return 'neutral';
}

// ─── 스코어링 & 분석 ───────────────────────────────────────────────────────

function analyze(stock, closes, volumes, extra = {}) {
  if (closes.length < 22) return null;
  const n = closes.length - 1, cur = closes[n];
  if (!cur) return null;

  // ── MA 배열 계산 (signals용) ──
  const ma5a  = calcMAArr(closes, 5);
  const ma20a = calcMAArr(closes, 20);
  const ma60a = calcMAArr(closes, Math.min(60, closes.length));

  const ma5  = ma5a[n]  || 0;
  const ma20 = ma20a[n] || 0;
  const ma60 = ma60a[n] || 0;

  const signals = [];

  // ── 신호 텍스트 생성 ──
  if (ma5 && ma20 && ma60) {
    if      (ma5 > ma20 && ma20 > ma60) signals.push('정배열 — 단기·중기·장기 모두 우상향');
    else if (ma5 < ma20 && ma20 < ma60) signals.push('역배열 — 하락 추세 지속 주의');
    else if (ma5 > ma20)                signals.push('단기 이평선 상향 — 중기 회복 진행 중');
    else if (ma20 > ma60)               signals.push('중기 이평선 상향 — 장기 추세 전환 시도');
  }
  if (n >= 1) {
    const pm5 = ma5a[n - 1] || 0, pm20 = ma20a[n - 1] || 0;
    if (pm5 && pm20 && ma5 && ma20) {
      if (pm5 <= pm20 && ma5 > ma20) signals.unshift('골든크로스 발생 — 단기 강세 신호 ✓');
      if (pm5 >= pm20 && ma5 < ma20) signals.unshift('데드크로스 발생 — 단기 주의 신호');
    }
  }

  // ── 통합 퀀트 스코어: 기술지표 70% + 국장 특화 30점 ──
  const rsiArr2  = calcRSI(closes);
  const techScore = calcScore(closes, volumes);
  const korScore  = calcKoreanScore(extra.pbr || 0, extra.per || 0, rsiArr2[n], closes);
  const score     = Math.min(100, Math.round(techScore * 0.7) + korScore);

  const chgRate = closes.length >= 2
    ? ((cur - closes[n - 1]) / closes[n - 1] * 100).toFixed(2) : '0.00';

  return {
    code:        stock.code,
    name:        stock.name,
    corp_code:   stock.corp_code || '',
    market:      stock.market,
    sector:      extra.sector    || stock.sector || '',
    price:       cur,
    chgRate:     parseFloat(chgRate),
    ma5, ma20, ma60,
    ma5Signal:   maSignal(cur, ma5),
    ma20Signal:  maSignal(cur, ma20),
    ma60Signal:  maSignal(cur, ma60),
    score,
    signals:     signals.slice(0, 2),
    // 수급·기본 정보
    volume:      extra.volume      || 0,
    avgVol5:     extra.avgVol5     || 0,   // 5일 평균 거래량
    frgnRatio:   extra.frgnRatio   || 0,   // 외인 보유율 (%)
    frgnBuyQty:  extra.frgnBuyQty  || 0,   // 외인 순매수 수량 (당일)
    mktCap:      extra.mktCap      || 0,   // 시가총액 (억원)
    per:         extra.per         || 0,
    pbr:         extra.pbr         || 0,
    eps:         extra.eps         || 0,
  };
}

// ─── 단일 종목 처리 ────────────────────────────────────────────────────────

async function processStock(token, stock) {
  const markets = stock.market ? [stock.market === 'KOSPI' ? 'J' : 'Q'] : ['J', 'Q'];

  for (const mkCode of markets) {
    try {
      // 1) 일봉 데이터 조회
      const raw = await fetchDailyCandles(token, stock.code, mkCode);
      const rawOutput = raw?.output2 ?? raw?.output;
      if (!rawOutput?.length) continue;

      // analyze.js와 동일: 종가 0인 행 제거 (거래정지·휴장일 오류 방지)
      const recent      = rawOutput.filter(d => parseNum(d.stck_clpr) > 0).slice(0, 150);  // 최신순 상위 150개 — MA120 계산에 충분한 거래일 수
      const latestDay   = recent[0];                // 가장 최근 일봉
      const reversed    = recent.slice().reverse();
      const closes      = reversed.map(d => parseNum(d.stck_clpr));
      const volumes     = reversed.map(d => parseNum(d.acml_vol));

      if (closes.length < 22) continue;
      if (!closes[closes.length - 1]) continue;     // 최근 종가 0 → 거래 없음

      // 일봉에서 수급 데이터 추출
      const volume     = parseNum(latestDay?.acml_vol);
      const frgnRatio  = parseF(latestDay?.hts_frgn_ehrt);
      const frgnBuyQty = parseNum(latestDay?.frgn_ntby_qty);
      // 5일 평균 거래량 (거래대금 정렬용)
      const vLast  = volumes.length - 1;
      const avgVol5 = Math.round(
        volumes.slice(Math.max(0, vLast - 4), vLast + 1).reduce((a, b) => a + b, 0) /
        Math.min(5, vLast + 1)
      );

      // 5일/20일 투자자 수급 (FHKST01010900 → output 배열 30일치)
      let investorSupply = null;
      try {
        const invRaw = await timedFetch(
          `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor` +
          `?fid_cond_mrkt_div_code=${mkCode}&fid_input_iscd=${stock.code}`,
          { headers: kisHeaders(token, 'FHKST01010900') }
        ).then(r => r.json()).catch(() => null);

        const rows = Array.isArray(invRaw?.output) ? invRaw.output : [];
        if (rows.length >= 5) {
          const sumN   = (arr, f) => arr.reduce((s, d) => s + parseNum(d[f] || '0'), 0);
          const fmtBsop = d => { const dt = d?.stck_bsop_date; return dt ? `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}` : ''; };
          const rows5  = rows.slice(0, 5);
          const rows20 = rows.slice(0, Math.min(20, rows.length));
          investorSupply = {
            d5:  { foreign: sumN(rows5,'frgn_ntby_qty'),  inst: sumN(rows5,'orgn_ntby_qty'),  personal: sumN(rows5,'prsn_ntby_qty'),  from: fmtBsop(rows5[rows5.length-1]),  to: fmtBsop(rows5[0]) },
            d20: { foreign: sumN(rows20,'frgn_ntby_qty'), inst: sumN(rows20,'orgn_ntby_qty'), personal: sumN(rows20,'prsn_ntby_qty'), from: fmtBsop(rows20[rows20.length-1]), to: fmtBsop(rows20[0]) },
          };
        }
      } catch (_) {}

      // 2) 현재가 + 기본 정보 조회 (PER·PBR·EPS·시가총액·업종)
      let mktCap = 0, per = 0, pbr = 0, eps = 0, sector = '';
      try {
        const info = await fetchStockInfo(token, stock.code, mkCode);
        const o = info?.output;
        if (o) {
          mktCap = parseNum(o.hts_avls);
          per    = parseF(o.per  || '0');
          pbr    = parseF(o.pbr  || '0');
          eps    = parseF(o.eps  || '0');
          sector = (o.bstp_kor_isnm || o.bstp_kor_isn_nm || '').trim();
        }
      } catch (_) { /* 기본정보 실패 시 무시 */ }

      const market = mkCode === 'J' ? 'KOSPI' : 'KOSDAQ';
      const result = analyze(
        { ...stock, market },
        closes,
        volumes,
        { volume, frgnRatio, frgnBuyQty, avgVol5, mktCap, per, pbr, eps, sector }
      );
      if (result) result.investorSupply = investorSupply;
      return result;

    } catch (e) {
      console.error(`[processStock] ${stock.code}(${stock.market}) 실패:`, e.message);
      continue;
    }
  }
  return null;
}

// ─── 메인 ──────────────────────────────────────────────────────────────────

async function main() {
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  console.log(`\n=== 전종목 MA + 기본정보 분석: ${kstNow.toISOString().replace('T',' ').slice(0,19)} KST ===\n`);

  // 1. KRX 상장종목 목록
  console.log('[1/4] KRX KOSPI·KOSDAQ 상장종목 조회...');
  let allStocks;
  try   { allStocks = await fetchAllListedStocks(); }
  catch (e) { console.error('[1/4] 실패:', e.message); process.exit(1); }

  // 2. KIS 토큰
  console.log('[2/4] KIS 토큰 확인...');
  let token;
  try   { token = await getKisToken(); }
  catch (e) { console.error('[2/4] 실패:', e.message); process.exit(1); }

  // 3. 배치 처리
  console.log(`[3/4] 일봉 + 기본정보 조회... (${allStocks.length}개, 배치 ${BATCH_SIZE}개)`);
  const results = [];
  let processed = 0, failed = 0;

  for (let i = 0; i < allStocks.length; i += BATCH_SIZE) {
    const batch    = allStocks.slice(i, i + BATCH_SIZE);
    const batchRes = await Promise.all(batch.map(s => processStock(token, s)));
    batchRes.forEach(r => { if (r) results.push(r); else failed++; });
    processed += batch.length;

    if (processed % 200 === 0 || i + BATCH_SIZE >= allStocks.length) {
      const pct = ((processed / allStocks.length) * 100).toFixed(1);
      console.log(`      ${processed}/${allStocks.length} (${pct}%) | 성공 ${results.length} / 실패 ${failed}`);
    }
    await sleep(BATCH_DELAY);
  }

  // 4. Redis 저장
  console.log('[4/4] Redis 저장...');
  results.sort((a, b) => b.score - a.score);

  const baseDate = kstNow.toISOString().slice(0, 10);
  const payload  = { stocks: results, baseDate, total: results.length, updatedAt: kstNow.toISOString() };

  // recommend_v2: 종목 목록 (investorSupply 포함)
  await redisSet('recommend_v2', payload, 28 * 3600);

  // investor_supply: 코드 → 수급 데이터 맵 (analyze API 전용, 빠른 단건 조회)
  const invMap = {};
  results.forEach(s => { if (s.investorSupply) invMap[s.code] = s.investorSupply; });
  await redisSet('investor_supply', invMap, 28 * 3600);

  // stock_scores: 코드 → 점수 맵 (analyze API 점수 동기화용 — 메인/분석기 동일 점수 보장)
  const scoreMap = {};
  results.forEach(s => { scoreMap[s.code] = s.score; });
  await redisSet('stock_scores', scoreMap, 28 * 3600);

  console.log(`      완료: ${results.length}개 종목 저장, 수급 맵 ${Object.keys(invMap).length}개, 점수 맵 ${Object.keys(scoreMap).length}개, 기준일 ${baseDate}`);
  console.log('\n=== 완료 ===\n');
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
