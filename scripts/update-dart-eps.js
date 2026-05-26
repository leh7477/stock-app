/**
 * DART 연결 EPS 업데이트 스크립트 (분기 1회 실행)
 *
 * 왜 별도 스크립트인가?
 *   DART API 호출 ~2500번 × 1.5초 ≈ 60~90분 → 매일 돌리기 너무 느림
 *   EPS는 분기 1회(사업보고서 제출 후)만 바뀌므로 분기 워크플로우로 분리
 *
 * 저장 형식:
 *   Redis key: dart_eps
 *   Value: { "005930": 4776, "000660": 12345, ... }  ← 주당순이익(원)
 *
 * analyze.js에서 사용:
 *   PER = 현재가(KIS 실시간) ÷ dart_eps  → 실시간 연결 PER 계산
 */

'use strict';

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const DART_KEY = process.env.DART_API_KEY;

const TIMEOUT_MS  = 12000;
const BATCH_SIZE  = 5;
const BATCH_DELAY = 1500;

const SKIP_KEYWORDS = [
  '기업인수목적', '스팩', 'SPAC', '선박투자회사',
  '부동산투자회사', '인프라투자회사', '위탁관리부동산',
];
const ETF_PREFIX = /^(KODEX|TIGER|ARIRANG|KINDEX|KOSEF|KBSTAR|HANARO|TIMEFOLIO|TREX|FOCUS|PLUS|SOL |ACE )/i;
const ETF_WORD   = /레버리지|인버스|선물|스팩|ETF|리츠|인프라|부동산/;
const isETF = name => ETF_PREFIX.test(name || '') || ETF_WORD.test(name || '');

// ─── 유틸 ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function redisSet(key, value, ttlSec) {
  await timedFetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', String(ttlSec)]]),
  });
}

// ─── KRX 상장종목 조회 ─────────────────────────────────────────────────────

async function fetchAllListedStocks() {
  const KRX_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer':    'https://kind.krx.co.kr',
  };

  const fetchMarket = async (marketType, marketName) => {
    const url = `https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13&marketType=${marketType}`;
    const res  = await timedFetch(url, { headers: KRX_HEADERS });
    if (!res.ok) throw new Error(`KRX ${marketName} 응답 오류: ${res.status}`);
    const buf  = await res.arrayBuffer();
    const html = new TextDecoder('euc-kr').decode(buf);

    const stocks = [];
    const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch, isHeader = true;
    while ((rowMatch = rowRe.exec(html)) !== null) {
      if (isHeader) { isHeader = false; continue; }
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      while ((cm = cellRe.exec(rowMatch[1])) !== null) {
        cells.push(cm[1].replace(/<[^>]+>/g, '').trim());
      }
      if (cells.length < 3) continue;
      const name = cells[0];
      const code = cells[2].replace(/\D/g, '').padStart(6, '0');
      if (!code || !/^\d{6}$/.test(code) || !name) continue;
      if (SKIP_KEYWORDS.some(kw => name.includes(kw))) continue;
      if (isETF(name)) continue;
      stocks.push({ code, name });
    }
    return stocks;
  };

  const [kospi, kosdaq] = await Promise.all([
    fetchMarket('stockMkt',  'KOSPI'),
    fetchMarket('kosdaqMkt', 'KOSDAQ'),
  ]);

  const all = [...kospi, ...kosdaq];
  console.log(`[krx] KOSPI ${kospi.length}개 + KOSDAQ ${kosdaq.length}개 = 총 ${all.length}개`);
  if (all.length < 1000) throw new Error(`KRX 종목 수 이상 (${all.length}개) — 응답 확인 필요`);
  return all;
}

// ─── DART corp_code 맵 (종목코드 → corp_code) ─────────────────────────────

