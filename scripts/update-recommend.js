/**
 * 전종목 MA 분석 업데이트 스크립트
 * - DART API → KOSPI+KOSDAQ 전종목 코드 조회 (ZIP 파일)
 * - KIS API  → 각 종목 60일 일봉 종가 조회
 * - MA5/MA20/MA60 계산, 스코어링 → Redis 저장
 */

'use strict';

const AdmZip = require('adm-zip');

const KV_URL      = process.env.KV_REST_API_URL;
const KV_TOKEN    = process.env.KV_REST_API_TOKEN;
const KIS_KEY     = process.env.KIS_APP_KEY;
const KIS_SEC     = process.env.KIS_APP_SECRET;
const DART_KEY    = process.env.DART_API_KEY;

const BATCH_SIZE  = 15;    // KIS API: 초당 20건 제한보다 여유있게
const BATCH_DELAY = 1100;  // ms
const TIMEOUT_MS  = 10000;

// ─── 유틸 ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseNum(s) { return parseInt(String(s || '0').replace(/,/g, '')) || 0; }

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

async function getKisToken() {
  const cached = await redisGet('kis_token');
  if (cached) { console.log('[token] Redis 캐시 사용'); return cached; }

  const data = await timedFetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_KEY, appsecret: KIS_SEC }),
  }).then(r => r.json());

  if (!data.access_token) throw new Error('KIS 토큰 실패: ' + JSON.stringify(data));
  await redisSet('kis_token', data.access_token, 82800);
  console.log('[token] 신규 발급 완료');
  return data.access_token;
}

// ─── DART 전종목 코드 조회 ─────────────────────────────────────────────────
// DART API: corpCode.xml → ZIP 파일 → CORPCODE.xml (전 상장/비상장 법인)
// stock_code가 6자리 숫자인 것만 = 실제 상장 종목

async function fetchAllListedStocks() {
  console.log('[dart] corpCode.xml 다운로드...');
  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_KEY}`;

  const res = await timedFetch(url);
  if (!res.ok) throw new Error(`DART 응답 오류: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());

  // ZIP 파일 여부 확인 (ZIP 시그니처 PK = 0x50 0x4B)
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
    const preview = buffer.slice(0, 500).toString('utf-8');
    throw new Error(`DART 응답이 ZIP이 아님 (API 키 오류?): ${preview}`);
  }

  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('CORPCODE.xml');
  if (!entry) throw new Error('CORPCODE.xml not found in ZIP');

  const xml = entry.getData().toString('utf-8');

  // 정규식으로 XML 파싱 (xml2js 없이)
  const stocks = [];
  const re = /<list>([\s\S]*?)<\/list>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const code = (block.match(/<stock_code>\s*(\S+)\s*<\/stock_code>/) || [])[1]?.trim();
    const name = (block.match(/<corp_name>\s*(.*?)\s*<\/corp_name>/)   || [])[1]?.trim();
    if (code && /^\d{6}$/.test(code)) {
      stocks.push({ code, name, market: '', sector: '' });
    }
  }

  console.log(`[dart] 상장 종목 ${stocks.length}개 확인`);
  return stocks;
}

// ─── KIS 일봉 조회 ─────────────────────────────────────────────────────────

