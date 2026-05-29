/**
 * 방문자 트래킹 API
 * GET /api/track?page=index
 * Redis에 페이지뷰·일별·실시간 방문자 수를 기록
 */

const TIMEOUT_MS = 4000;

function kstToday() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

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
  res.setHeader('Cache-Control', 'no-store');

  const kv_url   = process.env.KV_REST_API_URL;
  const kv_token = process.env.KV_REST_API_TOKEN;
  if (!kv_url || !kv_token) return res.status(200).json({ ok: false });

  const page  = String(req.query?.page || 'unknown').replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'unknown';
  const today = kstToday();
  const now   = Date.now();

  // IP + UA + 날짜 기반 세션 ID (개인정보 비저장)
  const ip  = (req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 45) || 'x';
  const ua  = (req.headers['user-agent'] || '').slice(0, 120);
  const sid = simpleHash(`${ip}|${ua}|${today}`);

  const pipeline = [
    ['INCR',              'visit:total'],
    ['INCR',              `visit:daily:${today}`],
    ['EXPIRE',            `visit:daily:${today}`, '7776000'],   // 90일
    ['INCR',              `visit:page:${page}`],
    ['SADD',              `visit:uniq:${today}`, sid],
    ['EXPIRE',            `visit:uniq:${today}`, '7776000'],
    ['ZADD',              'visit:rt', now.toString(), sid],
    ['ZREMRANGEBYSCORE',  'visit:rt', '-inf', (now - 300000).toString()],  // 5분 초과 제거
  ];

  try {
    await timedFetch(`${kv_url}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${kv_token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(pipeline),
    });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(200).json({ ok: false });
  }
}
