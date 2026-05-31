/**
 * 시장 지수 API — 마켓스코어 v4
 *
 * [스코어 구성 (0~100점, 50=중립)]
 *   ① 지수 위치  (코스피·코스닥)  20%
 *   ② 외인·기관 수급              20%
 *   ③ 거래대금                    15%
 *   ④ 나스닥 전일 등락            15%
 *   ⑤ 환율 안정도                 10%
 *   ⑥ VIX 공포지수               10%
 *   ⑦ AI 뉴스 sentiment          10%  (현재 null → 나머지 비율 재계산)
 *
 * [평활화]
 *   최종 = 당일 40% + 20일 이동평균 60%
 *   20일 미만: 보유 데이터로 계산
 *
 * [Redis 키]
 *   market_v4          : 30분 캐시
 *   market_history     : 일별 누적 (90일, TTL 100일)
 *   market_sentiment   : AI 뉴스 점수 (api/market-sentiment.js 가 저장)
 */

'use strict';

const CACHE_KEY   = 'market_v4';
const HIST_KEY    = 'market_history';
const SENTI_KEY   = 'market_sentiment';
const CACHE_TTL   = 1800;                 // 30분 캐시
const STALE_TTL   = CACHE_TTL + 3600;
const HIST_TTL    = 100 * 86400;          // 100일
const TIMEOUT_MS  = 8000;

// 지수 위치  20% / 수급  20% / 거래대금 15% / 나스닥 15% / 환율 10% / VIX 10% / 뉴스 10%
const WEIGHTS = { indexPos:0.20, supply:0.20, trading:0.15, nasdaq:0.15, usd:0.10, vix:0.10, news:0.10 };

// ─── 유틸 ────────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function timedFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(id); return r;
  } catch (e) { clearTimeout(id); throw e; }
}

// KST 날짜 (YYYY-MM-DD)
function kstDate() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

// ─── 파싱 함수 ────────────────────────────────────────────────────────────────

function parseNaver(d) {
  if (!d) return null;
  const price      = parseFloat(String(d.closePrice || d.currentPrice || '0').replace(/,/g,''));
  const chg        = parseFloat(String(d.compareToPreviousClosePrice || '0').replace(/,/g,''));
  const chgRate    = parseFloat(String(d.fluctuationsRatio || '0').replace(/,/g,''));
  // Naver 지수 API 필드명: totalTradeAmount / accumulatedTradingValue / tradeAmount 순 시도
  const tradeAmt   = parseFloat(String(
    d.tradingValue || d.totalTradeAmount || d.accumulatedTradingValue || d.tradeAmount || '0'
  ).replace(/,/g,''));
  if (!price) return null;
  return { price, change: chg, changeRate: chgRate, tradeAmount: tradeAmt || 0 };
}

function parseYahoo(json) {
  const r = json?.chart?.result?.[0];
  if (!r) return null;
  const m     = r.meta || {};
  const price = m.regularMarketPrice ?? m.previousClose;
  const prev  = m.previousClose ?? m.chartPreviousClose;
  if (!price) return null;
  const chg     = price - (prev || price);
  const chgRate = prev ? (chg / prev) * 100 : 0;
  return {
    price:      Math.round(price    * 100) / 100,
    change:     Math.round(chg      * 100) / 100,
    changeRate: Math.round(chgRate  * 100) / 100,
  };
}

// ─── Redis ────────────────────────────────────────────────────────────────────

async function redisPipeline(cmds, url, token) {
  await timedFetch(`${url}/pipeline`, {
    method:  'POST',
    headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:    JSON.stringify(cmds),
  });
}

async function redisGet(key, url, token) {
  try {
    const r = await timedFetch(`${url}/get/${key}`, {
      headers: { Authorization:`Bearer ${token}` },
    }).then(r => r.json());
    return r.result ? JSON.parse(r.result) : null;
  } catch { return null; }
}

// ─── supply: Redis 캐시 우선, 없으면 KIS 직접 호출 ──────────────────────────