async function fetchDailyCandles(token, code, mkCode) {
  const now     = new Date();
  const endDt   = now.toISOString().slice(0, 10).replace(/-/g, '');
  const startDt = new Date(now - 100 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');

  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: mkCode,
    fid_input_iscd:         code,
    fid_input_date_1:       startDt,
    fid_input_date_2:       endDt,
    fid_period_div_code:    'D',
    fid_org_adj_prc:        '0',
  });

  return timedFetch(
    `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-price?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        appkey:    KIS_KEY,
        appsecret: KIS_SEC,
        'tr_id':   'FHKST01010400',
        custtype:  'P',
        'Content-Type': 'application/json',
      },
    }
  ).then(r => r.json());
}

// ─── MA 계산 & 스코어 ──────────────────────────────────────────────────────

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

function maSignal(price, ma) {
  if (!ma || !price) return 'neutral';
  const r = (price - ma) / ma * 100;
  if (r > 1)  return 'up';
  if (r < -1) return 'down';
  return 'neutral';
}

function analyze(stock, closes) {
  if (closes.length < 22) return null;
  const n = closes.length - 1, cur = closes[n];
  const ma5  = calcMA(closes, 5);
  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, Math.min(60, closes.length));
  const ma5p  = closes.length > 6  ? calcMA(closes.slice(0, -3), 5)  : null;
  const ma20p = closes.length > 30 ? calcMA(closes.slice(0, -7), 20) : null;

  let score = 40;
  const signals = [];

  if (ma5 && ma20 && ma60) {
    if      (ma5 > ma20 && ma20 > ma60) { score += 30; signals.push('정배열 — 단기·중기·장기 모두 우상향'); }
    else if (ma5 < ma20 && ma20 < ma60) { score -= 25; signals.push('역배열 — 하락 추세 지속 주의'); }
    else if (ma5 > ma20)                { score += 10; signals.push('단기 이평선 상향 — 중기 회복 진행 중'); }
    else if (ma20 > ma60)               { score += 5;  signals.push('중기 이평선 상향 — 장기 추세 전환 시도'); }
  }

  if (ma5  && cur > ma5)  score += 8;
  if (ma20 && cur > ma20) score += 10;
  if (ma60 && cur > ma60) score += 5;
  if (ma5  && ma5p  && ma5  > ma5p)  score += 5;
  if (ma20 && ma20p && ma20 > ma20p) { score += 5; signals.push('20일선 상승 중'); }

  const ma5a  = calcMAArr(closes, 5);
  const ma20a = calcMAArr(closes, 20);
  let cross = false;
  for (let i = Math.max(1, n - 4); i <= n && !cross; i++) {
    if (ma5a[i] && ma20a[i] && ma5a[i-1] && ma20a[i-1]) {
      if      (ma5a[i] > ma20a[i] && ma5a[i-1] <= ma20a[i-1]) { score += 15; signals.unshift('골든크로스 발생 — 단기 강세 신호 ✓'); cross = true; }
      else if (ma5a[i] < ma20a[i] && ma5a[i-1] >= ma20a[i-1]) { score -= 12; signals.unshift('데드크로스 발생 — 단기 주의 신호');  cross = true; }
    }
  }

  const chg5 = closes.length >= 6 ? (cur - closes[n - 5]) / closes[n - 5] * 100 : 0;
  score += Math.max(-10, Math.min(10, Math.round(chg5)));
  score  = Math.max(10, Math.min(95, Math.round(score)));

  const chgRate = closes.length >= 2
    ? ((cur - closes[n - 1]) / closes[n - 1] * 100).toFixed(2) : '0.00';

  return {
    ...stock,
    price:     cur,
    chgRate:   parseFloat(chgRate),
    ma5, ma20, ma60,
    ma5Signal:  maSignal(cur, ma5),
    ma20Signal: maSignal(cur, ma20),
    ma60Signal: maSignal(cur, ma60),
    score,
    signals: signals.slice(0, 2),
  };
}

// ─── 단일 종목 처리 (KOSPI→KOSDAQ 순서로 자동 감지) ──────────────────────

async function processStock(token, stock) {
  const markets = stock.market ? [stock.market === 'KOSPI' ? 'J' : 'Q'] : ['J', 'Q'];

  for (const mkCode of markets) {
    try {
      const raw = await fetchDailyCandles(token, stock.code, mkCode);

      // output 또는 output2 필드 모두 허용 (TR_ID에 따라 다름)
      const rawOutput = raw?.output2 ?? raw?.output;
      if (!rawOutput?.length) continue;

      // 최근 100일만 사용, 시간순 정렬
      const closes = rawOutput.slice(0, 100).reverse().map(d => parseNum(d.stck_clpr));
      if (closes.length < 22) continue;
      if (!closes[closes.length - 1]) continue; // 최근 종가 0이면 거래 없는 종목

      const market = mkCode === 'J' ? 'KOSPI' : 'KOSDAQ';
      return analyze({ ...stock, market }, closes);
    } catch (e) {
      continue;
    }
  }
  return null;
}

// ─── 메인 ──────────────────────────────────────────────────────────────────

async function main() {
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  console.log(`\n=== 전종목 MA 분석 시작: ${kstNow.toISOString().replace('T',' ').slice(0,19)} KST ===\n`);

  // 1. DART → 전종목 코드
  console.log('[1/4] DART 전종목 목록 조회...');
  let allStocks;
  try {
    allStocks = await fetchAllListedStocks();
  } catch (e) {
    console.error('[1/4] 실패:', e.message);
    process.exit(1);
  }

  // 2. KIS 토큰
  console.log('[2/4] KIS 토큰 확인...');
  let token;
  try {
    token = await getKisToken();
  } catch (e) {
    console.error('[2/4] KIS 토큰 실패:', e.message);
    process.exit(1);
  }

  // 3. 배치 처리
  console.log(`[3/4] 일봉 조회 + MA 분석... (${allStocks.length}개 종목, 배치 ${BATCH_SIZE}개)`);
  const results = [];
  let processed = 0, failed = 0;

  for (let i = 0; i < allStocks.length; i += BATCH_SIZE) {
    const batch = allStocks.slice(i, i + BATCH_SIZE);
    const batchRes = await Promise.all(batch.map(s => processStock(token, s)));
    batchRes.forEach(r => { if (r) results.push(r); else failed++; });
    processed += batch.length;

    if (processed % 300 === 0 || i + BATCH_SIZE >= allStocks.length) {
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
  console.log(`      완료: ${results.length}개 종목 저장, 기준일 ${baseDate}`);
  console.log('\n=== 완료 ===\n');
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
