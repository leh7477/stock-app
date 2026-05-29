/**
 * 방문자 통계 API (관리자 전용)
 * GET /api/stats?key=YOUR_SECRET_KEY
 * 환경변수 STATS_SECRET_KEY 가 설정되어 있어야 합니다.
 */

const TIMEOUT_MS = 8000;

function kstDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600000 - offsetDays * 86400000).toISOString().slice(0, 10);
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
  res.setHeader('Cache-Control', 'no-store');

  // 인증
  const secret = process.env.STATS_SECRET_KEY;
  if (!secret || req.query?.key !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const kv_url   = process.env.KV_REST_API_URL;
  const kv_token = process.env.KV_REST_API_TOKEN;
  if (!kv_url || !kv_token) return res.status(500).json({ error: 'Redis 미설정' });

  const today    = kstDate();
  const now      = Date.now();
  const fiveAgo  = now - 300000;
  const PAGES    = ['index', 'analyzer', 'today', 'guide', 'about'];
  const DAYS     = 14;

  // 파이프라인으로 한 번에 조회
  const pipeline = [
    ['GET',    'visit:total'],
    ['GET',    `visit:daily:${today}`],
    ['SCARD',  `visit:uniq:${today}`],
    ['ZCOUNT', 'visit:rt', fiveAgo.toString(), now.toString()],
    ...PAGES.map(p => ['GET', `visit:page:${p}`]),
    ...Array.from({ length: DAYS }, (_, i) => ['GET',   `visit:daily:${kstDate(i)}`]),
    ...Array.from({ length: DAYS }, (_, i) => ['SCARD', `visit:uniq:${kstDate(i)}`]),
  ];

  let results;
  try {
    const raw = await timedFetch(`${kv_url}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${kv_token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(pipeline),
    }).then(r => r.json());
    results = Array.isArray(raw) ? raw.map(r => r.result) : [];
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }

  let idx = 0;
  const total      = parseInt(results[idx++]) || 0;
  const todayViews = parseInt(results[idx++]) || 0;
  const todayUniq  = parseInt(results[idx++]) || 0;
  const realtime   = parseInt(results[idx++]) || 0;

  const pages = {};
  PAGES.forEach(p => { pages[p] = parseInt(results[idx++]) || 0; });

  const daily = {};
  const dailyViews = results.slice(idx, idx + DAYS);
  const dailyUniq  = results.slice(idx + DAYS, idx + DAYS * 2);
  for (let i = 0; i < DAYS; i++) {
    daily[kstDate(i)] = {
      views: parseInt(dailyViews[i]) || 0,
      uniq:  parseInt(dailyUniq[i])  || 0,
    };
  }

  return res.status(200).json({
    ok: true,
    total,
    today:    { views: todayViews, uniq: todayUniq },
    realtime,
    pages,
    daily,
  });
}