async function fetchSupply(kvUrl, kvToken) {
  if (!kvUrl || !kvToken) return null;

  // 1. Redis 캐시 확인
  try {
    const raw = await timedFetch(`${kvUrl}/get/supply_cache`, {
      headers: { Authorization:`Bearer ${kvToken}` },
    }).then(r => r.json());
    if (raw.result) return JSON.parse(raw.result);
  } catch { /* fall through */ }

  // 2. KIS API 직접 호출 (캐시 없을 때)
  const kisKey    = process.env.KIS_APP_KEY;
  const kisSecret = process.env.KIS_APP_SECRET;
  if (!kisKey || !kisSecret) return null;

  try {
    // KIS 토큰: Redis에서 가져오거나 새로 발급
    const ktRaw = await timedFetch(`${kvUrl}/get/kis_token`, {
      headers: { Authorization:`Bearer ${kvToken}` },
    }).then(r => r.json()).catch(() => ({}));

    let kisToken = ktRaw.result || null;

    if (!kisToken) {
      const td = await timedFetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
        method:  'POST',
        headers: { 'Content-Type':'application/json; charset=utf-8' },
        body:    JSON.stringify({ grant_type:'client_credentials', appkey:kisKey, appsecret:kisSecret }),
      }).then(r => r.json());
      kisToken = td.access_token;
      if (kisToken) {
        await redisPipeline([['SET','kis_token', kisToken, 'EX','82800']], kvUrl, kvToken).catch(()=>{});
      }
    }
    if (!kisToken) return null;

    const data = await timedFetch(
      'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor' +
      '?fid_cond_mrkt_div_code=J&fid_input_iscd=0001',
      { headers: {
        Authorization: `Bearer ${kisToken}`,
        appkey:    kisKey,
        appsecret: kisSecret,
        tr_id:     'FHKST01010900',
        'Content-Type': 'application/json',
      }}
    ).then(r => r.json());

    const output     = data?.output;
    const foreignNet = parseInt(output?.frgn_ntby_qty || 0);
    const instNet    = parseInt(output?.orgn_ntby_qty  || 0);
    // 응답 자체가 실패한 게 아니라면 0/0도 유효한 데이터 (중립 50점)
    if (data?.rt_cd && data.rt_cd !== '0') return null;

    // KOSDAQ 수급도 병렬 조회 (보완용)
    let kdForeignNet = 0, kdInstNet = 0;
    try {
      const kdData = await timedFetch(
        'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor' +
        '?fid_cond_mrkt_div_code=Q&fid_input_iscd=1001',
        { headers: {
          Authorization: `Bearer ${kisToken}`,
          appkey: kisKey, appsecret: kisSecret,
          tr_id: 'FHKST01010900', 'Content-Type': 'application/json',
        }}
      ).then(r => r.json());
      if (kdData?.rt_cd === '0') {
        kdForeignNet = parseInt(kdData?.output?.frgn_ntby_qty || 0);
        kdInstNet    = parseInt(kdData?.output?.orgn_ntby_qty  || 0);
      }
    } catch { /* KOSDAQ 실패해도 KOSPI로 계속 */ }

    const supply = {
      foreignNet: foreignNet + kdForeignNet,
      instNet:    instNet    + kdInstNet,
    };
    await redisPipeline(
      [['SET','supply_cache', JSON.stringify(supply), 'EX','90000']],
      kvUrl, kvToken
    ).catch(()=>{});
    return supply;
  } catch { return null; }
}

// ─── 컴포넌트 점수 계산 (모두 0~100, 50=중립) ───────────────────────────────

function scoreIndexPos(kospiRate, kosdaqRate) {
  if (kospiRate == null && kosdaqRate == null) return null;
  const combined = (kospiRate||0) * 0.70 + (kosdaqRate||0) * 0.30;
  return clamp(50 + combined * 16.67, 0, 100); // ±3% → ±50pt
}

function scoreSupply(supply) {
  if (!supply) return null;
  const fNet = supply.foreignNet || 0;
  const iNet = supply.instNet    || 0;
  const comb = fNet + iNet;
  const fS   = Math.sign(fNet), iS = Math.sign(iNet);
  // -15 ~ +15 raw → 0~100
  let raw;
  if (fS > 0 && iS > 0)        raw =  15;
  else if (fS > 0 && iS < 0)   raw = comb > 0 ?  8 : -3;
  else if (fS < 0 && iS > 0)   raw = comb > 0 ?  3 : -8;
  else if (fS < 0 && iS < 0)   raw = -15;
  else                          raw =   0;
  return clamp((raw + 15) / 30 * 100, 0, 100);
}

