// 전일 종가 기준 5/20/60일 이평선 분석 추천 API
const TIMEOUT_MS = 9000;

const STOCKS = [
  { code:'005930', name:'삼성전자',       sector:'반도체',   market:'KOSPI' },
  { code:'000660', name:'SK하이닉스',      sector:'반도체',   market:'KOSPI' },
  { code:'005380', name:'현대차',          sector:'자동차',   market:'KOSPI' },
  { code:'000270', name:'기아',            sector:'자동차',   market:'KOSPI' },
  { code:'068270', name:'셀트리온',        sector:'바이오',   market:'KOSPI' },
  { code:'207940', name:'삼성바이오로직스',sector:'바이오',   market:'KOSPI' },
  { code:'105560', name:'KB금융',          sector:'금융',     market:'KOSPI' },
  { code:'055550', name:'신한지주',        sector:'금융',     market:'KOSPI' },
  { code:'086790', name:'하나금융지주',    sector:'금융',     market:'KOSPI' },
  { code:'035720', name:'카카오',          sector:'플랫폼',   market:'KOSPI' },
  { code:'035420', name:'NAVER',           sector:'플랫폼',   market:'KOSPI' },
  { code:'323410', name:'카카오뱅크',      sector:'금융',     market:'KOSPI' },
  { code:'373220', name:'LG에너지솔루션',  sector:'2차전지',  market:'KOSPI' },
  { code:'051910', name:'LG화학',          sector:'2차전지',  market:'KOSPI' },
  { code:'012330', name:'현대모비스',      sector:'자동차',   market:'KOSPI' },
  { code:'066570', name:'LG전자',          sector:'가전·IT',  market:'KOSPI' },
  { code:'005490', name:'POSCO홀딩스',     sector:'철강·소재',market:'KOSPI' },
  { code:'010130', name:'고려아연',        sector:'철강·소재',market:'KOSPI' },
  { code:'012450', name:'한화에어로스페이스',sector:'방산',   market:'KOSPI' },
  { code:'034020', name:'두산에너빌리티',  sector:'방산',     market:'KOSPI' },
  { code:'259960', name:'크래프톤',        sector:'게임',     market:'KOSPI' },
  { code:'036570', name:'엔씨소프트',      sector:'게임',     market:'KOSPI' },
  { code:'009150', name:'삼성전기',        sector:'반도체',   market:'KOSPI' },
  { code:'015760', name:'한국전력',        sector:'에너지',   market:'KOSPI' },
  { code:'096770', name:'SK이노베이션',    sector:'에너지',   market:'KOSPI' },
];

async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) { clearTimeout(id); throw e; }
}

function parseNum(s) {
  return parseInt(String(s || '0').replace(/,/g, '')) || 0;
}

function calcMA(closes, n) {
  const i = closes.length - 1;
  if (i < n - 1) return null;
  const slice = closes.slice(i - n + 1, i + 1);
  return Math.round(slice.reduce((a, b) => a + b, 0) / n);
}

