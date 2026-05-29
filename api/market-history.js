/**
 * 마켓스코어 히스토리 API
 * Redis market_history 키에서 최근 N일 데이터를 반환 (차트용)
 */

'use strict';

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
  res.setHeader('Cache-Control', 'public, max-age=300');

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const days    = Math.min(parseInt(req.query?.days || '30', 10), 90);

  if (!kvUrl || !kvToken) {
    return res.status(500).json({ success:false, error:'Redis 설정 없음' });
  }

  try {
    const raw = await timedFetch(`${kvUrl}/get/market_history`, {
      headers: { Authorization:`Bearer ${kvToken}` },
    }).then(r => r.json());

    if (!raw.result) {
      return res.status(200).json({ success:true, history:[] });
    }

    const history = JSON.parse(raw.result);
    // 최신순 저장 → 차트는 오래된 것부터 필요하므로 역순 반환
    const slice = history.slice(0, days).reverse();

    return res.status(200).json({ success:true, history: slice, total: history.length });
  } catch (e) {
    return res.status(200).json({ success:false, error:e.message, history:[] });
  }
}
