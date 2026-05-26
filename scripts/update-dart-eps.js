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

// ─── DART 연결재무제표 → EPS 계산 ──────────────────────────────────────────
// 전년도 사업보고서(reprt_code=11011), 연결재무제표(fs_div=CFS)
// EPS = 당기순이익(비지배 제외) ÷ 발행주식수(보통주)
// PER 계산은 analyze.js에서 실시간으로: 현재가 ÷ dart_eps

async function fetchDartEPS(corpCode) {
  try {
    const year = new Date().getFullYear() - 1;
    const url = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json` +
      `?crtfc_key=${DART_KEY}&corp_code=${corpCode}` +
      `&bsns_year=${year}&reprt_code=11011&fs_div=CFS`;

    const data = await timedFetch(url).then(r => r.json()).catch(() => null);
    if (data?.status !== '000') return null;

    const list = data.list || [];

    // 당기순이익 (연결, 비지배 제외)
    const netIncome = list.find(r =>
      r.fs_div === 'CFS' &&
      r.account_nm?.includes('당기순이익') &&
      !r.account_nm?.includes('비지배')
    );
    // 발행주식수 (보통주)
    const shares = list.find(r =>
      r.account_nm?.includes('보통주') &&
      (r.account_nm?.includes('주식수') || r.account_nm?.includes('발행'))
    );

    if (!netIncome?.thstrm_amount || !shares?.thstrm_amount) return null;

    const ni = parseInt(String(netIncome.thstrm_amount).replace(/,/g, '')) || 0;
    const sh = parseInt(String(shares.thstrm_amount).replace(/,/g, ''))   || 0;
    if (ni <= 0 || sh <= 0) return null;

    const eps = Math.round(ni / sh);
    return eps > 0 ? eps : null;
  } catch (e) {
    return null;
  }
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

  // 4. Redis 저장 (TTL 120일 — 다음 분기 발표까지 충분)
  console.log('\n[4/4] Redis dart_eps 저장...');
  const TTL_120D = 120 * 24 * 3600;
  await redisSet('dart_eps', epsMap, TTL_120D);

  const ratio = (succeeded / targets.length * 100).toFixed(1);
  console.log(`      저장 완료: ${succeeded}개 (전체 ${targets.length}개 중 ${ratio}%)`);
  console.log(`      기준연도: ${new Date().getFullYear() - 1}년 사업보고서 (11011)`);
  console.log(`      TTL: 120일`);
  console.log('\n=== 완료 ===\n');
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