function scoreTrading(kospiAmt, kosdaqAmt, kospiValues, kosdaqValues) {
  // 1순위: Naver 차트 기반 20일 MA 대비 비율 (KOSPI 60% + KOSDAQ 40%)
  const maScore = (values) => {
    if (!values || values.length < 6) return null;
    const today = values[values.length - 1];
    const past  = values.slice(-21, -1);   // 최근 20일 (오늘 제외)
    if (!past.length || !today) return null;
    const ma20 = past.reduce((a, b) => a + b, 0) / past.length;
    if (!ma20) return null;
    const ratio = today / ma20;
    // 120%↑ → ~90 / 100% → 50 / 80%↓ → ~10
    return clamp(50 + (ratio - 1) * 200, 0, 100);
  };
  const kpS = maScore(kospiValues);
  const kdS = maScore(kosdaqValues);
  if (kpS !== null || kdS !== null) {
    if (kpS !== null && kdS !== null) return Math.round(kpS * 0.6 + kdS * 0.4);
    return kpS ?? kdS;
  }
  // 2순위: Naver basic tradeAmount 기반 고정 기준
  const total = (kospiAmt||0) + (kosdaqAmt||0);
  if (total <= 0) return null;
  const REF = 12e12; // 12조원 기준
  return clamp(50 + (total - REF) / REF * 40, 5, 95);
}

function scoreNasdaq(nasdaqRate) {
  if (nasdaqRate == null) return null;
  return clamp(50 + nasdaqRate * 16.67, 0, 100); // ±3% → ±50pt
}

function scoreUsd(usdRate) {
  if (usdRate == null) return null;
  return clamp(50 - usdRate * 20, 0, 100);
  // USD +2%상승(원화 약세) → 10 / 0% → 50 / -2%하락 → 90
}

function scoreVix(vixPrice) {
  if (!vixPrice || vixPrice <= 0) return null;
  return clamp(150 - vixPrice * 5, 0, 100);
  // VIX 10 → 100 / VIX 20 → 50 / VIX 30 → 0
}

function scoreNews(newsScore) {
  if (newsScore == null) return null;
  return clamp(newsScore, 0, 100);
}

// ─── 가중 평균 (null 항목 제외 후 비율 재계산) ───────────────────────────────

function calcWeightedScore(scores) {
  let totalWeight = 0, weightedSum = 0;
  const detail = {};

  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const s = scores[key];
    detail[key] = { score: s ?? null, weight, contrib: null };
    if (s == null) continue;
    weightedSum  += s * weight;
    totalWeight  += weight;
  }
  if (totalWeight === 0) return { score: 50, detail };

  const normScore = weightedSum / totalWeight; // 0~100

  // 기여도 계산 (최종 점수 대비 각 항목이 얼마나 기여했는지)
  for (const [key] of Object.entries(WEIGHTS)) {
    if (detail[key].score == null) continue;
    const ew = detail[key].weight / totalWeight; // 실효 가중치
    detail[key].effectiveWeight = Math.round(ew * 100);
    detail[key].contrib = Math.round((detail[key].score - 50) * ew); // 중립(50) 대비 기여 점수
  }

  return { score: Math.round(normScore), detail };
}

// ─── MA20 계산 ────────────────────────────────────────────────────────────────

function calcMA20(history, todayDate) {
  // history는 최신순 정렬, 오늘 제외한 이전 항목들에서 MA 계산
  const prev = history.filter(h => h.date !== todayDate);
  if (prev.length === 0) return null;
  const n     = Math.min(20, prev.length);
  const slice = prev.slice(0, n);
  const avg   = slice.reduce((s, h) => s + (h.rawScore ?? h.score), 0) / n;
  return { ma: Math.round(avg), n };
}

// ─── 히스토리 저장 ────────────────────────────────────────────────────────────

async function saveHistory(entry, history, url, token) {
  const today = entry.date;
  const idx   = history.findIndex(h => h.date === today);

  if (idx === 0) {
    history[0] = entry;        // 오늘 항목 갱신
  } else if (idx > 0) {
    history.splice(idx, 1);    // 중간에 있으면 제거 후 앞에 추가
    history.unshift(entry);
  } else {
    history.unshift(entry);    // 새 항목 추가
  }

  const trimmed = history.slice(0, 90); // 최대 90일 보관

  await redisPipeline(
    [['SET', HIST_KEY, JSON.stringify(trimmed), 'EX', String(HIST_TTL)]],
    url, token
  ).catch(() => {});

  return trimmed;
}