async function fetchDartCorpMap(krxCodes) {
  const AdmZip = (await import('adm-zip')).default;
  const res = await timedFetch(
    `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_KEY}`
  );
  const buf = await res.arrayBuffer();
  const zip = new AdmZip(Buffer.from(buf));
  const xml = zip.getEntry('CORPCODE.xml')?.getData().toString('utf-8');
  if (!xml) throw new Error('CORPCODE.xml 없음');

  const corpMap = {};
  const re = /<list>([\s\S]*?)<\/list>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block      = m[1];
    const corp_code  = block.match(/<corp_code>(\d+)<\/corp_code>/)?.[1];
    const stock_code = block.match(/<stock_code>\s*(\d+)\s*<\/stock_code>/)?.[1]?.trim();
    if (corp_code && stock_code && krxCodes.has(stock_code)) {
      corpMap[stock_code] = corp_code;
    }
  }
  console.log(`[dart] corp_code 매핑: ${Object.keys(corpMap).length}개 (KRX 기준 필터)`);
  return corpMap;
}

// ─── 현재 시점 기준 최신 분기 보고서 후보 목록 ────────────────────────────
// 분기 제출 기한: Q1=5/15, 반기=8/14, Q3=11/14, 연간=3/31(다음해)
// 가장 최신 분기부터 시도 → 없으면 이전 분기 → 최종 fallback 연간
function getReportCandidates() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  // 분기 보고서만 시도 — 없으면 analyze.js에서 KIS PER fallback 처리
  // (연간 사업보고서는 KIS PER과 동일 기준이라 포함 불필요)
  if (month >= 11) return [
    { year, code: '11014' },   // Q3 당해 (11월~)
    { year, code: '11012' },   // 반기 당해
    { year, code: '11013' },   // Q1 당해
  ];
  if (month >= 8) return [
    { year, code: '11012' },   // 반기 당해 (8월~)
    { year, code: '11013' },   // Q1 당해
  ];
  if (month >= 5) return [
    { year, code: '11013' },   // Q1 당해 (5월~)
  ];
  return [];  // 1~4월: 분기 미확정 → KIS PER 사용
}

// ─── DART 연결재무제표 → EPS 계산 ──────────────────────────────────────────
// 최신 분기 보고서부터 순서대로 시도, 연간 사업보고서로 fallback
// EPS = 기본주당이익 직접 조회 (원/주 단위), 없으면 당기순이익÷주식수 계산
// PER 계산은 analyze.js에서 실시간으로: 현재가 ÷ dart_eps

