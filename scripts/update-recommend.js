/**
 * 전종목 MA + 기본 정보 분석 업데이트 스크립트
 * - KRX → KOSPI·KOSDAQ 상장종목 목록 (비상장·코넥스 완전 제외)
 * - KIS (FHKST03010100) → 일봉 (거래량, 외인보유율, 외인순매수 포함)
 * - KIS (FHKST01010100) → 시가총액, PER, PBR, EPS, 업종명
 * - DART → 연결 기준 EPS/PER (KIS PER보다 정확)
 * - MA5/MA20/MA60 계산, 스코어링 → Redis 저장
 */

'use strict';

const KV_URL    = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;
const KIS_KEY   = process.env.KIS_APP_KEY;
const KIS_SEC   = process.env.KIS_APP_SECRET;
const DART_KEY  = process.env.DART_API_KEY;

const BATCH_SIZE  = 6;
const BATCH_DELAY = 1200;
const TIMEOUT_MS  = 10000;

const SKIP_KEYWORDS = [
  '기업인수목적', '스팩', 'SPAC', '선박투자회사',
  '부동산투자회사', '인프라투자회사', '위탁관리부동산',
];
const ETF_PREFIX = /^(KODEX|TIGER|ARIRANG|KINDEX|KOSEF|KBSTAR|HANARO|TIMEFOLIO|TREX|FOCUS|PLUS|SOL |ACE )/i;
const ETF_WORD   = /레버리지|인버스|선물|스팩|ETF|리츠|인프라|부동산/;
const isETF = name => ETF_PREFIX.test(name || '') || ETF_WORD.test(name || '');

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
      const name   = cells[0];
      const sector = cells[1] || '';
      const code   = cells[2].replace(/\D/g, '').padStart(6, '0');
      if (!code || !/^\d{6}$/.test(code) || !name) continue;
      if (SKIP_KEYWORDS.some(kw => name.includes(kw))) continue;
      if (isETF(name)) continue;
      stocks.push({ code, name, corp_code: '', market: marketName, sector });
    }
    return stocks;
  };

  const [kospi, kosdaq] = await Promise.all([
    fetchMarket('stockMkt',  'KOSPI'),
    fetchMarket('kosdaqMkt', 'KOSDAQ'),
  ]);

  const all = [...kospi, ...kosdaq];
  console.log(`[krx] KOSPI ${kospi.length}개 + KOSDAQ ${kosdaq.length}개 = 총 ${all.length}개`);
  console.log('[krx] 파싱 샘플:', all.slice(0, 5).map(s => `${s.code}(${s.market}) ${s.name}`).join(', '));
  if (all.length < 1000) throw new Error(`KRX 종목 수 이상 (${all.length}개) — 응답 확인 필요`);
  return all;
}

// ─── DART corp_code 맵 (종목코드 → corp_code) ────────────────────────────

async function fetchDartCorpMap(krxCodes) {
  if (!DART_KEY) return {};
  try {
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
  } catch (e) {
    console.warn('[dart] corp_code 맵 실패:', e.message);
    return {};
  }
}

// ─── DART 연결 재무제표 → PER 계산 ──────────────────────────────────────

async function fetchDartPER(corpCode, price) {
  if (!DART_KEY || !corpCode || !price) return null;
  try {
    // 전년도 연간 결산 (11011 = 사업보고서)
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
    const per = Math.round(price / eps * 10) / 10;
    // 비정상값 제외 (0 이하 또는 500 초과)
    return (per > 0 && per < 500) ? per : null;
  } catch (e) {
    return null;
  }
}

// ─── KIS 일봉 조회 ─────────────────────────────────────────────────────────

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
  const startDt = new Date(now - 240 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice` +
    `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}` +
    `&FID_INPUT_DATE_1=${startDt}&FID_INPUT_DATE_2=${endDt}` +
    `&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;
  return timedFetch(url, { headers: kisHeaders(token, 'FHKST03010100') }).then(r => r.json());
}

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