// ─── ADX(14) 계산 ────────────────────────────────────────────────────────────
// candles: [{high, low, close}, ...] 오래된 순 정렬, 최소 30개 권장
function calcADX14(candles) {
  const N = 14;
  if (!candles || candles.length < N + 2) return null;

  const trArr = [], dmPArr = [], dmMArr = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, c = candles[i].close;
    const ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    trArr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    dmPArr.push(h - ph > pl - l && h - ph > 0 ? h - ph : 0);
    dmMArr.push(pl - l > h - ph && pl - l > 0 ? pl - l : 0);
  }

  // Wilder 스무딩
  const smooth = (arr, n) => {
    let s = arr.slice(0, n).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = n; i < arr.length; i++) { s = s - s / n + arr[i]; out.push(s); }
    return out;
  };

  const sTR = smooth(trArr, N), sDMP = smooth(dmPArr, N), sDMM = smooth(dmMArr, N);
  const diP = sTR.map((tr, i) => tr > 0 ? sDMP[i] / tr * 100 : 0);
  const diM = sTR.map((tr, i) => tr > 0 ? sDMM[i] / tr * 100 : 0);
  const dx  = diP.map((p, i) => {
    const sum = p + diM[i];
    return sum > 0 ? Math.abs(p - diM[i]) / sum * 100 : 0;
  });

  // ADX = DX의 Wilder 스무딩
  let adx = dx.slice(0, N).reduce((a, b) => a + b, 0) / N;
  for (let i = N; i < dx.length; i++) adx = (adx * (N - 1) + dx[i]) / N;

  const lastIdx = diP.length - 1;
  return {
    adx:     Math.round(adx * 10) / 10,
    diPlus:  Math.round(diP[lastIdx] * 10) / 10,
    diMinus: Math.round(diM[lastIdx] * 10) / 10,
    upTrend: diP[lastIdx] > diM[lastIdx],
  };
}

// ADX 점수 (0~5pt)
function scoreADX(adxResult) {
  if (!adxResult) return 0;
  const { adx, upTrend } = adxResult;
  if (!upTrend) return 0;                      // 하락 추세
  if (adx < 25)  return 1;                     // 추세 없음
  if (adx < 40)  return 3;                     // 약한 상승 추세
  if (adx < 60)  return 4;                     // 강한 상승 추세
  return 5;                                    // 극강 상승 (STRONG_BULL)
}

// Yahoo Finance 캔들 파싱
function parseYahooCandles(json) {
  const r = json?.chart?.result?.[0];
  if (!r) return null;
  const ts    = r.timestamp    || [];
  const q     = r.indicators?.quote?.[0] || {};
  const highs  = q.high  || [];
  const lows   = q.low   || [];
  const closes = q.close || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    if (highs[i] == null || lows[i] == null || closes[i] == null) continue;
    candles.push({ high: highs[i], low: lows[i], close: closes[i] });
  }
  return candles.length >= 16 ? candles : null;
}

// Naver 지수 차트 캔들 파싱 (일봉)
function parseNaverCandles(json) {
  const items = json?.chartinfos || json?.priceinfos || null;
  if (!Array.isArray(items)) return null;
  const candles = items
    .filter(d => d.closePrice && d.highPrice && d.lowPrice)
    .map(d => ({
      high:  parseFloat(String(d.highPrice).replace(/,/g,'')),
      low:   parseFloat(String(d.lowPrice).replace(/,/g,'')),
      close: parseFloat(String(d.closePrice).replace(/,/g,'')),
    }))
    .filter(d => d.high > 0);
  return candles.length >= 16 ? candles : null;
}

// Naver 지수 차트 거래대금 파싱 (일봉, 단위: 원)
function parseNaverTradingValues(json) {
  const items = json?.chartinfos || json?.priceinfos || null;
  if (!Array.isArray(items)) return null;
  const values = items
    .map(d => parseFloat(String(
      d.accumulatedTradingValue || d.tradingValue || d.tradeAmount || '0'
    ).replace(/,/g,'')) || 0)
    .filter(v => v > 0);
  return values.length >= 5 ? values : null;
}

