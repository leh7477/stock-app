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
const BATCH_SIZE  = 10;   // 병렬 처리 수 (5→10으로 속도 2배 향상)
const BATCH_DELAY = 800;  // 배치 간 대기(ms) — DART API 부담 최소화

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

// ─── 현재 시점 기준 보고서 후보 목록 (우선순위 순) ────────────────────────
// factor: 분기 누적 EPS → 연간 EPS 환산 배율
//   연간(12개월) ×1 / Q3(9개월) ×(4/3) / 반기(6개월) ×2 / Q1(3개월) ×4
//
// 우선순위: 직전 회계연도 연간보고서 → 최신 분기 연환산
//   · 연간보고서 = 네이버·HTS 등 국내 금융사이트 PER 기준과 동일 (trailing annual)
//   · 분기 연환산 = 연간 보고서 없는 종목(신규상장 등)의 fallback
function getReportCandidates() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;

  const candidates = [];

  // ── 1순위: 직전 회계연도 연간 사업보고서 ────────────────────────────────
  // 3/31 제출 → 4월 이후 확실히 이용 가능 / 네이버 PER 기준과 동일
  const annualYear = month >= 4 ? year - 1 : year - 2;
  candidates.push({ year: annualYear, code: '11011', factor: 1, label: `${annualYear}연간` });

  // ── 2순위: 최신 분기 연환산 (연간 없는 종목 fallback) ────────────────────
  // 제출 기한: Q1=5/15, 반기=8/14, Q3=11/14
  if (month >= 11) candidates.push({ year, code: '11014', factor: 4/3,  label: `${year}Q3` });
  if (month >= 8)  candidates.push({ year, code: '11012', factor: 2,    label: `${year}반기` });
  if (month >= 5)  candidates.push({ year, code: '11013', factor: 4,    label: `${year}Q1` });

  // ── 3순위: 2년 전 연간 (annualYear 보고서도 없는 소규모 기업 대비) ────────
  candidates.push({ year: annualYear - 1, code: '11011', factor: 1, label: `${annualYear-1}연간` });

  return candidates;
}

// ─── DART 연결재무제표 → EPS + 영업이익률 + ROE + EPS성장률 + 매출성장률 + 부채비율 ──
// · 분기 보고서: thstrm_amount(YTD 누적) × factor 로 연간 EPS 환산
// · 연간 보고서: factor=1 (그대로 사용)
// · 영업이익률 = 영업이익 / 매출액 × 100  (비율이므로 factor 불필요)
// · ROE       = 당기순이익 / 자본총계 × 100
// · EPS성장률  = (당기EPS - 전기EPS) / |전기EPS| × 100  (YoY)
// · 매출성장률 = (당기매출 - 전기매출) / |전기매출| × 100  (YoY)
// · 부채비율   = 부채총계 / 자본총계 × 100

function parseAmt(v) { return parseInt(String(v || '0').replace(/[,\s-]/g, '')) || 0; }
function parseSigned(v) { return parseInt(String(v || '0').replace(/[,\s]/g, '')) || 0; }

