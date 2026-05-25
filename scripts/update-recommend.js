/**
 * 전종목 MA + 기본 정보 분석 업데이트 스크립트
 * - DART API  → 전종목 코드 + corp_code
 * - KIS (FHKST01010400) → 일봉 (거래량, 외인보유율, 외인순매수 포함)
 * - KIS (FHKST01010100) → 시가총액, PER, PBR, EPS, 업종명
 * - MA5/MA20/MA60 계산, 스코어링 → Redis 저장
 */

'use strict';

const AdmZip = require('adm-zip');

const KV_URL    = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;
const KIS_KEY   = process.env.KIS_APP_KEY;
const KIS_SEC   = process.env.KIS_APP_SECRET;
const DART_KEY  = process.env.DART_API_KEY;

const BATCH_SIZE  = 6;     // 종목당 API 3회 → 6개 병렬 = 약 18 calls/sec (KIS 한도 20/sec)
const BATCH_DELAY = 1200;
const TIMEOUT_MS  = 10000;

// 분석 제외 키워드 (스팩, 특수 목적 법인)
const SKIP_KEYWORDS = [
  '기업인수목적', '스팩', 'SPAC', '선박투자회사',
  '부동산투자회사', '인프라투자회사', '위탁관리부동산',
];

// ─── 유틸 ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseNum(s) { return parseInt(String(s || '0').replace(/,/g, '')) || 0; }
function parseF(s)   { return parseFloat(String(s || '0').replace(/,/g, '')) || 0; }

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

async function fetchAllListedStocks() {
  console.log('[dart] corpCode.xml 다운로드...');
  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_KEY}`;

  const res = await timedFetch(url);
  if (!res.ok) throw new Error(`DART 응답 오류: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
    throw new Error(`DART 응답이 ZIP이 아님: ${buffer.slice(0, 200).toString('utf-8')}`);
  }

  const zip   = new AdmZip(buffer);
  const entry = zip.getEntry('CORPCODE.xml');
  if (!entry) throw new Error('CORPCODE.xml not found in ZIP');
  const xml = entry.getData().toString('utf-8');

  const stocks = [];
  const re = /<list>([\s\S]*?)<\/list>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block    = m[1];
    const code     = (block.match(/<stock_code>\s*(\S+)\s*<\/stock_code>/) || [])[1]?.trim();
    const name     = (block.match(/<corp_name>\s*(.*?)\s*<\/corp_name>/)   || [])[1]?.trim();
    const corpCode = (block.match(/<corp_code>\s*(\S+)\s*<\/corp_code>/)   || [])[1]?.trim();
    if (code && /^\d{6}$/.test(code)) {
      // 스팩·특수목적법인 제외
      if (name && SKIP_KEYWORDS.some(kw => name.includes(kw))) continue;
      stocks.push({ code, name, corp_code: corpCode, market: '', sector: '' });
    }
  }

  console.log(`[dart] 분석 대상 ${stocks.length}개 확인`);
  return stocks;
}

// ─── KIS 일봉 조회 (거래량·외인 포함) ─────────────────────────────────────

function kisHeaders(token, trId) {
  return {
    Authorization: `Bearer ${token}`,
    appkey: KIS_KEY, appsecret: KIS_SEC,
    'tr_id': trId, custtype: 'P',
    'Content-Type': 'application/json',
  };
}

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
    { headers: kisHeaders(token, 'FHKST01010400') }
  ).then(r => r.json());
}

// ─── KIS 현재가 + 기본 정보 (PER·PBR·EPS·시가총액·업종) ───────────────────

