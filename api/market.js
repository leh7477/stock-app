/**
 * 시장 지수 API — 코스피 · 코스닥 · 달러/원 + 시장 심리
 * - 코스피/코스닥: Naver Finance API
 * - 달러/원:      Yahoo Finance
 * - Redis 30분 캐시
 */

const CACHE_KEY = 'market_v2';
const CACHE_TTL = 1800;               // 30분
const STALE_TTL = CACHE_TTL + 3600;   // Redis 만료

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

/* Naver Finance 지수 파싱 */
function parseNaver(d) {
  if (!d) return null;
  const price   = parseFloat(String(d.closePrice || d.currentPrice || '0').replace(/,/g, ''));
  const chg     = parseFloat(String(d.compareToPreviousClosePrice || '0').replace(/,/g, ''));
  const chgRate = parseFloat(String(d.fluctuationsRatio || '0').replace(/,/g, ''));
  if (!price) return null;
  return {
    price:      price,
    change:     chg,
    changeRate: chgRate,
  };
}

/* Yahoo Finance 차트 파싱 */
function parseYahoo(json) {
  const r = json?.chart?.result?.[0];
  if (!r) return null;
  const m      = r.meta || {};
  const price  = m.regularMarketPrice ?? m.previousClose;
  const prev   = m.previousClose ?? m.chartPreviousClose;
  if (!price) return null;
  const chg     = price - (prev || price);
  const chgRate = prev ? (chg / prev) * 100 : 0;
  return {
    price:      Math.round(price    * 10)  / 10,
    change:     Math.round(chg      * 10)  / 10,
    changeRate: Math.round(chgRate  * 100) / 100,
  };
}

/* 시장 심리 계산 */
function calcSentiment(kospiRate, kosdaqRate) {
  const avg = ((kospiRate || 0) + (kosdaqRate || 0)) / 2;
  if (avg >=  2.0) return { label: '과열',    emoji: '🔥', score: 5, color: '#dc2626', bg: 'rgba(220,38,38,.12)'  };
  if (avg >=  0.7) return { label: '탐욕',    emoji: '😊', score: 4, color: '#d97706', bg: 'rgba(217,119,6,.12)' };
  if (avg >= -0.7) return { label: '중립',    emoji: '😐', score: 3, color: '#6b7280', bg: 'rgba(107,114,128,.12)' };
  if (avg >= -2.0) return { label: '공포',    emoji: '😰', score: 2, color: '#2563eb', bg: 'rgba(37,99,235,.12)'  };
  return              { label: '극도공포', emoji: '😱', score: 1, color: '#7c3aed', bg: 'rgba(124,58,237,.12)' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');

  const redisUrl   = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  /* ── 1) Redis 캐시 ────────────────────────────── */
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

  /* ── 2) 데이터 조회 ───────────────────────────── */
  const NAVER_UA  = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', Referer: 'https://m.stock.naver.com' };
  const [kospiRaw, kosdaqRaw, usdRaw] = await Promise.all([
    timedFetch('https://m.stock.naver.com/api/index/KOSPI/basic',  { headers: NAVER_UA }).then(r => r.json()).catch(() => null),
    timedFetch('https://m.stock.naver.com/api/index/KOSDAQ/basic', { headers: NAVER_UA }).then(r => r.json()).catch(() => null),
    timedFetch('https://query1.finance.yahoo.com/v8/finance/chart/USDKRW%3DX?interval=1d&range=5d').then(r => r.json()).catch(() => null),
  ]);

  const kospi  = parseNaver(kospiRaw);
  const kosdaq = parseNaver(kosdaqRaw);
  const usdkrw = parseYahoo(usdRaw);

  if (!kospi && !kosdaq) {
    return res.status(200).json({ success: false, error: '시장 데이터를 가져올 수 없습니다.' });
  }

  const senti   = calcSentiment(kospi?.changeRate, kosdaq?.changeRate);
  const payload = {
    kospi, kosdaq, usdkrw,
    sentiment: senti,
    ts:        Date.now(),
    updatedAt: new Date().toISOString(),
  };

  /* ── 3) Redis 저장 ────────────────────────────── */
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