async function fetchDartFinancials(corpCode) {
  const candidates = getReportCandidates();

  for (const { year, code: reprtCode, factor } of candidates) {
    try {
      const url = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json` +
        `?crtfc_key=${DART_KEY}&corp_code=${corpCode}` +
        `&bsns_year=${year}&reprt_code=${reprtCode}&fs_div=CFS`;

      const data = await timedFetch(url).then(r => r.json()).catch(() => null);
      if (data?.status !== '000') continue;

      const list = data.list || [];
      const isIS  = r => r.sj_div === 'IS'  || r.sj_div === 'CIS';
      const isBS  = r => r.sj_div === 'BS';

      // ── EPS (기본주당이익) ───────────────────────────────────────────────
      const epsItem = list.find(r =>
        isIS(r) &&
        (r.account_nm?.includes('기본주당이익') ||
         r.account_nm?.includes('기본주당순이익') ||
         r.account_nm?.includes('주당순이익'))
      );

      let eps = null, epsGrowth = null;
      if (epsItem?.thstrm_amount) {
        const rawEps  = parseSigned(epsItem.thstrm_amount);
        const prevEps = parseSigned(epsItem.frmtrm_amount);
        if (rawEps > 0) {
          eps = Math.round(rawEps * factor);
          if (prevEps !== 0) {
            epsGrowth = Math.round((rawEps - prevEps) / Math.abs(prevEps) * 100);
          }
        }
      }

      // EPS fallback: 당기순이익 ÷ 발행주식수
      if (eps === null) {
        const niItem = list.find(r =>
          isIS(r) && r.account_nm?.includes('당기순이익') && !r.account_nm?.includes('비지배')
        );
        const shItem = list.find(r =>
          r.account_nm?.includes('보통주') &&
          (r.account_nm?.includes('주식수') || r.account_nm?.includes('발행주식'))
        );
        if (niItem?.thstrm_amount && shItem?.thstrm_amount) {
          const ni = parseAmt(niItem.thstrm_amount);
          const sh = parseAmt(shItem.thstrm_amount);
          if (ni > 0 && sh > 0) eps = Math.round(ni * 1_000_000 / sh * factor);
        }
      }

      if (eps === null || eps <= 0) continue;  // EPS 없으면 이 보고서 스킵

      // ── 영업이익률 ───────────────────────────────────────────────────────
      let operatingMargin = null;
      const opItem = list.find(r =>
        isIS(r) &&
        r.account_nm?.includes('영업이익') &&
        !r.account_nm?.includes('잉여금') &&
        !r.account_nm?.includes('손실')
      );
      const revItem = list.find(r =>
        isIS(r) &&
        (r.account_nm === '매출액' ||
         r.account_nm?.includes('수익(매출액)') ||
         r.account_nm === '영업수익')
      );
      if (opItem?.thstrm_amount && revItem?.thstrm_amount) {
        const op  = parseSigned(opItem.thstrm_amount);
        const rev = parseAmt(revItem.thstrm_amount);
        if (rev > 0) operatingMargin = Math.round(op / rev * 1000) / 10;  // 소수점 1자리
      }

      // ── ROE ──────────────────────────────────────────────────────────────
      let roe = null;
      const niItem2 = list.find(r =>
        isIS(r) && r.account_nm?.includes('당기순이익') && !r.account_nm?.includes('비지배')
      );
      const eqItem = list.find(r =>
        isBS(r) &&
        (r.account_nm === '자본총계' || r.account_nm?.includes('지배기업 소유주지분'))
      );
      if (niItem2?.thstrm_amount && eqItem?.thstrm_amount) {
        const ni = parseSigned(niItem2.thstrm_amount);
        const eq = parseAmt(eqItem.thstrm_amount);
        if (eq > 0) roe = Math.round(ni / eq * 1000) / 10;
      }

      // ── 매출 성장률 (YoY) ────────────────────────────────────────────────
      let revenueGrowth = null;
      if (revItem?.thstrm_amount && revItem?.frmtrm_amount) {
        const curRev  = parseAmt(revItem.thstrm_amount);
        const prevRev = parseAmt(revItem.frmtrm_amount);
        if (prevRev > 0) revenueGrowth = Math.round((curRev - prevRev) / prevRev * 1000) / 10;
      }

      // ── 부채비율 = 부채총계 / 자본총계 × 100 ────────────────────────────
      let debtRatio = null;
      const debtItem = list.find(r => isBS(r) && r.account_nm === '부채총계');
      if (debtItem?.thstrm_amount && eqItem?.thstrm_amount) {
        const debt = parseAmt(debtItem.thstrm_amount);
        const eq2  = parseAmt(eqItem.thstrm_amount);
        if (eq2 > 0) debtRatio = Math.round(debt / eq2 * 1000) / 10;
      }

      return { eps, epsGrowth, operatingMargin, roe, revenueGrowth, debtRatio };

    } catch (_) {
      continue;
    }
  }
  return null;  // 모든 후보 소진
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

  // 3. 연결재무제표 → EPS + 재무지표 배치 조회
  const targets = allStocks.filter(s => dartCorpMap[s.code]);
  console.log(`[3/4] DART 재무 조회... (${targets.length}개, 배치 ${BATCH_SIZE}개 × ${BATCH_DELAY}ms)`);
  console.log(`      예상 소요: ~${Math.ceil(targets.length / BATCH_SIZE * (BATCH_DELAY + 2000) / 60000)}분 (API 호출 포함 추정)\n`);

  const epsMap        = {};   // dart_eps (기존 키, 하위호환)
  const financialsMap = {};   // dart_financials (신규 — EPS+성장률+영업이익률+ROE)
  let processed = 0, succeeded = 0, skipped = 0;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch   = targets.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async s => {
        const fin = await fetchDartFinancials(dartCorpMap[s.code]);
        return { code: s.code, name: s.name, fin };
      })
    );
    results.forEach(({ code, fin }) => {
      if (fin !== null) {
        epsMap[code]        = fin.eps;   // 하위호환
        financialsMap[code] = fin;       // { eps, epsGrowth, operatingMargin, roe }
        succeeded++;
      } else skipped++;
    });
    processed += batch.length;

    if (processed % 200 === 0 || i + BATCH_SIZE >= targets.length) {
      const pct = ((processed / targets.length) * 100).toFixed(1);
      console.log(`      ${processed}/${targets.length} (${pct}%) | EPS 확보 ${succeeded} / 미확보 ${skipped}`);
    }
    await sleep(BATCH_DELAY);
  }

  // 4. Redis 저장 (TTL 95일 ≈ 분기 주기)
  console.log('\n[4/4] Redis 저장...');
  const TTL_95D = 95 * 24 * 3600;
  await redisSet('dart_eps',        epsMap,        TTL_95D);  // 하위호환
  await redisSet('dart_financials', financialsMap, TTL_95D);  // EPS+성장률+영업이익률+ROE
  const ratio = (succeeded / targets.length * 100).toFixed(1);
  const cands = getReportCandidates();
  console.log(`      dart_eps: ${Object.keys(epsMap).length}개 / dart_financials: ${Object.keys(financialsMap).length}개`);
  console.log(`      저장 완료: ${succeeded}개 (전체 ${targets.length}개 중 ${ratio}%)`);
  console.log(`      우선순위: ${cands.map(c => `${c.year}년 ${c.code}`).join(' → ')}`);
  console.log(`      TTL: 95일 (다음 분기 보고서 제출 전 재실행 권장)`);
  console.log('\n=== 완료 ===\n');
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