function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  if (arr.length < period) return out;
  out[period - 1] = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) out[i] = arr[i] * k + out[i - 1] * (1 - k);
  return out;
}

function calcMACDFull(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = closes.map((_, i) =>
    ema12[i] !== null && ema26[i] !== null ? ema12[i] - ema26[i] : null
  );
  const start = macdLine.findIndex(v => v !== null);
  if (start < 0) return null;
  const signal = new Array(closes.length).fill(null);
  const k = 2 / 10;
  let cnt = 0, seed = 0;
  for (let i = start; i < closes.length; i++) {
    if (macdLine[i] === null) continue;
    cnt++;
    seed += macdLine[i];
    if (cnt === 9) { signal[i] = seed / 9; }
    else if (cnt > 9) { signal[i] = macdLine[i] * k + signal[i - 1] * (1 - k); }
  }
  const n = closes.length - 1;
  if (macdLine[n] === null || signal[n] === null) return null;
  const hist = macdLine[n] - signal[n];
  const prevHist = n > 0 && macdLine[n - 1] !== null && signal[n - 1] !== null
    ? macdLine[n - 1] - signal[n - 1] : null;
  return { hist, prevHist };
}

function calcOBVArr(closes, volumes) {
  const obv = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const v = volumes[i] || 0;
    if      (closes[i] > closes[i - 1]) obv[i] = obv[i - 1] + v;
    else if (closes[i] < closes[i - 1]) obv[i] = obv[i - 1] - v;
    else                                 obv[i] = obv[i - 1];
  }
  return obv;
}

function calcBollingerWidths(closes, period = 20) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const s    = closes.slice(i - period + 1, i + 1);
    const mean = s.reduce((a, b) => a + b, 0) / period;
    const std  = Math.sqrt(s.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / period);
    return mean > 0 ? (std * 2 * 2) / mean : null;
  });
}