async function fetchDartEPS(corpCode) {
  const candidates = getReportCandidates();
  if (candidates.length === 0) return null;  // 1~4월: 분기 없음 → KIS PER 사용

  for (const { year, code: reprtCode } of candidates) {
    try {
      const url = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json` +
        `?crtfc_key=${DART_KEY}&corp_code=${corpCode}` +
        `&bsns_year=${year}&reprt_code=${reprtCode}&fs_div=CFS`;

      const data = await timedFetch(url).then(r => r.json()).catch(() => null);
      // status 000이 아니면 이 분기 보고서 없음 → 다음 후보로
      if (data?.status !== '000') continue;

      const list = data.list || [];

      // ── 방법1: 기본주당이익(EPS) 직접 조회 ────────────────────────────────
      // DART IS/CIS 항목에 "기본주당이익(손실)" 등으로 원/주 단위로 이미 제공됨
      const epsItem = list.find(r =>
        (r.sj_div === 'IS' || r.sj_div === 'CIS') &&
        (r.account_nm?.includes('기본주당이익') ||
         r.account_nm?.includes('기본주당순이익') ||
         r.account_nm?.includes('주당순이익'))
      );
      if (epsItem?.thstrm_amount) {
        const eps = parseInt(String(epsItem.thstrm_amount).replace(/[,\s]/g, '')) || 0;
        if (eps > 0) return eps;
        continue;  // 0 또는 음수면 다음 후보 (더 오래된 기간이 양수일 수 있음)
      }

      // ── 방법2: 당기순이익(백만원) ÷ 발행주식수 — fallback ─────────────────
      const netIncome = list.find(r =>
        (r.sj_div === 'IS' || r.sj_div === 'CIS') &&
        r.account_nm?.includes('당기순이익') &&
        !r.account_nm?.includes('비지배')
      );
      const shares = list.find(r =>
        r.account_nm?.includes('보통주') &&
        (r.account_nm?.includes('주식수') || r.account_nm?.includes('발행주식'))
      );
      if (!netIncome?.thstrm_amount || !shares?.thstrm_amount) continue;

      const niMillions = parseInt(String(netIncome.thstrm_amount).replace(/[,\s]/g, '')) || 0;
      const sh         = parseInt(String(shares.thstrm_amount).replace(/[,\s]/g, ''))   || 0;
      if (niMillions <= 0 || sh <= 0) continue;

      // 백만원 × 1,000,000 ÷ 주식수 = 원/주(EPS)
      const eps = Math.round(niMillions * 1_000_000 / sh);
      if (eps > 0) return eps;
    } catch (_) {
      continue;  // 네트워크 오류 등 → 다음 후보
    }
  }
  return null;  // 모든 후보 소진 → EPS 없음
}

// ─── 메인 ──────────────────────────────────────────────────────────────────

async function main() {
  if (!DART_KEY) { console.error('[!] DART_API_KEY 없음 — 종료'); process.exit(1); }

  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  console.log(`\n=== DART EPS 업데이트: ${kstNow.toISOString().replace('T', ' ').slice(0, 19)} KST ===\n`);

  // 1. KRX 상장종목 목록
  console.log('[1/4] KRX KOSPI·KOSDAQ 상장종목 조회...');
  let allStocks;
  try   { allStocks = await fetchAllListedStocks(); }
  catch (e) { console.error('[1/4] 실패:', e.message); process.exit(1); }

  // 2. DART corp_code 맵
  console.log('[2/4] DART corp_code 맵 구성 (ZIP 다운로드)...');
  let dartCorpMap;
  try   { dartCorpMap = await fetchDartCorpMap(new Set(allStocks.map(s => s.code))); }
  catch (e) { console.error('[2/4] 실패:', e.message); process.exit(1); }

  // 3. 연결재무제표 → EPS 배치 조회
  const targets = allStocks.filter(s => dartCorpMap[s.code]);
  console.log(`[3/4] DART EPS 조회... (${targets.length}개, 배치 ${BATCH_SIZE}개 × ${BATCH_DELAY}ms)`);
  console.log(`      예상 소요: ~${Math.ceil(targets.length / BATCH_SIZE * BATCH_DELAY / 60000)}분\n`);

  const epsMap = {};
  let processed = 0, succeeded = 0, skipped = 0;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch   = targets.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async s => {
        const eps = await fetchDartEPS(dartCorpMap[s.code]);
        return { code: s.code, name: s.name, eps };
      })
    );
    results.forEach(({ code, eps }) => {
      if (eps !== null) { epsMap[code] = eps; succeeded++; }
      else skipped++;
    });
    processed += batch.length;

    if (processed % 200 === 0 || i + BATCH_SIZE >= targets.length) {
      const pct = ((processed / targets.length) * 100).toFixed(1);
      console.log(`      ${processed}/${targets.length} (${pct}%) | EPS 확보 ${succeeded} / 미확보 ${skipped}`);
    }
    await sleep(BATCH_DELAY);
  }

  // 4. Redis 저장 (TTL 95일 ≈ 분기 주기, 다음 분기 발표 전에 갱신 권장)
  console.log('\n[4/4] Redis dart_eps 저장...');
  const TTL_95D = 95 * 24 * 3600;
  await redisSet('dart_eps', epsMap, TTL_95D);

  const ratio = (succeeded / targets.length * 100).toFixed(1);
  const cands = getReportCandidates();
  console.log(`      저장 완료: ${succeeded}개 (전체 ${targets.length}개 중 ${ratio}%)`);
  console.log(`      우선순위: ${cands.map(c => `${c.year}년 ${c.code}`).join(' → ')}`);
  console.log(`      TTL: 95일 (다음 분기 보고서 제출 전 재실행 권장)`);
  console.log('\n=== 완료 ===\n');
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