async function fetchStockInfo(token, code, mkCode) {
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: mkCode,
    fid_input_iscd:         code,
  });

  return timedFetch(
    `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
    { headers: kisHeaders(token, 'FHKST01010100') }
  ).then(r => r.json());
}

// ─── MA 계산 ───────────────────────────────────────────────────────────────

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

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d; else lossSum -= d;
  }
  let ag = gainSum / period, al = lossSum / period;
  rsi[period] = al === 0 ? 100 : Math.round((100 - 100 / (1 + ag / al)) * 10) / 10;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = al === 0 ? 100 : Math.round((100 - 100 / (1 + ag / al)) * 10) / 10;
  }
  return rsi;
}

function maSignal(price, ma) {
  if (!ma || !price) return 'neutral';
  const r = (price - ma) / ma * 100;
  if (r > 1)  return 'up';
  if (r < -1) return 'down';
  return 'neutral';
}

// ─── 스코어링 & 분석 ───────────────────────────────────────────────────────

function analyze(stock, closes, extra = {}) {
  if (closes.length < 22) return null;
  const n = closes.length - 1, cur = closes[n];
  if (!cur) return null;

  // ── MA 배열 계산 ──
  const ma5a  = calcMAArr(closes, 5);
  const ma20a = calcMAArr(closes, 20);
  const ma60a = calcMAArr(closes, Math.min(60, closes.length));
  const rsiArr = calcRSI(closes);

  const ma5  = ma5a[n]  || 0;
  const ma20 = ma20a[n] || 0;
  const ma60 = ma60a[n] || 0;
  const rsi  = rsiArr[n];

  const signals = [];

  // ── 점수 계산 (analyze.js calcScore와 동일) ──
  let score = 50;

  // 이평선 배열 (±15 / -18)
  if (ma5 && ma20 && ma60) {
    if      (ma5 > ma20 && ma20 > ma60) { score += 15; signals.push('정배열 — 단기·중기·장기 모두 우상향'); }
    else if (ma5 < ma20 && ma20 < ma60) { score -= 18; signals.push('역배열 — 하락 추세 지속 주의'); }
    else if (ma5 > ma20)                {              signals.push('단기 이평선 상향 — 중기 회복 진행 중'); }
    else if (ma20 > ma60)               {              signals.push('중기 이평선 상향 — 장기 추세 전환 시도'); }
  }

  // 현재가 vs 이평선 (상승 +8/+8/+5, 하락 -5/-5/-3)
  if (ma5)  score += cur > ma5  ? 8 : -5;
  if (ma20) score += cur > ma20 ? 8 : -5;
  if (ma60) score += cur > ma60 ? 5 : -3;

  // 골든/데드크로스 (+10 / -10, 직전 1봉 기준)
  if (n >= 1) {
    const pm5 = ma5a[n - 1] || 0, pm20 = ma20a[n - 1] || 0;
    if (pm5 && pm20 && ma5 && ma20) {
      if (pm5 <= pm20 && ma5 > ma20) { score += 10; signals.unshift('골든크로스 발생 — 단기 강세 신호 ✓'); }
      if (pm5 >= pm20 && ma5 < ma20) { score -= 10; signals.unshift('데드크로스 발생 — 단기 주의 신호'); }
    }
  }

  // RSI 반영 (+8 / -8 / ±3)
  if (rsi !== null) {
    if      (rsi < 30) score += 8;
    else if (rsi > 70) score -= 8;
    else if (rsi > 55) score += 3;
    else if (rsi < 45) score -= 3;
  }

  score = Math.max(5, Math.min(99, Math.round(score)));

  const chgRate = closes.length >= 2
    ? ((cur - closes[n - 1]) / closes[n - 1] * 100).toFixed(2) : '0.00';

  return {
    code:        stock.code,
    name:        stock.name,
    corp_code:   stock.corp_code || '',
    market:      stock.market,
    sector:      extra.sector    || stock.sector || '',
    price:       cur,
    chgRate:     parseFloat(chgRate),
    ma5, ma20, ma60,
    ma5Signal:   maSignal(cur, ma5),
    ma20Signal:  maSignal(cur, ma20),
    ma60Signal:  maSignal(cur, ma60),
    score,
    signals:     signals.slice(0, 2),
    // 수급·기본 정보
    volume:      extra.volume      || 0,
    frgnRatio:   extra.frgnRatio   || 0,   // 외인 보유율 (%)
    frgnBuyQty:  extra.frgnBuyQty  || 0,   // 외인 순매수 수량
    mktCap:      extra.mktCap      || 0,   // 시가총액 (억원)
    per:         extra.per         || 0,
    pbr:         extra.pbr         || 0,
    eps:         extra.eps         || 0,
  };
}

// ─── 단일 종목 처리 ────────────────────────────────────────────────────────

async function processStock(token, stock) {
  const markets = stock.market ? [stock.market === 'KOSPI' ? 'J' : 'Q'] : ['J', 'Q'];

  for (const mkCode of markets) {
    try {
      // 1) 일봉 데이터 조회
      const raw = await fetchDailyCandles(token, stock.code, mkCode);
      const rawOutput = raw?.output2 ?? raw?.output;
      if (!rawOutput?.length) continue;

      const recent      = rawOutput.slice(0, 100);  // 최신순 상위 100개
      const latestDay   = recent[0];                // 가장 최근 일봉
      const closes      = recent.slice().reverse().map(d => parseNum(d.stck_clpr));

      if (closes.length < 22) continue;
      if (!closes[closes.length - 1]) continue;     // 최근 종가 0 → 거래 없음

      // 일봉에서 수급 데이터 추출
      const volume     = parseNum(latestDay?.acml_vol);
      const frgnRatio  = parseF(latestDay?.hts_frgn_ehrt);
      const frgnBuyQty = parseNum(latestDay?.frgn_ntby_qty);

      // 5일/20일 투자자 수급 (FHKST01010900 → output 배열 30일치)
      let investorSupply = null;
      try {
        const invRaw = await timedFetch(
          `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor` +
          `?fid_cond_mrkt_div_code=${mkCode}&fid_input_iscd=${code}`,
          { headers: kisHeaders(token, 'FHKST01010900') }
        ).then(r => r.json()).catch(() => null);

        const rows = Array.isArray(invRaw?.output) ? invRaw.output : [];
        if (rows.length >= 5) {
          const sumN   = (arr, f) => arr.reduce((s, d) => s + parseNum(d[f] || '0'), 0);
          const fmtBsop = d => { const dt = d?.stck_bsop_date; return dt ? `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}` : ''; };
          const rows5  = rows.slice(0, 5);
          const rows20 = rows.slice(0, Math.min(20, rows.length));
          investorSupply = {
            d5:  { foreign: sumN(rows5,'frgn_ntby_qty'),  inst: sumN(rows5,'orgn_ntby_qty'),  personal: sumN(rows5,'prsn_ntby_qty'),  from: fmtBsop(rows5[rows5.length-1]),  to: fmtBsop(rows5[0]) },
            d20: { foreign: sumN(rows20,'frgn_ntby_qty'), inst: sumN(rows20,'orgn_ntby_qty'), personal: sumN(rows20,'prsn_ntby_qty'), from: fmtBsop(rows20[rows20.length-1]), to: fmtBsop(rows20[0]) },
          };
        }
      } catch (_) {}

      // 2) 현재가 + 기본 정보 조회 (PER·PBR·EPS·시가총액·업종)
      let mktCap = 0, per = 0, pbr = 0, eps = 0, sector = '';
      try {
        const info = await fetchStockInfo(token, stock.code, mkCode);
        const o = info?.output;
        if (o) {
          mktCap = parseNum(o.hts_avls);
          per    = parseF(o.per);
          pbr    = parseF(o.pbr);
          eps    = parseNum(o.eps);
          sector = (o.bstp_kor_isnm || o.bstp_kor_isn_nm || '').trim();
        }
      } catch (_) { /* 기본정보 실패 시 무시 */ }

      const market = mkCode === 'J' ? 'KOSPI' : 'KOSDAQ';
      const result = analyze(
        { ...stock, market },
        closes,
        { volume, frgnRatio, frgnBuyQty, mktCap, per, pbr, eps, sector }
      );
      if (result) result.investorSupply = investorSupply;
      return result;

    } catch (_) { continue; }
  }
  return null;
}

// ─── 메인 ──────────────────────────────────────────────────────────────────

async function main() {
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  console.log(`\n=== 전종목 MA + 기본정보 분석: ${kstNow.toISOString().replace('T',' ').slice(0,19)} KST ===\n`);

  // 1. DART 전종목 코드
  console.log('[1/4] DART 전종목 목록 조회...');
  let allStocks;
  try   { allStocks = await fetchAllListedStocks(); }
  catch (e) { console.error('[1/4] 실패:', e.message); process.exit(1); }

  // 2. KIS 토큰
  console.log('[2/4] KIS 토큰 확인...');
  let token;
  try   { token = await getKisToken(); }
  catch (e) { console.error('[2/4] 실패:', e.message); process.exit(1); }

  // 3. 배치 처리
  console.log(`[3/4] 일봉 + 기본정보 조회... (${allStocks.length}개, 배치 ${BATCH_SIZE}개)`);
  const results = [];
  let processed = 0, failed = 0;

  for (let i = 0; i < allStocks.length; i += BATCH_SIZE) {
    const batch    = allStocks.slice(i, i + BATCH_SIZE);
    const batchRes = await Promise.all(batch.map(s => processStock(token, s)));
    batchRes.forEach(r => { if (r) results.push(r); else failed++; });
    processed += batch.length;

    if (processed % 200 === 0 || i + BATCH_SIZE >= allStocks.length) {
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

  // recommend_v2: 종목 목록 (investorSupply 포함)
  await redisSet('recommend_v2', payload, 28 * 3600);

  // investor_supply: 코드 → 수급 데이터 맵 (analyze API 전용, 빠른 단건 조회)
  const invMap = {};
  results.forEach(s => { if (s.investorSupply) invMap[s.code] = s.investorSupply; });
  await redisSet('investor_supply', invMap, 28 * 3600);

  console.log(`      완료: ${results.length}개 종목 저장, 수급 맵 ${Object.keys(invMap).length}개, 기준일 ${baseDate}`);
  console.log('\n=== 완료 ===\n');
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
