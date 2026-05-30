/**
 * 전종목 MA + 기본 정보 분석 업데이트 스크립트 (매일 실행)
 * - KRX → KOSPI·KOSDAQ 상장종목 목록 (비상장·코넥스 완전 제외)
 * - KIS (FHKST03010100) → 일봉 (거래량, 외인보유율, 외인순매수 포함)
 * - KIS (FHKST01010100) → 시가총액, PER, PBR, EPS, 업종명
 * - MA5/MA20/MA60 계산, 스코어링 → Redis 저장
 *
 * DART EPS는 update-dart-eps.js (분기 1회) 에서 별도 관리
 * analyze.js에서 PER = 현재가 ÷ dart_eps 로 실시간 계산
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const KV_URL    = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;
const KIS_KEY   = process.env.KIS_APP_KEY;
const KIS_SEC   = process.env.KIS_APP_SECRET;

const BATCH_SIZE  = 6;
const BATCH_DELAY = 1200;
const TIMEOUT_MS  = 10000;

const SKIP_KEYWORDS = [
  '기업인수목적', '스팩', 'SPAC', '선박투자회사',
  '부동산투자회사', '인프라투자회사', '위탁관리부동산',
];
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

let _currentToken = null; // 모듈 레벨 캐시 — processStock에서 갱신 가능

async function getKisToken(force = false) {
  if (!force) {
    const cached = await redisGet('kis_token');
    if (cached) { console.log('[token] Redis 캐시 사용'); _currentToken = cached; return cached; }
  }

  const data = await timedFetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_KEY, appsecret: KIS_SEC }),
  }).then(r => r.json());

  if (!data.access_token) throw new Error('KIS 토큰 실패: ' + JSON.stringify(data));
  await redisSet('kis_token', data.access_token, 82800);
  console.log('[token] 신규 발급 완료');
  _currentToken = data.access_token;
  return data.access_token;
}

async function refreshTokenIfExpired(response) {
  if (response?.rt_cd !== '1') return false;
  console.warn('[token] 만료 감지 → 강제 재발급');
  await getKisToken(true);
  return true;
}

// ─── KRX 상장종목 조회 ─────────────────────────────────────────────────────

async function fetchAllListedStocks() {
  const KRX_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer':    'https://kind.krx.co.kr',
  };

  const fetchMarket = async (marketType, marketName) => {
    const url = `https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13&marketType=${marketType}`;
    const res  = await timedFetch(url, { headers: KRX_HEADERS });
    if (!res.ok) throw new Error(`KRX ${marketName} 응답 오류: ${res.status}`);
    const buf  = await res.arrayBuffer();
    const html = new TextDecoder('euc-kr').decode(buf);

    const stocks = [];
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
      const sector = cells[1] || '';
      const code   = cells[2].replace(/\D/g, '').padStart(6, '0');
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
  console.log('[krx] 파싱 샘플:', all.slice(0, 5).map(s => `${s.code}(${s.market}) ${s.name}`).join(', '));
  if (all.length < 1000) throw new Error(`KRX 종목 수 이상 (${all.length}개) — 응답 확인 필요`);
  return all;
}

// ─── KOSPI·KOSDAQ 수익률 조회 (벤치마크용) ─────────────────────────────────

async function fetchMarketReturns() {
  const YAHOO_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const symbols  = { kospi: '^KS11', kosdaq: '^KQ11' };
  const result   = {};
  let kospiDailyReturns = null;

  for (const [key, sym] of Object.entries(symbols)) {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=15mo`;
    const data = await timedFetch(url, { headers: YAHOO_UA }).then(r => r.json()).catch(e => {
      throw new Error(`[market_returns] ${key}(${sym}) Yahoo Finance 호출 실패: ${e.message}`);
    });
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c != null);
    if (!closes || closes.length < 63) {
      throw new Error(`[market_returns] ${key}(${sym}) 데이터 불충분 (${closes?.length ?? 0}개) — Yahoo Finance 응답 확인 필요`);
    }
    const ret = (back) => closes.length > back
      ? Math.round((closes[closes.length-1] - closes[closes.length-1-back]) / closes[closes.length-1-back] * 10000) / 100
      : null;
    result[key] = { '1m': ret(21), '3m': ret(63), '6m': ret(126), '12m': ret(252) };
    console.log(`      ${key}: 1m ${result[key]['1m']}% / 3m ${result[key]['3m']}% / 6m ${result[key]['6m']}% / 12m ${result[key]['12m']}%`);

    // KOSPI 일별 로그수익률 60개 — Fama-French 베타 계산용
    if (key === 'kospi') {
      const logRets = [];
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] > 0 && closes[i-1] > 0) logRets.push(Math.log(closes[i] / closes[i-1]));
      }
      kospiDailyReturns = logRets.slice(-90); // 최근 90거래일
    }
  }
  return { periodReturns: result, kospiDailyReturns };
}

// ─── KIS 일봉 조회 ─────────────────────────────────────────────────────────

function kisHeaders(token, trId) {
  return {
    Authorization: `Bearer ${token}`,
    appkey: KIS_KEY, appsecret: KIS_SEC,
    'tr_id': trId, custtype: 'P',
    'Content-Type': 'application/json',
  };
}

async function fetchDailyCandles(token, code, mkCode) {
  const now     = new Date();
  const endDt   = now.toISOString().slice(0, 10).replace(/-/g, '');
  const startDt = new Date(now - 400 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice` +
    `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}` +
    `&FID_INPUT_DATE_1=${startDt}&FID_INPUT_DATE_2=${endDt}` +
    `&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
  return timedFetch(url, { headers: kisHeaders(token, 'FHKST03010100') }).then(r => r.json());
}

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
    return mean > 0 ? (std * 2 * 2) / mean : null;
  });
}

function calcScore(closes, volumes) {
  const n = closes.length - 1;
  const cur = closes[n];
  if (n < 21 || !cur) return 0;
  let score = 0;

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

  if (ma5 && ma20 && ma60 && ma120 && ma5 > ma20 && ma20 > ma60 && ma60 > ma120)
    score += 20;
  else if (ma5 && ma20 && ma60 && ma5 > ma20 && ma20 > ma60)
    score += 16;
  else if (pm5 && pm20 && ma5 && ma20 && pm5 <= pm20 && ma5 > ma20)
    score += 13;
  else if (ma20 && ma60 && ma20 > ma60)
    score += 8;
  else if (ma5 && ma20 && ma5 > ma20)
    score += 4;

  if (ma20) {
    const d = cur / ma20 * 100;
    if      (d >= 101 && d <= 106)                             score += 20;
    else if ((d >= 100 && d <  101) || (d > 106 && d <= 109)) score += 16;
    else if ((d >=  95 && d < 100)  || (d > 109 && d <= 112)) score += 10;
    else if ((d >=  92 && d <  95)  || (d > 112 && d <= 116)) score += 5;
  }

  const rsiArr = calcRSI(closes);
  const rsi = rsiArr[n];
  if (rsi !== null) {
    if      (rsi >= 58 && rsi <  68) score += 15;
    else if (rsi >= 52 && rsi <  58) score += 10;
    else if (rsi >= 68 && rsi <  73) score += 10;
    else if (rsi >= 47 && rsi <  52) score += 6;
    else if (rsi >= 73)              score += 3;
    else if (rsi >= 40 && rsi <  47) score += 2;
  }

  const macd = calcMACDFull(closes);
  if (macd) {
    if      (macd.hist > 0 && macd.prevHist !== null && macd.hist > macd.prevHist)
      score += 15;
    else if (macd.hist > 0 && macd.prevHist !== null && macd.prevHist > 0 && macd.hist > macd.prevHist * 0.7)
      score += 10;
    else if (macd.hist > 0)
      score += 7;
    else if (macd.hist !== null && macd.prevHist !== null && macd.hist < 0
          && macd.hist > macd.prevHist && macd.hist > macd.prevHist * 0.5)
      score += 5;
    else if (macd.hist !== null && macd.prevHist !== null && macd.hist < 0 && macd.hist > macd.prevHist)
      score += 3;
  }

  if (volumes && volumes.length > 5) {
    const past5 = volumes.slice(Math.max(0, n - 5), n);
    const avg5  = past5.length ? past5.reduce((a, b) => a + b, 0) / past5.length : 0;
    if (avg5 > 0) {
      const ratio = volumes[n] / avg5;
      if      (ratio >= 3.0) score += 15;
      else if (ratio >= 2.0) score += 12;
      else if (ratio >= 1.5) score += 9;
      else if (ratio >= 1.0) score += 6;
      else if (ratio >= 0.7) score += 3;
    }

    const obv    = calcOBVArr(closes, volumes);
    const window = obv.slice(Math.max(0, n - 60), n + 1);
    const obvMax = Math.max(...window);
    if      (obv[n] >= obvMax * 0.98) score += 15;
    else if (obv[n] >= obvMax * 0.90) score += 11;
    else if (obv[n] >= obvMax * 0.80) score += 7;
    else if (obv[n] >= obvMax * 0.65) score += 4;
  }

  // ── 볼린저 심리 레이어 — 공포/탐욕 양방향 (±10점) ─────────────────────
  const widths = calcBollingerWidths(closes);
  const curW   = widths[n];
  const histW  = widths.slice(Math.max(0, n - 120), n).filter(x => x !== null);
  if (curW !== null && histW.length >= 20) {
    const minW = Math.min(...histW);
    const vol5 = (volumes && volumes.length > 5)
      ? volumes.slice(Math.max(0, n - 5), n).reduce((a, b) => a + b, 0) / 5 : 0;

    // [공포] 스퀴즈 돌파/붕괴 (기존 유지)
    if (curW <= minW * 1.1 && vol5 > 0) {
      const s20  = closes.slice(Math.max(0, n - 19), n + 1);
      const mean = s20.reduce((a, b) => a + b, 0) / s20.length;
      const std  = Math.sqrt(s20.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / s20.length);
      const bollUpper = Math.round(mean + std * 2);
      const bollLower = Math.round(mean - std * 2);
      if (cur > bollUpper && volumes[n] > vol5 * 2) score += 10;
      else if (cur < bollLower)                      score -= 10;
    }

    // [탐욕 과열 감지] RSI 극과매수 + 거래량 소멸 → 역발상 경고 ★
    const rsiNow = rsiArr[n];
    if (rsiNow !== null && rsiNow >= 75 && vol5 > 0) {
      const isVolDrying = volumes[n] < vol5 * 0.7;
      const isBBNarrow  = curW <= minW * 1.5;
      if      (rsiNow >= 80 && isVolDrying && isBBNarrow) score -= 6;
      else if (rsiNow >= 78 && isVolDrying)                score -= 4;
      else if (rsiNow >= 75 && isVolDrying)                score -= 3;
      else if (rsiNow >= 80)                               score -= 2;
    }
  }

  return { total: Math.max(0, Math.min(100, Math.round(score))), detail: {} };
}

// ── 생태계 기반 종목 티어 매핑 (코드 → Tier 1~6) ──────────────────────────────
// scripts/classify-ecosystem.js 실행 시 regenerate → data/sector-labels.json 저장 → 동적 로드
// Tier1=반도체·방산(8pt) / Tier2=배터리·로봇·원전(7pt) / Tier3=바이오·게임·SW·조선(6pt)
// Tier4=자동차·통신·화학·전자(4pt) / Tier5=금융·유통·건설(2pt) / Tier6=전통산업(0pt)
// prettier-ignore
const ECO_TIER = {
"000020":3,"000040":4,"000080":5,"000100":3,"000120":6,"000140":5,"000270":4,"000320":4,"000370":1,"000400":5,"000540":5,"000640":3,"000660":1,"000670":5,"000680":5,"000720":5,"000810":5,"000880":1,"000910":6,"000990":1,"001060":3,"001230":5,"001270":5,"001430":5,"001450":5,"001500":5,"001510":5,"001520":6,"001570":4,"001630":3,"001680":5,"001740":4,"001800":5,"002310":6,"002320":6,"002350":4,"002360":4,"002380":4,"002390":3,"002630":3,
"002790":5,"002810":5,"002880":4,"002990":5,"003000":3,"003030":5,"003060":3,"003070":2,"003090":3,"003200":6,"003220":3,"003230":5,"003240":3,"003280":6,"003470":5,"003480":6,"003490":6,"003520":3,"003530":1,"003540":5,"003550":5,"003580":3,"003610":6,"003620":4,"003650":5,"003670":2,"003690":5,"003830":1,"003850":3,"003920":6,"003960":5,"004000":4,"004020":5,"004140":3,"004150":1,"004170":5,"004360":6,"004370":5,"004380":2,"004440":2,
"004490":6,"004540":6,"004560":5,"004960":5,"004980":6,"004990":5,"005070":2,"005090":6,"005180":5,"005250":3,"005290":1,"005300":5,"005380":4,"005430":6,"005490":5,"005500":3,"005740":5,"005810":1,"005830":5,"005850":4,"005930":1,"005940":5,"005950":2,"005960":5,"006260":5,"006280":3,"006360":5,"006400":2,"006650":4,"006800":5,"006910":2,"007070":5,"007160":5,"007210":6,"007310":5,"007570":3,"007590":3,"007660":1,"007700":6,"007770":6,
"007810":1,"008060":1,"008490":5,"008730":4,"008930":3,"008970":6,"009140":1,"009150":1,"009190":5,"009200":6,"009270":6,"009410":5,"009420":3,"009450":4,"009540":3,"009810":3,"009830":1,"009970":6,"010060":4,"010130":5,"010140":3,"010280":3,"010400":2,"010580":3,"010690":4,"010770":4,"010780":6,"010820":1,"010950":6,"011000":3,"011040":3,"011070":1,"011170":4,"011210":2,"011230":1,"011420":3,"011500":2,"011760":3,"011780":4,"011790":4,
"012030":5,"012170":3,"012330":4,"012450":1,"012510":3,"012690":6,"012750":4,"013520":3,"013570":4,"013580":5,"013700":5,"013810":1,"014190":1,"014440":4,"014620":2,"014680":1,"015260":1,"015750":4,"015760":2,"015860":4,"015890":4,"016360":5,"016380":5,"016610":5,"017000":6,"017480":5,"017670":4,"017900":1,"017960":3,"018290":5,"018500":4,"018620":2,"018880":4,"019170":3,"019180":4,"020000":6,"020120":3,"020150":5,"020180":4,"020560":6,
"021040":5,"021240":4,"021320":4,"021820":4,"023160":3,"023530":5,"023770":3,"023800":4,"023810":4,"024110":5,"024800":2,"024850":3,"024900":4,"024910":4,"025540":4,"025820":2,"025860":4,"025900":2,"026150":5,"026960":6,"027970":6,"028260":5,"028300":3,"028670":5,"030190":5,"030350":3,"030520":3,"030530":1,"030610":5,"031310":4,"031330":1,"031430":5,"031440":5,"031820":3,"031980":1,"032350":5,"032560":5,"032640":4,"032800":3,"032820":2,
"032830":5,"032940":1,"033160":1,"033170":1,"033500":3,"033530":5,"033640":1,"033920":5,"034020":2,"034120":3,"034220":3,"035420":3,"035510":5,"035720":3,"035760":3,"035900":3,"036010":1,"036200":1,"036420":3,"036530":1,"036540":1,"036570":3,"036620":3,"036630":4,"036710":1,"036810":1,"036830":1,"036930":1,"037070":4,"037460":1,"037560":5,"037710":5,"038110":4,"038500":6,"038530":3,"039030":1,"039200":3,"039440":1,"039490":5,"039840":3,
"039860":3,"039980":3,"040910":1,"041190":2,"041510":3,"041520":1,"041650":3,"041830":3,"041910":3,"041920":3,"042420":3,"042660":1,"042700":1,"043100":3,"043150":3,"043260":1,"043610":4,"043650":5,"044340":4,"044820":5,"044990":2,"045100":1,"045520":1,"046120":1,"046210":3,"046390":3,"046890":1,"047040":5,"047050":5,"047310":1,"047400":6,"047560":3,"047810":1,"047820":3,"047920":3,"048410":3,"048530":3,"048550":3,"049070":1,"049080":1,
"049800":2,"049960":3,"050760":1,"051370":1,"051490":2,"051500":5,"051600":2,"051900":5,"051910":4,"052260":3,"052690":2,"052710":1,"053030":3,"053050":2,"053060":4,"053610":1,"053700":4,"054450":1,"054780":3,"054950":1,"055490":6,"055550":5,"056080":2,"058110":3,"058470":1,"058610":2,"058630":3,"058650":5,"058850":4,"058860":4,"060370":5,"060380":6,"060720":3,"060900":3,"061250":4,"061970":1,"062970":1,"063080":3,"063160":3,"064290":1,
"064350":1,"064400":2,"064550":3,"064760":1,"064960":1,"065450":1,"065650":3,"065680":1,"066410":3,"066570":4,"066910":3,"066970":2,"067000":3,"067170":4,"067310":1,"067390":1,"067630":3,"067990":4,"068270":3,"068760":3,"069080":3,"069260":4,"069540":1,"069620":3,"069960":5,"071050":5,"071670":4,"071840":5,"072710":5,"072770":3,"073110":1,"073240":4,"073490":1,"073570":2,"074600":1,"075580":3,"077360":1,"078020":5,"078070":1,"078150":1,
"078160":3,"078340":3,"078350":1,"078520":5,"078600":2,"079370":1,"079550":1,"079900":2,"079960":6,"080220":1,"080720":6,"082210":1,"082640":5,"082740":1,"083310":1,"083450":1,"083500":2,"083650":2,"084370":1,"084650":3,"084670":6,"084690":5,"085620":5,"085660":3,"086060":3,"086280":4,"086390":1,"086450":3,"086520":2,"086790":5,"086890":3,"086900":3,"086980":3,"088350":1,"088790":4,"088800":1,"089030":1,"089590":6,"089600":4,"089860":5,
"089970":1,"090360":2,"090430":5,"090460":1,"090710":2,"091810":6,"091970":1,"092070":1,"092190":1,"092230":4,"093050":6,"093320":3,"093370":1,"094360":1,"094820":2,"094970":1,"095610":1,"095660":3,"095700":3,"095910":6,"096530":3,"096610":1,"096770":2,"097230":3,"097520":1,"097950":5,"098120":1,"098460":2,"098660":2,"099190":3,"099320":1,"099410":3,"100120":3,"100840":1,"101360":2,"101390":1,"101490":1,"101530":5,"101670":2,"101730":3,
"102120":1,"102710":1,"103140":1,"103590":4,"104040":3,"104460":4,"104830":1,"105560":5,"105630":6,"105840":2,"108230":2,"108320":1,"108490":2,"108670":6,"108860":3,"109070":3,"109820":3,"111770":6,"112040":3,"112290":1,"114190":6,"114810":1,"115450":3,"117580":6,"117730":2,"119850":2,"121600":2,"122310":3,"122350":4,"122640":1,"123040":4,"123420":3,"123860":1,"124500":3,"126340":1,"126640":4,"126730":1,"128940":3,"130660":2,"131970":1,
"134380":4,"137400":2,"137940":1,"138070":3,"138930":5,"139130":5,"139480":5,"140860":1,"141000":1,"142210":1,"142280":3,"143210":3,"144960":1,"145020":3,"145720":3,"149950":3,"149980":3,"150900":3,"160190":2,"160550":3,"160980":1,"161390":4,"161890":5,"166090":1,"168360":1,"170900":3,"171010":1,"172670":1,"173940":3,"174900":3,"175330":5,"178920":1,"179530":3,"180640":6,"182400":3,"183190":6,"183300":1,"185490":3,"185750":3,"187270":1,
"187420":3,"189330":3,"190650":5,"192080":3,"192400":4,"192820":5,"194370":2,"194480":3,"195870":1,"195990":3,"196170":3,"196300":3,"196490":2,"199550":3,"199800":3,"200350":3,"200470":1,"200710":1,"200880":4,"201490":3,"203450":6,"204320":4,"206640":3,"206650":3,"207940":3,"210540":4,"211270":1,"213420":1,"214150":3,"214320":3,"214390":3,"214420":5,"214450":3,"214680":2,"215480":6,"215600":3,"217270":3,"217730":3,"217820":1,"218410":1,
"219550":4,"221840":1,"222040":5,"222080":1,"222800":1,"223250":1,"225570":3,"226320":5,"226950":3,"227840":3,"228340":6,"228670":3,"228850":3,"229640":5,"232830":2,"234030":3,"234690":3,"235980":3,"237690":3,"237820":3,"237880":5,"239340":3,"240550":3,"240600":1,"240810":1,"241710":5,"241770":1,"241790":2,"241840":3,"243840":2,"246250":4,"247540":2,"249420":3,"251270":3,"251370":1,"251630":2,"252990":2,"253450":3,"253840":3,"256150":3,
"256630":1,"257370":2,"257720":5,"259630":2,"259960":3,"263050":3,"263750":3,"263800":3,"264450":4,"264660":1,"265520":1,"267980":6,"270660":2,"271560":5,"271980":3,"272110":1,"272210":1,"272290":1,"272450":6,"274090":1,"274400":3,"277810":2,"278280":2,"278470":5,"278650":3,"280360":5,"281740":1,"281820":1,"282330":5,"282720":4,"285490":3,"286940":5,"293490":3,"294090":3,"295310":1,"297890":3,"298000":4,"298380":3,"298690":6,"299030":2,
"299900":3,"300720":6,"301300":3,"302430":2,"304100":3,"307950":3,"310870":4,"314130":3,"314930":3,"315640":3,"316140":5,"317450":3,"317870":3,"318160":3,"319660":1,"320000":1,"321550":3,"322000":2,"322180":5,"322510":3,"323410":3,"323990":3,"329180":3,"330860":1,"334970":3,"336260":2,"336370":2,"336570":3,"338220":3,"338840":3,"340810":3,"344820":4,"347860":3,"348150":3,"348340":2,"348350":1,"348370":2,"352820":3,"353200":1,"356680":1,
"357780":1,"357880":1,"361390":1,"365340":2,"368770":1,"373170":3,"373220":2,"375500":5,"377300":3,"377330":1,"377480":3,"378340":2,"382900":2,"383220":6,"383310":2,"383800":5,"384470":2,"388050":6,"389260":6,"389500":2,"394280":1,"396270":1,"399720":1,"402030":3,"403550":3,"403870":1,"408900":3,"408920":3,"412350":1,"415380":3,"417200":5,"417840":1,"418420":1,"418470":4,"419050":4,"419540":3,"420770":1,"424960":3,"425420":1,"432470":2,
"432720":1,"439090":5,"440110":1,"443060":3,"443250":3,"444530":3,"445090":1,"445680":1,"448710":1,"448900":1,"450080":2,"451220":1,"452190":3,"452260":1,"452430":1,"453450":3,"454910":2,"457550":2,"459510":2,"460860":5,"460870":3,"461030":1,"463020":3,"466100":2,"474650":3,"478340":1,"489790":1,"490470":1,"493280":1,"900070":3,"900140":1,"900310":3,"950190":3,"950210":3
};

// 동적 분류 오버라이드 — classify-ecosystem.js 가 data/sector-labels.json 생성 시 자동 반영
try {
  const labelsPath = path.join(__dirname, '../data/sector-labels.json');
  if (fs.existsSync(labelsPath)) {
    const dynamic = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
    Object.assign(ECO_TIER, dynamic);
    console.log(`[sector-labels] 동적 분류 로드: ${Object.keys(dynamic).length}개 종목 병합`);
  }
} catch (e) { console.warn('[sector-labels] 로드 실패, 하드코딩 ECO_TIER 사용:', e.message); }

const ECO_TIER_SCORES = { 1:8, 2:7, 3:6, 4:4, 5:2, 6:0 };

// ── 테마 티어 오버라이드 (코드 → theme_tier) ────────────────────────────────
// 본업 ECO_TIER와 별도로, 강한 테마 노출이 있는 종목에 테마 티어 부여
// sectorGrowthScore에서 min(ECO_TIER, ECO_THEME) → 두 티어 중 높은 점수 자동 선택
// prettier-ignore
const ECO_THEME = {
  // ── 원전 테마 건설주 ── (본업: 건설_인프라 T5=2pt → 테마 점수 상향)
  "000720": 3,  // 현대건설  — 국내 원전 EPC 주계약자         (T5→T3: 8pt)
  "028260": 3,  // 삼성물산  — APR1400 원전 건설·EPC 핵심사   (T5→T3: 8pt)
  "047040": 4,  // 대우건설  — 원전 시공 참여                  (T5→T4: 5pt)
  "006360": 4,  // GS건설   — 원전 시공 참여                   (T5→T4: 5pt)
  "375500": 4,  // DL이앤씨 — 원전 시공 참여                   (T5→T4: 5pt)
};

// KIS 업종명 fallback (ECO_TIER에 없는 미분류 종목용)
const GROWTH_TIER1 = ['반도체', '방위산업'];
const GROWTH_TIER2 = ['바이오', '의약품', '2차전지', '로봇', '우주항공'];
const GROWTH_TIER3 = ['소프트웨어', '인터넷', '게임', '의료기기', '디스플레이'];
const GROWTH_TIER4 = ['통신장비', '전기장비'];
const GROWTH_SECTOR_KW = [...GROWTH_TIER1, ...GROWTH_TIER2, ...GROWTH_TIER3, ...GROWTH_TIER4];

// 섹터 점수 반환 (0~14점) — 생태계 코드 우선 + 테마 오버라이드, KIS 업종 fallback
function sectorGrowthScore(sector, name = '', code = '') {
  // 1순위: 생태계 분류 + 테마 오버라이드 (코드 기반 — 가장 정확)
  if (code) {
    const primaryTier = ECO_TIER[code];
    const themeTier   = ECO_THEME[code];
    let tier;
    if (primaryTier !== undefined && themeTier !== undefined) {
      tier = Math.min(primaryTier, themeTier); // 번호 낮을수록 점수 높음 → 유리한 쪽 선택
    } else {
      tier = themeTier ?? primaryTier;
    }
    if (tier !== undefined) return ECO_TIER_SCORES[tier] ?? 3;
  }
  // 2순위: KIS 업종명 키워드 (미분류 종목 fallback)
  const s = sector || "";
  if (GROWTH_TIER1.some(k => s.includes(k))) return 8;
  if (GROWTH_TIER2.some(k => s.includes(k))) return 7;
  if (GROWTH_TIER3.some(k => s.includes(k))) return 6;
  if (GROWTH_TIER4.some(k => s.includes(k))) return 4;
  return 2; // 미분류 기본값
}

function calcGrowthBonus(sector, d5FrgnInst, name = '', code = '') {
  const secScore = sectorGrowthScore(sector, name, code);
  const buyScore = (typeof d5FrgnInst === 'number' && d5FrgnInst > 0) ? 4 : 0;
  return { total: Math.min(14, secScore + buyScore), secScore, buyScore };
}

function getStockTag(pbr, per, sector, name = '', code = '') {
  // 본업 티어와 테마 티어 중 낮은 번호(높은 점수) 선택
  const effectiveTier = code
    ? Math.min(ECO_TIER[code] ?? 99, ECO_THEME[code] ?? 99)
    : 99;
  const isGrowthSector = GROWTH_SECTOR_KW.some(k => (sector || "").includes(k))
    || effectiveTier <= 3;
  if (per > 40 || (isGrowthSector && per > 15)) return 'growth';
  if (pbr > 0 && pbr < 1.2 && per > 0 && per < 18) return 'value';
  return 'neutral';
}

// ─── 공시 모멘텀 (-2 ~ +2점) ───────────────────────────────────────────────
const DISC_GOOD_KW = ['수주', '계약체결', '흑자전환', '증가', '승인', '완료', '특허', '임상성공', '수상'];
const DISC_BAD_KW  = ['손실', '적자', '감소', '소송', '횡령', '조사', '회수', '불성실공시', '영업정지'];

function calcDisclosureBonus(disclosures) {
  if (!Array.isArray(disclosures) || disclosures.length === 0) return 0;
  let pts = 0;
  for (const d of disclosures) {
    const nm = d.reportName || '';
    if (DISC_GOOD_KW.some(k => nm.includes(k))) pts += 1;
    if (DISC_BAD_KW.some(k => nm.includes(k)))  pts -= 1;
  }
  return Math.max(-2, Math.min(2, pts));
}

function calcEpsAcceleration(epsHistory) {
  if (!epsHistory || epsHistory.length < 2) return 0;
  const valid = epsHistory.filter(v => typeof v === 'number' && v !== null);
  if (valid.length < 2) return 0;
  const latest = valid[valid.length - 1];
  const prev   = valid[valid.length - 2];
  if (prev === 0) return 0;
  const growth = (latest - prev) / Math.abs(prev) * 100;
  let score = growth >= 50 ? 10 : growth >= 20 ? 7 : growth >= 0 ? 4 : 0;
  if (valid.length >= 3 && score > 0) {
    const prevPrev = valid[valid.length - 3];
    if (prevPrev !== 0 && prevPrev !== null) {
      const prevGrowth = (prev - prevPrev) / Math.abs(prevPrev) * 100;
      if (growth > prevGrowth) score = Math.min(12, score + 2);
    }
  }
  return score;
}

function calcFamaFrench(closes, pbr, operatingMargin, kospiDailyReturns) {
  let beta = null, alpha = null, mktScore = 0;
  if (closes && closes.length >= 22 && Array.isArray(kospiDailyReturns) && kospiDailyReturns.length >= 20) {
    const stockLogR = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > 0 && closes[i-1] > 0) stockLogR.push(Math.log(closes[i] / closes[i-1]));
    }
    const N = Math.min(60, stockLogR.length, kospiDailyReturns.length);
    if (N >= 20) {
      const sR = stockLogR.slice(-N), mR = kospiDailyReturns.slice(-N);
      const ms = sR.reduce((a,b)=>a+b,0)/N, mm = mR.reduce((a,b)=>a+b,0)/N;
      let cov = 0, varM = 0;
      for (let i = 0; i < N; i++) { cov += (sR[i]-ms)*(mR[i]-mm); varM += (mR[i]-mm)**2; }
      if (varM > 0) { beta = Math.round(cov/varM*100)/100; alpha = Math.round((ms-beta*mm)*252*100)/100; }
    }
  }
  if (beta !== null && alpha !== null) {
    if      (alpha > 0 && beta >= 0.8 && beta <= 1.2) mktScore = 4;
    else if (alpha > 0 && (beta >= 0.5 || beta > 1.2)) mktScore = 2;
  }
  const hmlScore = pbr > 0 ? (pbr <= 0.8 ? 3 : pbr <= 1.5 ? 2 : pbr <= 2.5 ? 1 : 0) : 0;
  const rmwScore = operatingMargin != null ? (operatingMargin >= 20 ? 3 : operatingMargin >= 10 ? 2 : operatingMargin >= 5 ? 1 : 0) : 0;
  return { total: Math.min(10, mktScore + hmlScore + rmwScore), beta, alpha, mktScore, hmlScore, rmwScore };
}

function calcKoreanScore(pbr, per, rsiLatest, closes, sector, d5FrgnInst, disclosures = [], stockName = '', stockCode = '', dartFin = null, forwardPer = null, d20FrgnInst = null, divYield = 0, mktCap = 0, frgnRatio = 0, d5Personal = null, epsAccelScore = 0, ffScore = 0) {
  const n   = closes.length - 1;
  const cur = closes[n];

  // PBR 구간 이산 (0~8pt)
  const pbrScore = pbr <= 0 ? 0
                 : pbr <= 0.5 ? 8
                 : pbr <= 0.8 ? 6
                 : pbr <= 1.0 ? 4
                 : pbr <= 1.2 ? 2
                 : pbr <= 1.5 ? 1
                 : 0;

  // 섹터점수 (0~8pt) + forwardPER 구간 이산 (0~10pt)
  const secScore        = sectorGrowthScore(sector, stockName, stockCode);
  const fwdPer          = forwardPer ?? per;
  const forwardPERScore = fwdPer <= 0  ? 0
                        : fwdPer <= 8  ? 10
                        : fwdPer <= 12 ? 8
                        : fwdPer <= 15 ? 6
                        : fwdPer <= 20 ? 4
                        : fwdPer <= 25 ? 2
                        : 0;
  const perFinal        = secScore + forwardPERScore;

  // 외인기관 수급 (0~8pt): 5일 + 20일 분리
  const supplyD5  = (typeof d5FrgnInst  === 'number' && d5FrgnInst  > 0) ? 4 : 0;
  const supplyD20 = (typeof d20FrgnInst === 'number' && d20FrgnInst > 0) ? 4 : 0;
  const supplyScore = supplyD5 + supplyD20;

  // 공시 모멘텀 (±2pt)
  const discScore = calcDisclosureBonus(disclosures);

  // DART 재무 보너스 — max 10pt (분기 1회)
  // EPS성장(4) + ROE(3) + 영업마진(2) + 매출성장(1) = 10pt, 부채비율 감점
  let roScore = 0, epsGScore = 0, opMarginScore = 0, revGScore = 0, debtPenalty = 0;
  if (dartFin) {
    if (dartFin.roe !== null) {
      if      (dartFin.roe >= 25) roScore = 3;
      else if (dartFin.roe >= 17) roScore = 2;
      else if (dartFin.roe >= 10) roScore = 1;
    }
    if (dartFin.epsGrowth !== null) {
      if      (dartFin.epsGrowth >= 50) epsGScore = 4;
      else if (dartFin.epsGrowth >= 25) epsGScore = 3;
      else if (dartFin.epsGrowth >= 10) epsGScore = 1;
    }
    if (dartFin.operatingMargin !== null) {
      if      (dartFin.operatingMargin >= 20) opMarginScore = 2;
      else if (dartFin.operatingMargin >= 10) opMarginScore = 1;
    }
    if (dartFin.revenueGrowth !== null) {
      if (dartFin.revenueGrowth >= 10) revGScore = 1;
    }
    if (dartFin.debtRatio !== null) {
      if      (dartFin.debtRatio >= 300) debtPenalty = -3;
      else if (dartFin.debtRatio >= 200) debtPenalty = -2;
      else if (dartFin.debtRatio >= 150) debtPenalty = -1;
    }
  }

  // 배당수익률 (0~4pt)
  const divScore = divYield >= 4 ? 4 : divYield >= 3 ? 3 : divYield >= 2 ? 2 : divYield >= 1 ? 1 : 0;

  // 시총 안정성 강화 (-8~0pt)
  const mktCapScore = mktCap > 0 && mktCap < 500  ? -8
                    : mktCap > 0 && mktCap < 1000 ? -4
                    : mktCap > 0 && mktCap < 2000 ? -2
                    : 0;

  // 개인집중 감점 — 외인기관 없고 개인만 사는 패턴 (작전주 핵심 신호)
  const personalScore = (typeof d5Personal === 'number' && d5Personal > 0
                        && (typeof d5FrgnInst !== 'number' || d5FrgnInst <= 0)) ? -4 : 0;

  // 외인 보유율 극저 감점
  const frgnLowScore = frgnRatio > 0 && frgnRatio < 1 ? -2 : 0;

  // 자본잠식 감점
  const insolvencyScore = pbr <= 0 ? -3 : 0;

  const total = Math.min(50, Math.round(
    pbrScore + perFinal + supplyScore + discScore +
    roScore + epsGScore + opMarginScore + revGScore + debtPenalty +
    epsAccelScore + ffScore + divScore + mktCapScore + personalScore + frgnLowScore + insolvencyScore
  ));
  return { total,
           pbrScore, secScore, forwardPERScore,
           perFinal:        secScore + forwardPERScore,
           supplyScore, supplyD5, supplyD20, discScore,
           roScore, epsGScore, opMarginScore, revGScore, debtPenalty,
           divScore, mktCapScore, personalScore, frgnLowScore, insolvencyScore };
}

function maSignal(price, ma) {
  if (!ma || !price) return 'neutral';
  const r = (price - ma) / ma * 100;
  if (r > 1)  return 'up';
  if (r < -1) return 'down';
  return 'neutral';
}

// ─── ATR 수축 점수 ────────────────────────────────────────────────────────────
function calcAtrContractionScore(closes) {
  if (!closes || closes.length < 40) return { score: 0, contractionRatio: null };
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i-1] > 0) changes.push(Math.abs(closes[i] - closes[i-1]) / closes[i-1]);
  }
  if (changes.length < 30) return { score: 0, contractionRatio: null };
  const recent = changes.slice(-14).reduce((s, v) => s + v, 0) / 14;
  const hist   = changes.slice(-60).reduce((s, v) => s + v, 0) / Math.min(60, changes.length);
  if (hist === 0) return { score: 0, contractionRatio: null };
  const ratio = recent / hist;
  const score = ratio <= 0.55 ? 5 : ratio <= 0.70 ? 3 : ratio <= 0.85 ? 1 : 0;
  return { score, contractionRatio: Math.round(ratio * 100) / 100 };
}

// ─── 52주 신고가 근접도 (CAN SLIM N) ─────────────────────────────────────────
function calc52WkHighScore(closes) {
  if (!closes || closes.length < 20) return { score: 0, pctFromHigh: null };
  const cur     = closes[closes.length - 1];
  const period  = Math.min(252, closes.length);
  const high52w = Math.max(...closes.slice(-period));
  const pct     = (cur - high52w) / high52w * 100;
  const score   = pct >= 0 ? 5 : pct >= -5 ? 3 : pct >= -10 ? 1 : 0;
  return { score, pctFromHigh: Math.round(pct * 10) / 10, high52w };
}

function calcNewsBoost(code, sector, name, newsBoost) {
  if (!newsBoost) return { score: 0 };
  const { boostCodes = [], boostSectors = [], penaltyCodes = [], penaltySectors = [] } = newsBoost;
  if (boostCodes.includes(code))   return { score: 3 };
  if (penaltyCodes.includes(code)) return { score: -3 };
  const haystack = ((sector || '') + ' ' + (name || '')).toLowerCase();
  if (boostSectors.some(kw => kw && haystack.includes(kw.toLowerCase())))  return { score: 2 };
  if (penaltySectors.some(kw => kw && haystack.includes(kw.toLowerCase()))) return { score: -2 };
  return { score: 0 };
}

function calcRelStrengthScore(closes, market, marketReturns) {
  const ret = (arr, back) =>
    arr && arr.length > back + 1
      ? (arr[arr.length-1] - arr[arr.length-1-back]) / arr[arr.length-1-back] * 100
      : null;

  const s1m  = ret(closes, 21);
  const s3m  = ret(closes, 63);
  const s6m  = ret(closes, 126);
  const s12m = ret(closes, 252);

  const isKosdaq = typeof market === 'string' && market.includes('KOSDAQ');
  const bench    = isKosdaq ? marketReturns?.kosdaq : marketReturns?.kospi;

  const periods = [
    { s: s1m,  b: bench?.['1m'],  w: 0.20 },
    { s: s3m,  b: bench?.['3m'],  w: 0.40 },
    { s: s6m,  b: bench?.['6m'],  w: 0.25 },
    { s: s12m, b: bench?.['12m'], w: 0.15 },
  ];

  let wSum = 0, wTotal = 0;
  for (const { s, b, w } of periods) {
    if (s != null && b != null) { wSum += (s - b) * w; wTotal += w; }
  }
  if (wTotal === 0) return { score: 0 };

  const excess = wSum / wTotal;
  const score  = excess >= 30 ? 5 : excess >= 20 ? 4 : excess >= 10 ? 3
               : excess >= 5  ? 2 : excess >= 0  ? 1 : 0;
  return { score, excessReturn: Math.round(excess * 10) / 10 };
}

function calcMacroScore(relResult, marketAdj, newsBoostResult) {
  const relScore  = relResult?.score ?? 0;                              // 0~5pt
  const mktScore  = Math.max(-3, Math.min(3, marketAdj ?? 0));          // ±3pt
  const newsScore = Math.max(-2, Math.min(2, newsBoostResult?.score ?? 0)); // ±2pt
  const total     = Math.max(-5, Math.min(10, relScore + mktScore + newsScore));
  return { total, relScore, mktScore, newsScore, excessReturn: relResult?.excessReturn ?? null };
}

function analyze(stock, closes, volumes, extra = {}) {
  if (closes.length < 22) return null;
  const n = closes.length - 1, cur = closes[n];
  if (!cur) return null;

  const ma5a  = calcMAArr(closes, 5);
  const ma20a = calcMAArr(closes, 20);
  const ma60a = calcMAArr(closes, Math.min(60, closes.length));

  const ma5  = ma5a[n]  || 0;
  const ma20 = ma20a[n] || 0;
  const ma60 = ma60a[n] || 0;

  const signals = [];

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

  const rsiArr2     = calcRSI(closes);
  const techResult  = calcScore(closes, volumes);
  const techScore   = techResult.total;
  const _d5  = extra.investorSupply?.d5;
  const _d20 = extra.investorSupply?.d20;
  const d5FrgnInst  = _d5  ? (_d5.foreign  || 0) + (_d5.inst  || 0) : null;
  const d20FrgnInst = _d20 ? (_d20.foreign || 0) + (_d20.inst || 0) : null;
  const d5Personal  = _d5  ? (_d5.personal || 0) : null;

  const finalPer  = extra.per ?? 0;
  const epsAccel  = calcEpsAcceleration(extra.dartFin?.epsHistory ?? null);
  const ff        = calcFamaFrench(closes, extra.pbr || 0, extra.dartFin?.operatingMargin ?? null, extra.kospiDailyReturns ?? null);
  const ks        = calcKoreanScore(
    extra.pbr || 0, finalPer, rsiArr2[n], closes, extra.sector || '',
    d5FrgnInst, [], stock.name || '', stock.code || '',
    extra.dartFin ?? null, extra.forwardPer ?? null,
    d20FrgnInst, extra.divYield ?? 0, extra.mktCap ?? 0,
    extra.frgnRatio ?? 0, d5Personal, epsAccel, ff.total
  );
  const korScore        = ks.total;
  const marketAdj       = extra.marketAdj ?? 0;
  const relResult       = calcRelStrengthScore(closes, stock.market || '', extra.marketReturns ?? null);
  const newsBoostResult = calcNewsBoost(stock.code || '', extra.sector || '', stock.name || '', extra.newsBoost ?? null);
  const macroResult     = calcMacroScore(relResult, marketAdj, newsBoostResult);
  // 기술(65) + 국장특화(25) + 매크로(10) = 100점
  const score = Math.min(100, Math.round(techScore * 0.65) + Math.round(korScore * 0.5) + macroResult.total);

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
    rsi:         rsiArr2[n] != null ? Math.round(rsiArr2[n] * 10) / 10 : null,
    signals:     signals.slice(0, 2),
    volume:      extra.volume      || 0,
    avgVol5:     extra.avgVol5     || 0,
    frgnRatio:   extra.frgnRatio   || 0,
    frgnBuyQty:  extra.frgnBuyQty  || 0,
    mktCap:      extra.mktCap      || 0,
    per:         finalPer,
    pbr:         extra.pbr         || 0,
    eps:         extra.eps         || 0,
    stockTag:    getStockTag(extra.pbr || 0, finalPer, extra.sector || '', stock.name || '', stock.code || ''),
  };
}

// ─── Yahoo Finance forward PER 배치 조회 ──────────────────────────────────

async function fetchAllForwardPERs(stocks) {
  const YAHOO_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const BATCH    = 50;
  const peMap    = {};

  for (let i = 0; i < stocks.length; i += BATCH) {
    const batch   = stocks.slice(i, i + BATCH);
    const symbols = batch.map(s => `${s.code}.${s.market === 'KOSPI' ? 'KS' : 'KQ'}`).join(',');
    try {
      const url  = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=forwardPE`;
      const data = await timedFetch(url, { headers: YAHOO_UA }).then(r => r.json());
      for (const q of data?.quoteResponse?.result ?? []) {
        const code = (q.symbol || '').replace(/\.(KS|KQ)$/, '');
        if (code && q.forwardPE != null) peMap[code] = q.forwardPE;
      }
    } catch (e) {
      console.warn(`[forwardPE] ${i}~${i + BATCH} 배치 실패:`, e.message);
    }
    if (i + BATCH < stocks.length) await sleep(300);
  }
  console.log(`      forwardPE 조회: ${Object.keys(peMap).length}개 종목`);
  return peMap;
}

// ─── 단일 종목 처리 ────────────────────────────────────────────────────────

async function processStock(token, stock, marketAdj = 0, marketReturns = null, newsBoost = null, dartFinancialsMap = null, forwardPERMap = null, kospiDailyReturns = null) {
  const markets = stock.market ? [stock.market === 'KOSPI' ? 'J' : 'Q'] : ['J', 'Q'];

  for (const mkCode of markets) {
    try {
      const raw = await fetchDailyCandles(_currentToken, stock.code, mkCode);
      const rawOutput = raw?.output2 ?? raw?.output;
      if (!rawOutput?.length) continue;

      const recent      = rawOutput.filter(d => parseNum(d.stck_clpr) > 0).slice(0, 270);
      const latestDay   = recent[0];
      const reversed    = recent.slice().reverse();
      const closes      = reversed.map(d => parseNum(d.stck_clpr));
      const volumes     = reversed.map(d => parseNum(d.acml_vol));

      if (closes.length < 22) continue;
      if (!closes[closes.length - 1]) continue;

      const volume     = parseNum(latestDay?.acml_vol);
      const frgnRatio  = parseF(latestDay?.hts_frgn_ehrt);
      const frgnBuyQty = parseNum(latestDay?.frgn_ntby_qty);
      const vLast  = volumes.length - 1;
      const avgVol5 = Math.round(
        volumes.slice(Math.max(0, vLast - 4), vLast + 1).reduce((a, b) => a + b, 0) /
        Math.min(5, vLast + 1)
      );

      let investorSupply = null;
      try {
        let invRaw = await timedFetch(
          `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor` +
          `?fid_cond_mrkt_div_code=${mkCode}&fid_input_iscd=${stock.code}`,
          { headers: kisHeaders(_currentToken, 'FHKST01010900') }
        ).then(r => r.json()).catch(() => null);

        if (await refreshTokenIfExpired(invRaw)) {
          invRaw = await timedFetch(
            `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor` +
            `?fid_cond_mrkt_div_code=${mkCode}&fid_input_iscd=${stock.code}`,
            { headers: kisHeaders(_currentToken, 'FHKST01010900') }
          ).then(r => r.json()).catch(() => null);
        }

        const rows = Array.isArray(invRaw?.output) ? invRaw.output : [];
        if (rows.length >= 1) {  // 1개 이상이면 있는 데이터로 집계 (KOSDAQ 소형주 포함)
          const sumN   = (arr, f) => arr.reduce((s, d) => s + parseNum(d[f] || '0'), 0);
          const fmtBsop = d => { const dt = d?.stck_bsop_date; return dt ? `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}` : ''; };
          const rows5  = rows.slice(0, Math.min(5, rows.length));
          const rows20 = rows.slice(0, Math.min(20, rows.length));
          investorSupply = {
            d5:  { foreign: sumN(rows5,'frgn_ntby_qty'),  inst: sumN(rows5,'orgn_ntby_qty'),  personal: sumN(rows5,'prsn_ntby_qty'),  days: rows5.length,  from: fmtBsop(rows5[rows5.length-1]),  to: fmtBsop(rows5[0]) },
            d20: { foreign: sumN(rows20,'frgn_ntby_qty'), inst: sumN(rows20,'orgn_ntby_qty'), personal: sumN(rows20,'prsn_ntby_qty'), days: rows20.length, from: fmtBsop(rows20[rows20.length-1]), to: fmtBsop(rows20[0]) },
          };
        }
      } catch (_) {}

      let mktCap = 0, per = 0, pbr = 0, eps = 0, sector = '', divYield = 0;
      try {
        const info = await fetchStockInfo(_currentToken, stock.code, mkCode);
        const o = info?.output;
        if (o) {
          mktCap   = parseNum(o.hts_avls);
          per      = parseF(o.per       || '0');
          pbr      = parseF(o.pbr       || '0');
          eps      = parseF(o.eps       || '0');
          divYield = parseF(o.dvdn_yedn || '0');
          sector   = (o.bstp_kor_isnm || o.bstp_kor_isn_nm || '').trim();
          // hts_avls 가 0이면 상장주수 × 현재가로 보정 (KOSDAQ 소형주 누락 방지)
          if (!mktCap && o.lstn_stcn && o.stck_prpr) {
            const shares = parseNum(o.lstn_stcn);
            const price  = parseNum(o.stck_prpr);
            if (shares > 0 && price > 0) mktCap = Math.round(shares * price / 1e8); // 억원
          }
        }
      } catch (_) {}

      const market = mkCode === 'J' ? 'KOSPI' : 'KOSDAQ';
      const result = analyze(
        { ...stock, market },
        closes,
        volumes,
        { volume, frgnRatio, frgnBuyQty, avgVol5, mktCap, per, pbr, eps, sector, divYield, investorSupply, marketAdj, marketReturns, newsBoost, dartFin: dartFinancialsMap?.[stock.code] ?? null, forwardPer: forwardPERMap?.[stock.code] ?? null, kospiDailyReturns }
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

  // 2.3 KOSPI·KOSDAQ 수익률 조회 (시장대비 초과수익률 벤치마크)
  console.log('[2.3/4] KOSPI·KOSDAQ 수익률 조회...');
  const { periodReturns: marketReturns, kospiDailyReturns } = await fetchMarketReturns(); // 실패 시 throw → Actions 실패
  await redisSet('market_returns', { ...marketReturns, updatedAt: new Date().toISOString() }, 48 * 3600);
  if (kospiDailyReturns) {
    await redisSet('market_daily_returns', { kospi: kospiDailyReturns, updatedAt: new Date().toISOString() }, 48 * 3600);
    console.log(`      market_daily_returns 저장 완료 (${kospiDailyReturns.length}개)`);
  }
  console.log('      market_returns 저장 완료');

  // 2.5 시장환경 점수 (역발상: 공포=가점, 과열=감점)
  let marketAdj = 0;
  try {
    const mv4Raw = await redisGet('market_v4');
    const mv4 = mv4Raw ? JSON.parse(mv4Raw) : null;
    const mv4Score = mv4?.sentiment?.score ?? null;
    if (mv4Score !== null) {
      if      (mv4Score <= 20) marketAdj = 5;
      else if (mv4Score <= 30) marketAdj = 3;
      else if (mv4Score <= 40) marketAdj = 1;
      else if (mv4Score >= 80) marketAdj = -3;
      else if (mv4Score >= 70) marketAdj = -2;
      const adjSign = marketAdj > 0 ? '+' : '';
      console.log(`      market_v4 점수: ${mv4Score}점 → 전종목 보정 ${adjSign}${marketAdj}점`);
    } else {
      console.log('      market_v4 없음 → 보정 0점');
    }
  } catch (e) {
    console.log('      시장환경 조회 실패 (무시):', e.message);
  }

  // 2.7 DART 재무지표 (update-dart-eps.js 가 분기 1회 저장)
  let dartFinancialsMap = null;
  try {
    const dfRaw = await redisGet('dart_financials');
    if (dfRaw) {
      dartFinancialsMap = JSON.parse(dfRaw);
      console.log(`      dart_financials: ${Object.keys(dartFinancialsMap).length}개 종목 로드`);
    } else {
      console.log('      dart_financials 없음 — ROE/EPS성장률 미반영');
    }
  } catch (e) {
    console.log('      dart_financials 조회 실패 (무시):', e.message);
  }

  // 2.7.5 Yahoo Finance forward PER 배치 조회
  console.log('[2.75/4] Yahoo Finance forward PER 조회...');
  const forwardPERMap = await fetchAllForwardPERs(allStocks).catch(e => {
    console.warn('      forward PER 조회 실패 (무시):', e.message);
    return {};
  });

  // 2.8 뉴스 가점/감점 데이터 (generate_newsletter.py 가 저장)
  let newsBoost = null;
  try {
    const nbRaw = await redisGet('news_boost');
    if (nbRaw) {
      newsBoost = JSON.parse(nbRaw);
      console.log(`      news_boost: BOOST 종목 ${newsBoost.boostCodes?.length ?? 0}개 섹터 ${newsBoost.boostSectors?.length ?? 0}개 / PENALTY 종목 ${newsBoost.penaltyCodes?.length ?? 0}개 섹터 ${newsBoost.penaltySectors?.length ?? 0}개`);
    } else {
      console.log('      news_boost 없음 (오늘 브리핑 미생성)');
    }
  } catch (e) {
    console.log('      news_boost 조회 실패 (무시):', e.message);
  }

  // 3. 배치 처리 (일봉 + 기본정보 + 수급)
  console.log(`[3/4] 일봉 + 기본정보 조회... (${allStocks.length}개, 배치 ${BATCH_SIZE}개)`);
  const results = [];
  let processed = 0, failed = 0;

  for (let i = 0; i < allStocks.length; i += BATCH_SIZE) {
    const batch    = allStocks.slice(i, i + BATCH_SIZE);
    const batchRes = await Promise.all(batch.map(s => processStock(token, s, marketAdj, marketReturns, newsBoost, dartFinancialsMap, forwardPERMap, kospiDailyReturns)));
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

  await redisSet('recommend_v2', payload, 28 * 3600);

  const invMap = {};
  results.forEach(s => { if (s.investorSupply) invMap[s.code] = s.investorSupply; });
  await redisSet('investor_supply', invMap, 28 * 3600);

  const scoreMap = {};
  results.forEach(s => { scoreMap[s.code] = s.score; });
  await redisSet('stock_scores', scoreMap, 28 * 3600);

  console.log(`      완료: ${results.length}개 종목 저장`);
  console.log(`      수급 맵 ${Object.keys(invMap).length}개, 점수 맵 ${Object.keys(scoreMap).length}개`);
  console.log(`      기준일 ${baseDate}`);
  console.log('\n=== 완료 ===\n');
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