function calcMAArr(closes, n) {
  return closes.map((_, i) => {
    if (i < n - 1) return null;
    return Math.round(closes.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
  });
}

function maSignal(price, ma) {
  if (!ma || !price) return 'neutral';
  const ratio = (price - ma) / ma * 100;
  if (ratio > 1)  return 'up';
  if (ratio < -1) return 'down';
  return 'neutral';
}

function analyze(stock, closes) {
  if (closes.length < 22) return null;

  const n   = closes.length - 1;
  const cur = closes[n];
  const ma5   = calcMA(closes, 5);
  const ma20  = calcMA(closes, 20);
  const ma60  = calcMA(closes, Math.min(60, closes.length));

  // 추세 방향 (이전 기간과 비교)
  const ma5prev  = closes.length > 6  ? calcMA(closes.slice(0, -3), 5)  : null;
  const ma20prev = closes.length > 30 ? calcMA(closes.slice(0, -7), 20) : null;

  let score = 40;
  const signals = [];

  // ① 정배열 / 역배열
  if (ma5 && ma20 && ma60) {
    if (ma5 > ma20 && ma20 > ma60) {
      score += 30;
      signals.push('정배열 — 단기·중기·장기 모두 우상향');
    } else if (ma5 < ma20 && ma20 < ma60) {
      score -= 25;
      signals.push('역배열 — 하락 추세 지속 주의');
    } else if (ma5 > ma20) {
      score += 10;
      signals.push('단기 이평선 상향 — 중기 회복 진행 중');
    } else if (ma20 > ma60) {
      score += 5;
      signals.push('중기 이평선 상향 — 장기 추세 전환 시도');
    }
  }

  // ② 현재가 vs 각 이평선
  if (ma5  && cur > ma5)  score += 8;
  if (ma20 && cur > ma20) score += 10;
  if (ma60 && cur > ma60) score += 5;

  // ③ 이평선 자체 추세
  if (ma5 && ma5prev && ma5 > ma5prev)   { score += 5; }
  if (ma20 && ma20prev && ma20 > ma20prev) { score += 5; signals.push('20일선 상승 중'); }

  // ④ 골든크로스 / 데드크로스 감지 (최근 5거래일)
  const ma5arr  = calcMAArr(closes, 5);
  const ma20arr = calcMAArr(closes, 20);
  let crossFound = false;
  for (let i = Math.max(1, n - 4); i <= n && !crossFound; i++) {
    if (ma5arr[i] && ma20arr[i] && ma5arr[i-1] && ma20arr[i-1]) {
      if (ma5arr[i] > ma20arr[i] && ma5arr[i-1] <= ma20arr[i-1]) {
        score += 15;
        signals.unshift('골든크로스 발생 — 단기 강세 신호 ✓');
        crossFound = true;
      } else if (ma5arr[i] < ma20arr[i] && ma5arr[i-1] >= ma20arr[i-1]) {
        score -= 12;
        signals.unshift('데드크로스 발생 — 단기 주의 신호');
        crossFound = true;
      }
    }
  }

  // ⑤ 최근 5일 수익률 반영
  const chg5d = closes.length >= 6 ? (cur - closes[n - 5]) / closes[n - 5] * 100 : 0;
  score += Math.max(-10, Math.min(10, Math.round(chg5d)));

  score = Math.max(10, Math.min(95, Math.round(score)));

  const chgRate = closes.length >= 2
    ? ((cur - closes[n - 1]) / closes[n - 1] * 100).toFixed(2)
    : '0.00';

  return {
    ...stock,
    price:      cur,
    chgRate:    parseFloat(chgRate),
    ma5, ma20, ma60,
    ma5Signal:  maSignal(cur, ma5),
    ma20Signal: maSignal(cur, ma20),
    ma60Signal: maSignal(cur, ma60),
    score,
    signals: signals.slice(0, 2),
  };
}

async function fetchStock(stock) {
  try {
    const raw = await timedFetch(
      `https://m.stock.naver.com/api/stock/${stock.code}/price?pageSize=65&page=1`,
      { headers: { Referer: 'https://m.stock.naver.com', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' } }
    ).then(r => r.json());

    if (!Array.isArray(raw) || raw.length === 0) return null;
    const closes = raw.reverse().map(d => parseNum(d.closePrice));
    return analyze(stock, closes);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');

  const redisUrl   = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  // Redis 캐시 우선 (6시간)
  try {
    const cached = await timedFetch(`${redisUrl}/get/recommend_v2`, {
      headers: { Authorization: `Bearer ${redisToken}` },
    }).then(r => r.json());
    if (cached.result) {
      return res.status(200).json({ success: true, ...JSON.parse(cached.result), source: 'cache' });
    }
  } catch {}

  // 전체 병렬 조회
  const results = await Promise.allSettled(STOCKS.map(fetchStock));
  const stocks = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)
    .sort((a, b) => b.score - a.score);

  if (stocks.length === 0) {
    return res.status(200).json({ success: false, error: 'NAVER 데이터 조회 실패' });
  }

  const kstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const payload = { stocks, baseDate: kstDate };

  // Redis 저장 (6시간)
  try {
    await timedFetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', 'recommend_v2', JSON.stringify(payload), 'EX', '21600']]),
    });
  } catch {}

  res.status(200).json({ success: true, ...payload });
}
