/**
 * 시장 지수 API — 코스피 · 코스닥 · 달러/원 + 시장 심리
 * - 코스피/코스닥: Naver Finance API
 * - 달러/원:      Yahoo Finance
 * - 외인+기관 수급: supply_cache (Redis, supply.js 가 30초 주기 업데이트)
 * - Redis 30분 캐시
 *
 * 마켓스코어 계산 (0~100점 연속값):
 *   기준점 50
 *   + 코스피 등락률  (−20 ~ +20)  : 코스피% × (20/3), ±3% 이상에서 cap
 *   + 코스닥 등락률  (−10 ~ +10)  : 코스닥% × (10/3), ±3% 이상에서 cap
 *   + 달러/원 방향   (−5  ~ +5 )  : −(USD등락률%) × 5 — 원화 강세 = 긍정
 *   + 외인+기관 수급 (−15 ~ +15)  : supply_cache 기반 수급 방향
 */

const CACHE_KEY = 'market_v3';
const CACHE_TTL = 1800;               // 30분
const STALE_TTL = CACHE_TTL + 3600;  // Redis 만료

const TIMEOUT_MS = 6000;

async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) { clearTimeout(id); throw e; }
}

/* ── Naver Finance 지수 파싱 ─────────────────────────────────────── */
function parseNaver(d) {
  if (!d) return null;
  const price   = parseFloat(String(d.closePrice || d.currentPrice || '0').replace(/,/g, ''));
  const chg     = parseFloat(String(d.compareToPreviousClosePrice || '0').replace(/,/g, ''));
  const chgRate = parseFloat(String(d.fluctuationsRatio || '0').replace(/,/g, ''));
  if (!price) return null;
  return { price, change: chg, changeRate: chgRate };
}

/* ── Yahoo Finance 차트 파싱 ─────────────────────────────────────── */
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
    price:      Math.round(price    * 10)  / 10,
    change:     Math.round(chg      * 10)  / 10,
    changeRate: Math.round(chgRate  * 100) / 100,
  };
}

/* ── Redis에서 supply 캐시 읽기 ──────────────────────────────────── */
async function readSupplyCache(redisUrl, redisToken) {
  if (!redisUrl || !redisToken) return null;
  try {
    const raw = await timedFetch(`${redisUrl}/get/supply_cache`, {
      headers: { Authorization: `Bearer ${redisToken}` },
    }).then(r => r.json());
    return raw.result ? JSON.parse(raw.result) : null;
  } catch (_) { return null; }
}

/* ── 외인+기관 수급 점수 (−15 ~ +15점) ──────────────────────────── */
function calcSupplyScore(supply) {
  if (!supply) return 0; // 데이터 없으면 중립

  const foreignNet = supply.foreignNet || 0;
  const instNet    = supply.instNet    || 0;
  const combined   = foreignNet + instNet; // 순매수 합산 (주)

  // 개별 방향 체크
  const fSign = Math.sign(foreignNet);
  const iSign = Math.sign(instNet);

  if (fSign > 0 && iSign > 0) return 15;   // 외인·기관 동반 매수 → 강한 긍정
  if (fSign > 0 && iSign < 0) return combined > 0 ? 8 : -3; // 외인 매수, 기관 매도 → 외인 우세면 긍정
  if (fSign < 0 && iSign > 0) return combined > 0 ? 3 : -8; // 외인 매도, 기관 매수
  if (fSign < 0 && iSign < 0) return -15;  // 외인·기관 동반 매도 → 강한 부정
  return 0; // 한쪽만 0인 경우
}

