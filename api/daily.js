/**
 * 국장 브리핑 API
 * Redis daily_newsletter 키에서 Gemini 생성 뉴스레터를 반환
 * 생성: scripts/generate_newsletter.py (매일 08:00 KST)
 */

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');

  const kv_url   = process.env.KV_REST_API_URL;
  const kv_token = process.env.KV_REST_API_TOKEN;

  if (!kv_url || !kv_token) {
    return res.status(500).json({ success: false, error: 'Redis 설정 없음' });
  }

  try {
    const raw = await timedFetch(`${kv_url}/get/daily_newsletter`, {
      headers: { Authorization: `Bearer ${kv_token}` },
    }).then(r => r.json());

    if (!raw.result) {
      return res.status(200).json({
        success: false,
        error: '오늘의 브리핑을 준비 중입니다. 평일 오전 8시 이후 확인해 주세요.',
      });
    }

    const data = JSON.parse(raw.result);
    return res.status(200).json({ success: true, ...data });

  } catch (e) {
    console.error('[daily] Redis 오류:', e.message);
    return res.status(200).json({ success: false, error: '데이터를 불러올 수 없습니다.' });
  }
}