function calcScore(closes, volumes) {
  const n = closes.length - 1;
  const cur = closes[n];
  if (n < 21 || !cur) return 0;
  let score = 0;

  const ma5a   = calcMAArr(closes, 5);
  const ma20a  = calcMAArr(closes, 20);
  const ma60a  = calcMAArr(closes, Math.min(60,  n + 1));
  const ma120a = calcMAArr(closes, Math.min(120, n + 1));
  const ma5   = ma5a[n]   || 0;
  const ma20  = ma20a[n]  || 0;
  const ma60  = ma60a[n]  || 0;
  const ma120 = ma120a[n] || 0;
  const pm5   = (n > 0 ? ma5a[n - 1]  : 0) || 0;
  const pm20  = (n > 0 ? ma20a[n - 1] : 0) || 0;

  if (ma5 && ma20 && ma60 && ma120 && ma5 > ma20 && ma20 > ma60 && ma60 > ma120)
    score += 20;
  else if (ma5 && ma20 && ma60 && ma5 > ma20 && ma20 > ma60)
    score += 16;
  else if (pm5 && pm20 && ma5 && ma20 && pm5 <= pm20 && ma5 > ma20)
    score += 13;
  else if (ma20 && ma60 && ma20 > ma60)
    score += 8;
  else if (ma5 && ma20 && ma5 > ma20)
    score += 4;

  if (ma20) {
    const d = cur / ma20 * 100;
    if      (d >= 101 && d <= 106)                             score += 20;
    else if ((d >= 100 && d <  101) || (d > 106 && d <= 109)) score += 16;
    else if ((d >=  95 && d < 100)  || (d > 109 && d <= 112)) score += 10;
    else if ((d >=  92 && d <  95)  || (d > 112 && d <= 116)) score += 5;
  }

  const rsiArr = calcRSI(closes);
  const rsi = rsiArr[n];
  if (rsi !== null) {
    if      (rsi >= 58 && rsi <  68) score += 15;
    else if (rsi >= 52 && rsi <  58) score += 10;
    else if (rsi >= 68 && rsi <  73) score += 10;
    else if (rsi >= 47 && rsi <  52) score += 6;
    else if (rsi >= 73)              score += 3;
    else if (rsi >= 40 && rsi <  47) score += 2;
  }

  const macd = calcMACDFull(closes);
  if (macd) {
    if      (macd.hist > 0 && macd.prevHist !== null && macd.hist > macd.prevHist)
      score += 15;
    else if (macd.hist > 0 && macd.prevHist !== null && macd.prevHist > 0 && macd.hist > macd.prevHist * 0.7)
      score += 10;
    else if (macd.hist > 0)
      score += 7;
    else if (macd.hist !== null && macd.prevHist !== null && macd.hist < 0
          && macd.hist > macd.prevHist && macd.hist > macd.prevHist * 0.5)
      score += 5;
    else if (macd.hist !== null && macd.prevHist !== null && macd.hist < 0 && macd.hist > macd.prevHist)
      score += 3;
  }

  if (volumes && volumes.length > 5) {
    const past5 = volumes.slice(Math.max(0, n - 5), n);
    const avg5  = past5.length ? past5.reduce((a, b) => a + b, 0) / past5.length : 0;
    if (avg5 > 0) {
      const ratio = volumes[n] / avg5;
      if      (ratio >= 3.0) score += 15;
      else if (ratio >= 2.0) score += 12;
      else if (ratio >= 1.5) score += 9;
      else if (ratio >= 1.0) score += 6;
      else if (ratio >= 0.7) score += 3;
    }

    const obv    = calcOBVArr(closes, volumes);
    const window = obv.slice(Math.max(0, n - 60), n + 1);
    const obvMax = Math.max(...window);
    if      (obv[n] >= obvMax * 0.98) score += 15;
    else if (obv[n] >= obvMax * 0.90) score += 11;
    else if (obv[n] >= obvMax * 0.80) score += 7;
    else if (obv[n] >= obvMax * 0.65) score += 4;
  }

  const widths = calcBollingerWidths(closes);
  const curW   = widths[n];
  const histW  = widths.slice(Math.max(0, n - 120), n).filter(x => x !== null);
  if (curW !== null && histW.length >= 20) {
    const minW = Math.min(...histW);
    if (curW <= minW * 1.1 && volumes && volumes.length > 5) {
      const vol5 = volumes.slice(Math.max(0, n - 5), n).reduce((a, b) => a + b, 0) / 5;
      const s20  = closes.slice(Math.max(0, n - 19), n + 1);
      const mean = s20.reduce((a, b) => a + b, 0) / s20.length;
      const std  = Math.sqrt(s20.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / s20.length);
      const bollUpper = Math.round(mean + std * 2);
      const bollLower = Math.round(mean - std * 2);
      if (cur > bollUpper && vol5 > 0 && volumes[n] > vol5 * 2) score += 10;
      else if (cur < bollLower)                                   score -= 10;
    }
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

const GROWTH_TIER1 = ['반도체', '방위산업'];
const GROWTH_TIER2 = ['바이오', '의약품', '2차전지', '로봇', '우주항공'];
const GROWTH_TIER3 = ['소프트웨어', '인터넷', '게임', '의료기기', '디스플레이'];
const GROWTH_TIER4 = ['통신장비', '전기장비'];
const GROWTH_SECTOR_KW = [...GROWTH_TIER1, ...GROWTH_TIER2, ...GROWTH_TIER3, ...GROWTH_TIER4];

function sectorGrowthScore(sector) {
  const s = sector || '';
  if (GROWTH_TIER1.some(k => s.includes(k))) return 6;
  if (GROWTH_TIER2.some(k => s.includes(k))) return 5;
  if (GROWTH_TIER3.some(k => s.includes(k))) return 4;
  if (GROWTH_TIER4.some(k => s.includes(k))) return 2;
  return 0;
}

function calcGrowthBonus(sector, d5FrgnInst) {
  const secScore = sectorGrowthScore(sector);
  const buyScore = (typeof d5FrgnInst === 'number' && d5FrgnInst > 0) ? 2 : 0;
  return { total: Math.min(8, secScore + buyScore), secScore, buyScore };
}

function getStockTag(pbr, per, sector) {
  const isGrowthSector = GROWTH_SECTOR_KW.some(k => (sector || '').includes(k));
  if (per > 40 || (isGrowthSector && per > 15)) return 'growth';
  if (pbr > 0 && pbr < 1.2 && per > 0 && per < 18) return 'value';
  return 'neutral';
}

function calcKoreanScore(pbr, per, rsiLatest, closes, sector, d5FrgnInst) {
  const n   = closes.length - 1;
  const cur = closes[n];

  const pbrScore             = pbr > 0 ? Math.max(0, 12 * (1.5 - pbr) / 1.5) : 0;
  const perScore             = per > 0 ? Math.max(0, 8 * (25 - per) / 25) : 0;
  const { total: growthTotal } = calcGrowthBonus(sector, d5FrgnInst);
  const perFinal             = Math.max(perScore, growthTotal);

  const recentHigh = Math.max(...closes.slice(Math.max(0, n - 120), n + 1));
  const drawdown   = recentHigh > 0 ? (recentHigh - cur) / recentHigh * 100 : 0;
  let panicScore = 0;
  if (rsiLatest !== null && rsiLatest !== undefined) {
    if      (rsiLatest < 25 && drawdown >= 30) panicScore = 10;
    else if (rsiLatest < 35 && drawdown >= 20) panicScore = 7;
    else if (rsiLatest < 35)                   panicScore = 4;
    else if (rsiLatest < 40)                   panicScore = 2;
  }

  return Math.round(pbrScore + perFinal + panicScore);
}

function maSignal(price, ma) {
  if (!ma || !price) return 'neutral';
  const r = (price - ma) / ma * 100;
  if (r > 1)  return 'up';
  if (r < -1) return 'down';
  return 'neutral';
}

function analyze(stock, closes, volumes, extra = {}) {
  if (closes.length < 22) return null;
  const n = closes.length - 1, cur = closes[n];
  if (!cur) return null;

  const ma5a  = calcMAArr(closes, 5);
  const ma20a = calcMAArr(closes, 20);
  const ma60a = calcMAArr(closes, Math.min(60, closes.length));

  const ma5  = ma5a[n]  || 0;
  const ma20 = ma20a[n] || 0;
  const ma60 = ma60a[n] || 0;

  const signals = [];

  if (ma5 && ma20 && ma60) {
    if      (ma5 > ma20 && ma20 > ma60) signals.push('정배열 — 단기·중기·장기 모두 우상향');
    else if (ma5 < ma20 && ma20 < ma60) signals.push('역배열 — 하락 추세 지속 주의');
    else if (ma5 > ma20)                signals.push('단기 이평선 상향 — 중기 회복 진행 중');
    else if (ma20 > ma60)               signals.push('중기 이평선 상향 — 장기 추세 전환 시도');
  }
  if (n >= 1) {
    const pm5 = ma5a[n - 1] || 0, pm20 = ma20a[n - 1] || 0;
    if (pm5 && pm20 && ma5 && ma20) {
      if (pm5 <= pm20 && ma5 > ma20) signals.unshift('골든크로스 발생 — 단기 강세 신호 ✓');
      if (pm5 >= pm20 && ma5 < ma20) signals.unshift('데드크로스 발생 — 단기 주의 신호');
    }
  }

  const rsiArr2   = calcRSI(closes);
  const techScore = calcScore(closes, volumes);
  const _d5 = extra.investorSupply?.d5;
  const d5FrgnInst = _d5 ? (_d5.foreign || 0) + (_d5.inst || 0) : null;

  // DART PER 우선, 없으면 KIS PER
  const finalPer  = extra.dartPer ?? extra.per ?? 0;
  const korScore  = calcKoreanScore(extra.pbr || 0, finalPer, rsiArr2[n], closes, extra.sector || '', d5FrgnInst);
  const score     = Math.min(100, Math.round(techScore * 0.7) + korScore);

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
    volume:      extra.volume      || 0,
    avgVol5:     extra.avgVol5     || 0,
    frgnRatio:   extra.frgnRatio   || 0,
    frgnBuyQty:  extra.frgnBuyQty  || 0,
    mktCap:      extra.mktCap      || 0,
    per:         finalPer,          // DART 우선 적용된 PER
    dartPer:     extra.dartPer     ?? null,  // DART PER 원본 (null이면 미확인)
    pbr:         extra.pbr         || 0,
    eps:         extra.eps         || 0,
    stockTag:    getStockTag(extra.pbr || 0, finalPer, extra.sector || ''),
  };
}

// ─── 단일 종목 처리 ────────────────────────────────────────────────────────

async function processStock(token, stock, dartCorpMap = {}) {
  const markets = stock.market ? [stock.market === 'KOSPI' ? 'J' : 'Q'] : ['J', 'Q'];

  for (const mkCode of markets) {
    try {
      const raw = await fetchDailyCandles(token, stock.code, mkCode);
      const rawOutput = raw?.output2 ?? raw?.output;
      if (!rawOutput?.length) continue;

      const recent      = rawOutput.filter(d => parseNum(d.stck_clpr) > 0).slice(0, 150);
      const latestDay   = recent[0];
      const reversed    = recent.slice().reverse();
      const closes      = reversed.map(d => parseNum(d.stck_clpr));
      const volumes     = reversed.map(d => parseNum(d.acml_vol));

      if (closes.length < 22) continue;
      if (!closes[closes.length - 1]) continue;

      const volume     = parseNum(latestDay?.acml_vol);
      const frgnRatio  = parseF(latestDay?.hts_frgn_ehrt);
      const frgnBuyQty = parseNum(latestDay?.frgn_ntby_qty);
      const vLast  = volumes.length - 1;
      const avgVol5 = Math.round(
        volumes.slice(Math.max(0, vLast - 4), vLast + 1).reduce((a, b) => a + b, 0) /
        Math.min(5, vLast + 1)
      );

      let investorSupply = null;
      try {
        const invRaw = await timedFetch(
          `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor` +
          `?fid_cond_mrkt_div_code=${mkCode}&fid_input_iscd=${stock.code}`,
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

      let mktCap = 0, per = 0, pbr = 0, eps = 0, sector = '';
      try {
        const info = await fetchStockInfo(token, stock.code, mkCode);
        const o = info?.output;
        if (o) {
          mktCap = parseNum(o.hts_avls);
          per    = parseF(o.per  || '0');
          pbr    = parseF(o.pbr  || '0');
          eps    = parseF(o.eps  || '0');
          sector = (o.bstp_kor_isnm || o.bstp_kor_isn_nm || '').trim();
        }
      } catch (_) {}

      // ── DART 연결 PER 조회 (KIS PER 보정) ──
      let dartPer = null;
      const corpCode = dartCorpMap[stock.code];
      if (corpCode) {
        dartPer = await fetchDartPER(corpCode, closes[closes.length - 1]);
      }

      const market = mkCode === 'J' ? 'KOSPI' : 'KOSDAQ';
      const result = analyze(
        { ...stock, market },
        closes,
        volumes,
        { volume, frgnRatio, frgnBuyQty, avgVol5, mktCap, per, pbr, eps, sector, investorSupply, dartPer }
      );
      if (result) result.investorSupply = investorSupply;
      return result;

    } catch (e) {
      console.error(`[processStock] ${stock.code}(${stock.market}) 실패:`, e.message);
      continue;
    }
  }
  return null;
}

// ─── 메인 ──────────────────────────────────────────────────────────────────

async function main() {
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  console.log(`\n=== 전종목 MA + 기본정보 분석: ${kstNow.toISOString().replace('T',' ').slice(0,19)} KST ===\n`);

  // 1. KRX 상장종목 목록
  console.log('[1/5] KRX KOSPI·KOSDAQ 상장종목 조회...');
  let allStocks;
  try   { allStocks = await fetchAllListedStocks(); }
  catch (e) { console.error('[1/5] 실패:', e.message); process.exit(1); }

  // 2. DART corp_code 맵 구성
  console.log('[2/5] DART corp_code 맵 구성...');
  let dartCorpMap = {};
  try {
    const krxCodes = new Set(allStocks.map(s => s.code));
    dartCorpMap = await fetchDartCorpMap(krxCodes);
  } catch (e) {
    console.warn('[2/5] DART 맵 실패 (무시):', e.message);
  }

  // 3. KIS 토큰
  console.log('[3/5] KIS 토큰 확인...');
  let token;
  try   { token = await getKisToken(); }
  catch (e) { console.error('[3/5] 실패:', e.message); process.exit(1); }

  // 4. 배치 처리
  console.log(`[4/5] 일봉 + 기본정보 + DART PER 조회... (${allStocks.length}개, 배치 ${BATCH_SIZE}개)`);
  const results = [];
  let processed = 0, failed = 0;

  for (let i = 0; i < allStocks.length; i += BATCH_SIZE) {
    const batch    = allStocks.slice(i, i + BATCH_SIZE);
    const batchRes = await Promise.all(batch.map(s => processStock(token, s, dartCorpMap)));
    batchRes.forEach(r => { if (r) results.push(r); else failed++; });
    processed += batch.length;

    if (processed % 200 === 0 || i + BATCH_SIZE >= allStocks.length) {
      const pct = ((processed / allStocks.length) * 100).toFixed(1);
      console.log(`      ${processed}/${allStocks.length} (${pct}%) | 성공 ${results.length} / 실패 ${failed}`);
    }
    await sleep(BATCH_DELAY);
  }

  // 5. Redis 저장
  console.log('[5/5] Redis 저장...');
  results.sort((a, b) => b.score - a.score);

  const baseDate = kstNow.toISOString().slice(0, 10);
  const payload  = { stocks: results, baseDate, total: results.length, updatedAt: kstNow.toISOString() };

  await redisSet('recommend_v2', payload, 28 * 3600);

  const invMap = {};
  results.forEach(s => { if (s.investorSupply) invMap[s.code] = s.investorSupply; });
  await redisSet('investor_supply', invMap, 28 * 3600);

  const scoreMap = {};
  results.forEach(s => { scoreMap[s.code] = s.score; });
  await redisSet('stock_scores', scoreMap, 28 * 3600);

  // DART PER 맵 저장 (analyze.js에서 읽어서 KIS PER 대신 사용)
  const dartPerMap = {};
  results.forEach(s => { if (s.dartPer !== null && s.dartPer !== undefined) dartPerMap[s.code] = s.dartPer; });
  await redisSet('dart_per', dartPerMap, 28 * 3600);

  const dartCount = Object.keys(dartPerMap).length;
  console.log(`      완료: ${results.length}개 종목 저장`);
  console.log(`      수급 맵 ${Object.keys(invMap).length}개, 점수 맵 ${Object.keys(scoreMap).length}개`);
  console.log(`      DART PER 맵 ${dartCount}개 (전체의 ${(dartCount/results.length*100).toFixed(1)}%)`);
  console.log(`      기준일 ${baseDate}`);
  console.log('\n=== 완료 ===\n');
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
