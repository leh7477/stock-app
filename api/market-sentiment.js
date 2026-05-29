/**
 * 마켓 뉴스 Sentiment 입력 API
 *
 * POST /api/market-sentiment
 * Headers: x-api-key: {MARKET_SENTIMENT_KEY}
 * Body: { score: 0~100, source?: string, note?: string }
 *
 * - 오늘의 AI 뉴스 sentiment 점수를 Redis에 저장
 * - api/market.js 가 market_sentiment 키를 읽어 마켓스코어에 반영
 * - TTL 26시간 (매일 갱신 용도)
 */

'use strict';

const SENTI_KEY  = 'market_sentiment';
const SENTI_TTL  = 26 * 3600;
const TIMEOUT_MS = 6000;

async function timedFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(id); return r;
  } catch (e) { clearTimeout(id); throw e; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  /* ── GET: 현재 저장된 sentiment 조회 ── */
  if (req.method === 'GET') {
    if (!kvUrl || !kvToken) return res.status(200).json({ score:null });
    try {
      const raw = await timedFetch(`${kvUrl}/get/${SENTI_KEY}`, {
        headers: { Authorization:`Bearer ${kvToken}` },
      }).then(r => r.json());
      const data = raw.result ? JSON.parse(raw.result) : null;
      return res.status(200).json({ success:true, ...data });
    } catch {
      return res.status(200).json({ success:false, score:null });
    }
  }

  /* ── POST: sentiment 저장 ── */
  if (req.method !== 'POST') return res.status(405).json({ error:'Method Not Allowed' });

  // API 키 인증 (환경변수 없으면 개방)
  const apiKey = process.env.MARKET_SENTIMENT_KEY;
  if (apiKey && req.headers['x-api-key'] !== apiKey) {
    return res.status(401).json({ error:'Unauthorized' });
  }

  const body  = req.body || {};
  const score = Number(body.score);

  if (isNaN(score) || score < 0 || score > 100) {
    return res.status(400).json({ error:'score must be 0~100' });
  }

  const kstDate = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const payload = {
    score:     Math.round(score),
    source:    body.source  || 'manual',
    note:      body.note    || '',
    date:      kstDate,
    storedAt:  new Date().toISOString(),
  };

  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error:'Redis 설정 없음' });
  }

  try {
    await timedFetch(`${kvUrl}/pipeline`, {
      method:  'POST',
      headers: { Authorization:`Bearer ${kvToken}`, 'Content-Type':'application/json' },
      body:    JSON.stringify([['SET', SENTI_KEY, JSON.stringify(payload), 'EX', String(SENTI_TTL)]]),
    });

    // 기존 캐시 무효화 (다음 /api/market 호출 시 새 sentiment 반영)
    await timedFetch(`${kvUrl}/del/market_v4`, {
      method:  'POST',
      headers: { Authorization:`Bearer ${kvToken}` },
    }).catch(() => {});

    return res.status(200).json({ success:true, ...payload });
  } catch (e) {
    return res.status(500).json({ error:e.message });
  }
}