/* ── 마켓스코어 계산 (0~100점 연속값) ───────────────────────────── */
function calcSentiment(kospiRate, kosdaqRate, usdRate, supply) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // 1. 코스피 방향 (−20 ~ +20)
  const kospiScore  = clamp((kospiRate  || 0) * (20 / 3), -20, 20);
  // 2. 코스닥 방향 (−10 ~ +10)
  const kosdaqScore = clamp((kosdaqRate || 0) * (10 / 3), -10, 10);
  // 3. 달러/원 방향 (−5 ~ +5)  ※ 달러 하락 = 원화 강세 = 긍정
  const usdScore    = clamp(-(usdRate   || 0) * 5,         -5,  5);
  // 4. 외인+기관 수급 (−15 ~ +15)
  const supplyScore = calcSupplyScore(supply);

  const total = Math.round(
    Math.max(0, Math.min(100, 50 + kospiScore + kosdaqScore + usdScore + supplyScore))
  );

  // 레이블 결정
  let label, color, bg;
  if      (total >= 75) { label = '과열';     color = '#dc2626'; bg = 'rgba(220,38,38,.12)'; }
  else if (total >= 60) { label = '탐욕';     color = '#d97706'; bg = 'rgba(217,119,6,.12)'; }
  else if (total >= 40) { label = '중립';     color = '#6b7280'; bg = 'rgba(107,114,128,.12)'; }
  else if (total >= 25) { label = '공포';     color = '#2563eb'; bg = 'rgba(37,99,235,.12)'; }
  else                  { label = '극도공포'; color = '#7c3aed'; bg = 'rgba(124,58,237,.12)'; }

  return {
    label, color, bg, score: total,
    detail: {
      kospiScore:  Math.round(kospiScore  * 10) / 10,
      kosdaqScore: Math.round(kosdaqScore * 10) / 10,
      usdScore:    Math.round(usdScore    * 10) / 10,
      supplyScore,
      hasSupply:   !!supply,
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');

  const redisUrl   = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  /* ── 1) Redis 캐시 ────────────────────────────────────────────── */
  if (redisUrl && redisToken) {
    try {
      const raw = await timedFetch(`${redisUrl}/get/${CACHE_KEY}`, {
        headers: { Authorization: `Bearer ${redisToken}` },
      }).then(r => r.json());
      if (raw.result) {
        const cached = JSON.parse(raw.result);
        if (Date.now() - (cached.ts || 0) < CACHE_TTL * 1000) {
          return res.status(200).json({ success: true, ...cached, source: 'cache' });
        }
      }
    } catch (_) {}
  }

  /* ── 2) 데이터 조회 ───────────────────────────────────────────── */
  const NAVER_UA = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    Referer: 'https://m.stock.naver.com',
  };

  const [kospiRaw, kosdaqRaw, usdRaw, supply] = await Promise.all([
    timedFetch('https://m.stock.naver.com/api/index/KOSPI/basic',  { headers: NAVER_UA }).then(r => r.json()).catch(() => null),
    timedFetch('https://m.stock.naver.com/api/index/KOSDAQ/basic', { headers: NAVER_UA }).then(r => r.json()).catch(() => null),
    timedFetch('https://query1.finance.yahoo.com/v8/finance/chart/USDKRW%3DX?interval=1d&range=5d').then(r => r.json()).catch(() => null),
    readSupplyCache(redisUrl, redisToken),
  ]);

  const kospi  = parseNaver(kospiRaw);
  const kosdaq = parseNaver(kosdaqRaw);
  const usdkrw = parseYahoo(usdRaw);

  if (!kospi && !kosdaq) {
    return res.status(200).json({ success: false, error: '시장 데이터를 가져올 수 없습니다.' });
  }

  const senti   = calcSentiment(
    kospi?.changeRate,
    kosdaq?.changeRate,
    usdkrw?.changeRate,
    supply
  );
  const payload = {
    kospi, kosdaq, usdkrw,
    sentiment: senti,
    ts:        Date.now(),
    updatedAt: new Date().toISOString(),
  };

  /* ── 3) Redis 저장 ────────────────────────────────────────────── */
  if (redisUrl && redisToken) {
    try {
      await timedFetch(`${redisUrl}/pipeline`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify([['SET', CACHE_KEY, JSON.stringify(payload), 'EX', String(STALE_TTL)]]),
      });
    } catch (_) {}
  }

  return res.status(200).json({ success: true, ...payload, source: 'fresh' });
}