// ─── 레이블 ──────────────────────────────────────────────────────────────────

function scoreLabel(score) {
  if (score >= 75) return { label:'🚀 과열',    color:'#16a34a', bg:'rgba(22,163,74,.12)'  };
  if (score >= 56) return { label:'😊 활황',    color:'#22c55e', bg:'rgba(34,197,94,.12)'  };
  if (score >= 45) return { label:'😐 중립',    color:'#6b7280', bg:'rgba(107,114,128,.12)' };
  if (score >= 25) return { label:'😟 침체',    color:'#f97316', bg:'rgba(249,115,22,.12)' };
  return               { label:'😱 극도 침체', color:'#dc2626', bg:'rgba(220,38,38,.12)'  };
}

// ─── 핸들러 ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const NAVER_UA = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    Referer: 'https://m.stock.naver.com',
  };

  /* ── 1) 30분 캐시 조회 ──────────────────────────────────────────── */
  if (kvUrl && kvToken) {
    try {
      const cached = await redisGet(CACHE_KEY, kvUrl, kvToken);
      if (cached && Date.now() - (cached.ts || 0) < CACHE_TTL * 1000) {
        return res.status(200).json({ success:true, ...cached, source:'cache' });
      }
    } catch (_) {}
  }

  /* ── 2) 데이터 병렬 조회 ────────────────────────────────────────── */
  const [kospiRaw, kosdaqRaw, usdRaw, nasdaqRaw, vixRaw,
         kospiChartRaw, kosdaqChartRaw, nasdaqChartRaw,
         supply, sentimentData, history] =
    await Promise.all([
      timedFetch('https://m.stock.naver.com/api/index/KOSPI/basic',  {headers:NAVER_UA}).then(r=>r.json()).catch(()=>null),
      timedFetch('https://m.stock.naver.com/api/index/KOSDAQ/basic', {headers:NAVER_UA}).then(r=>r.json()).catch(()=>null),
      timedFetch('https://query1.finance.yahoo.com/v8/finance/chart/USDKRW%3DX?interval=1d&range=5d').then(r=>r.json()).catch(()=>null),
      timedFetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC?interval=1d&range=5d').then(r=>r.json()).catch(()=>null),
      timedFetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d').then(r=>r.json()).catch(()=>null),
      // ADX 계산용 과거 40일 데이터
      timedFetch('https://m.stock.naver.com/api/index/KOSPI/chart?timeframe=day&count=40',  {headers:NAVER_UA}).then(r=>r.json()).catch(()=>null),
      timedFetch('https://m.stock.naver.com/api/index/KOSDAQ/chart?timeframe=day&count=40', {headers:NAVER_UA}).then(r=>r.json()).catch(()=>null),
      timedFetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC?interval=1d&range=3mo').then(r=>r.json()).catch(()=>null),
      fetchSupply(kvUrl, kvToken),
      kvUrl && kvToken ? redisGet(SENTI_KEY, kvUrl, kvToken) : null,
      kvUrl && kvToken ? redisGet(HIST_KEY,  kvUrl, kvToken).then(d => d || []) : [],
    ]);

  const kospi  = parseNaver(kospiRaw);
  const kosdaq = parseNaver(kosdaqRaw);
  const usdkrw = parseYahoo(usdRaw);
  const nasdaq = parseYahoo(nasdaqRaw);
  const vixData = parseYahoo(vixRaw);

  // ADX 계산
  const kospiCandles      = parseNaverCandles(kospiChartRaw);
  const kosdaqCandles     = parseNaverCandles(kosdaqChartRaw);
  const kospiTradingVals  = parseNaverTradingValues(kospiChartRaw);
  const kosdaqTradingVals = parseNaverTradingValues(kosdaqChartRaw);
  const nasdaqCandles = parseYahooCandles(nasdaqChartRaw);
  const adxKospi  = calcADX14(kospiCandles);
  const adxKosdaq = calcADX14(kosdaqCandles);
  const adxNasdaq = calcADX14(nasdaqCandles);

  // 국장 ADX 점수: KOSPI 60% + KOSDAQ 40% 가중 평균
  const adxKrScore = (() => {
    const kp = adxKospi  ? scoreADX(adxKospi)  : null;
    const kd = adxKosdaq ? scoreADX(adxKosdaq) : null;
    if (kp === null && kd === null) return null;
    if (kp === null) return kd;
    if (kd === null) return kp;
    return Math.round(kp * 0.6 + kd * 0.4);
  })();
  const adxUsScore = adxNasdaq ? scoreADX(adxNasdaq) : null;

  // 최종 ADX 점수: 국장 70% + 나스닥 30%
  const adxScore = (() => {
    if (adxKrScore === null && adxUsScore === null) return null;
    if (adxKrScore === null) return adxUsScore;
    if (adxUsScore === null) return adxKrScore;
    return Math.round(adxKrScore * 0.7 + adxUsScore * 0.3);
  })();

  if (!kospi && !kosdaq) {
    return res.status(200).json({ success:false, error:'시장 데이터를 가져올 수 없습니다.' });
  }

  /* ── 3) 컴포넌트 점수 계산 ──────────────────────────────────────── */
  const rawScores = {
    indexPos: scoreIndexPos(kospi?.changeRate,  kosdaq?.changeRate),
    supply:   scoreSupply(supply),
    trading:  scoreTrading(kospi?.tradeAmount, kosdaq?.tradeAmount, kospiTradingVals, kosdaqTradingVals),
    nasdaq:   scoreNasdaq(nasdaq?.changeRate),
    usd:      scoreUsd(usdkrw?.changeRate),
    vix:      scoreVix(vixData?.price),
    news:     scoreNews(sentimentData?.score ?? null),
  };

  const { score: todayRaw, detail } = calcWeightedScore(rawScores);

  /* ── 4) MA20 + 최종 점수 ─────────────────────────────────────────── */
  const today   = kstDate();
  const ma20res = calcMA20(history, today);
  let finalScore;

  if (!ma20res) {
    finalScore = todayRaw;                                    // 데이터 없으면 당일만
  } else {
    finalScore = Math.round(0.40 * todayRaw + 0.60 * ma20res.ma);
  }
  finalScore = clamp(finalScore, 0, 100);

  /* ── 5) 히스토리 저장 ───────────────────────────────────────────── */
  const histEntry = {
    date:     today,
    rawScore: todayRaw,
    score:    finalScore,
    ts:       Date.now(),
    components: Object.fromEntries(
      Object.entries(detail).map(([k, v]) => [k, v.score])
    ),
  };
  if (kvUrl && kvToken) {
    await saveHistory(histEntry, history, kvUrl, kvToken);
  }

  /* ── 6) 응답 구성 ───────────────────────────────────────────────── */
  const { label, color, bg } = scoreLabel(finalScore);
  const sentiment = {
    label, color, bg,
    score:     finalScore,
    rawScore:  todayRaw,
    ma20:      ma20res?.ma   ?? null,
    maLen:     ma20res?.n    ?? 0,
    components: detail,
    // 레거시 호환 (기존 프론트엔드가 쓰는 필드)
    detail: {
      kospiScore:  Math.round((kospi?.changeRate||0)*(20/3)*10)/10,
      kosdaqScore: Math.round((kosdaq?.changeRate||0)*(10/3)*10)/10,
      usdScore:    Math.round(-(usdkrw?.changeRate||0)*5*10)/10,
      supplyScore: rawScores.supply != null ? Math.round((rawScores.supply-50)/100*30) : 0,
      hasSupply:   !!supply,
    },
  };

  const payload = {
    kospi, kosdaq, usdkrw, nasdaq,
    vix: vixData ? { price: vixData.price } : null,
    sentiment,
    adx: {
      score:   adxScore,
      kospi:   adxKospi,
      kosdaq:  adxKosdaq,
      nasdaq:  adxNasdaq,
      krScore: adxKrScore,
      usScore: adxUsScore,
    },
    ts:        Date.now(),
    updatedAt: new Date().toISOString(),
  };

  /* ── 7) 캐시 저장 ───────────────────────────────────────────────── */
  if (kvUrl && kvToken) {
    await redisPipeline(
      [['SET', CACHE_KEY, JSON.stringify(payload), 'EX', String(STALE_TTL)]],
      kvUrl, kvToken
    ).catch(() => {});
  }

  return res.status(200).json({ success:true, ...payload, source:'fresh' });
}
