const TIMEOUT_MS = 8000;

const STOCK_MAP = {
  '삼성전자':'005930','sk하이닉스':'000660','하이닉스':'000660',
  'lg에너지솔루션':'373220','lg에너지':'373220',
  '삼성바이오로직스':'207940','삼성바이오':'207940',
  '현대차':'005380','현대자동차':'005380',
  '셀트리온':'068270','기아':'000270','기아차':'000270',
  'kb금융':'105560','신한지주':'055550','하나금융':'086790',
  '포스코':'005490','posco':'005490','posco홀딩스':'005490',
  '카카오':'035720','네이버':'035420','naver':'035420',
  'lg화학':'051910','sk이노베이션':'096770',
  '현대모비스':'012330','삼성물산':'028260','lg전자':'066570',
  'sk텔레콤':'017670','kt':'030200','lg유플러스':'032640',
  '한국전력':'015760','한전':'015760',
  '크래프톤':'259960','엔씨소프트':'036570',
  '카카오뱅크':'323410','카카오페이':'377300',
  '현대제철':'004020','고려아연':'010130',
  '두산에너빌리티':'034020','한화에어로스페이스':'012450',
  '삼성전기':'009150','삼성sds':'018260',
};

// 종목코드 → 공식 한글명 (KIS API가 이름을 못 돌려줄 때 fallback)
const CODE_TO_NAME = {
  '005930':'삼성전자','000660':'SK하이닉스','373220':'LG에너지솔루션',
  '207940':'삼성바이오로직스','005380':'현대차','068270':'셀트리온',
  '000270':'기아','105560':'KB금융','055550':'신한지주','086790':'하나금융지주',
  '005490':'POSCO홀딩스','035720':'카카오','035420':'NAVER',
  '051910':'LG화학','096770':'SK이노베이션','012330':'현대모비스',
  '028260':'삼성물산','066570':'LG전자','017670':'SK텔레콤',
  '030200':'KT','032640':'LG유플러스','015760':'한국전력',
  '259960':'크래프톤','036570':'엔씨소프트','323410':'카카오뱅크',
  '377300':'카카오페이','004020':'현대제철','010130':'고려아연',
  '034020':'두산에너빌리티','012450':'한화에어로스페이스',
  '009150':'삼성전기','018260':'삼성SDS',
};

async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) { clearTimeout(id); throw e; }
}

async function getKisToken() {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  const cached = await timedFetch(`${redisUrl}/get/kis_token`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  }).then(r => r.json());
  if (cached.result) return cached.result;

  const data = await timedFetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type:'client_credentials', appkey:process.env.KIS_APP_KEY, appsecret:process.env.KIS_APP_SECRET }),
  }).then(r => r.json());
  const token = data.access_token;
  if (!token) throw new Error('KIS 토큰 실패');
  await timedFetch(`${redisUrl}/pipeline`, {
    method:'POST',
    headers:{ Authorization:`Bearer ${redisToken}`, 'Content-Type':'application/json' },
    body: JSON.stringify([['SET','kis_token',token,'EX','82800']]),
  });
  return token;
}

function parseNum(s) { return parseInt(String(s||'0').replace(/,/g,''))||0; }
function parseF(s)   { return parseFloat(String(s||'0').replace(/,/g,''))||0; }

function calcMA(arr, n) {
  return arr.map((_, i) => {
    if (i < n - 1) return null;
    const s = arr.slice(i - n + 1, i + 1);
    return Math.round(s.reduce((a,b)=>a+b,0)/n);
  });
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gainSum += d; else lossSum -= d;
  }
  let ag = gainSum / period, al = lossSum / period;
  rsi[period] = al === 0 ? 100 : Math.round((100 - 100/(1+ag/al))*10)/10;
  for (let i = period+1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag*(period-1)+(d>0?d:0))/period;
    al = (al*(period-1)+(d<0?-d:0))/period;
    rsi[i] = al === 0 ? 100 : Math.round((100-100/(1+ag/al))*10)/10;
  }
  return rsi;
}

function calcBollinger(closes, period = 20, mult = 2) {
  const upper=[], mid=[], lower=[];
  closes.forEach((_, i) => {
    if (i < period-1) { upper.push(null); mid.push(null); lower.push(null); return; }
    const s = closes.slice(i-period+1, i+1);
    const mean = s.reduce((a,b)=>a+b,0)/period;
    const std = Math.sqrt(s.map(x=>(x-mean)**2).reduce((a,b)=>a+b,0)/period);
    upper.push(Math.round(mean+mult*std));
    mid.push(Math.round(mean));
    lower.push(Math.round(mean-mult*std));
  });
  return { upper, mid, lower };
}

// ── EMA / MACD / OBV ──────────────────────────────────────────────────────
function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  if (arr.length < period) return out;
  out[period - 1] = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) out[i] = arr[i] * k + out[i-1] * (1-k);
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
    else if (cnt > 9) { signal[i] = macdLine[i] * k + signal[i-1] * (1-k); }
  }
  const n = closes.length - 1;
  if (macdLine[n] === null || signal[n] === null) return null;
  const hist = macdLine[n] - signal[n];
  const prevHist = n > 0 && macdLine[n-1] !== null && signal[n-1] !== null
    ? macdLine[n-1] - signal[n-1] : null;
  return { hist, prevHist };
}

function calcOBVArr(closes, volumes) {
  const obv = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const v = volumes[i] || 0;
    if      (closes[i] > closes[i-1]) obv[i] = obv[i-1] + v;
    else if (closes[i] < closes[i-1]) obv[i] = obv[i-1] - v;
    else                               obv[i] = obv[i-1];
  }
  return obv;
}

// ── 점수 계산 (최고 100점 / 최악 0점) ───────────────────────────────────────
// 추세(40) + 모멘텀(30) + 수급(30) + 볼린저스퀴즈 보너스/패널티(±10)
function calcScore(closes, volumes, boll) {
  const n = closes.length - 1;
  const cur = closes[n];
  if (n < 21 || !cur) return 0;
  let score = 0;

  // ── 1. 추세 구조 (40점) ─────────────────────────────────────────────────
  const ma5a   = calcMA(closes, 5);
  const ma20a  = calcMA(closes, 20);
  const ma60a  = calcMA(closes, Math.min(60,  n+1));
  const ma120a = calcMA(closes, Math.min(120, n+1));
  const ma5   = ma5a[n]   || 0;
  const ma20  = ma20a[n]  || 0;
  const ma60  = ma60a[n]  || 0;
  const ma120 = ma120a[n] || 0;
  const pm5   = (n > 0 ? ma5a[n-1]  : 0) || 0;
  const pm20  = (n > 0 ? ma20a[n-1] : 0) || 0;

  // 1a. 이평선 배열 (20점) — 5단계
  if (ma5 && ma20 && ma60 && ma120 && ma5 > ma20 && ma20 > ma60 && ma60 > ma120)
    score += 20; // 완벽 정배열 5>20>60>120
  else if (ma5 && ma20 && ma60 && ma5 > ma20 && ma20 > ma60)
    score += 16; // 3선 정배열 5>20>60
  else if (pm5 && pm20 && ma5 && ma20 && pm5 <= pm20 && ma5 > ma20)
    score += 13; // 골든크로스
  else if (ma20 && ma60 && ma20 > ma60)
    score += 8;  // 중기 정배열 20>60
  else if (ma5 && ma20 && ma5 > ma20)
    score += 4;  // 단기 우위

  // 1b. MA20 이격도 (20점) — 5단계
  if (ma20) {
    const d = cur / ma20 * 100;
    if      (d >= 101 && d <= 106)                             score += 20; // 이상적 상승권
    else if ((d >= 100 && d <  101) || (d > 106 && d <= 109)) score += 16; // 안정 상승
    else if ((d >=  95 && d < 100)  || (d > 109 && d <= 112)) score += 10; // 소폭 이탈/과열
    else if ((d >=  92 && d <  95)  || (d > 112 && d <= 116)) score += 5;  // 중간 이탈/과열
    // 92% 미만 or 116% 초과: 0점
  }

  // ── 2. 모멘텀 (30점) ────────────────────────────────────────────────────
  // 2a. RSI (15점) — 6단계
  const rsiArr = calcRSI(closes);
  const rsi = rsiArr[n];
  if (rsi !== null) {
    if      (rsi >= 58 && rsi <  68) score += 15; // 최적 상승
    else if (rsi >= 52 && rsi <  58) score += 10; // 강세
    else if (rsi >= 68 && rsi <  73) score += 10; // 과매수 초입
    else if (rsi >= 47 && rsi <  52) score += 6;  // 중립
    else if (rsi >= 73)              score += 3;  // 과매수
    else if (rsi >= 40 && rsi <  47) score += 2;  // 약세
    // RSI < 40: 0점
  }

  // 2b. MACD (15점) — 5단계
  const macd = calcMACDFull(closes);
  if (macd) {
    if      (macd.hist > 0 && macd.prevHist !== null && macd.hist > macd.prevHist)
      score += 15; // 양수 확장 (양전환 포함)
    else if (macd.hist > 0 && macd.prevHist !== null && macd.prevHist > 0 && macd.hist > macd.prevHist * 0.7)
      score += 10; // 양수 미미 축소 (70% 이상 유지)
    else if (macd.hist > 0)
      score += 7;  // 양수 강한 축소
    else if (macd.hist !== null && macd.prevHist !== null && macd.hist < 0
          && macd.hist > macd.prevHist && macd.hist > macd.prevHist * 0.5)
      score += 5;  // 음수 강하게 수축
    else if (macd.hist !== null && macd.prevHist !== null && macd.hist < 0 && macd.hist > macd.prevHist)
      score += 3;  // 음수 수축
    // 음수 확장: 0점
  }

  // ── 3. 거래량 수급 (30점) ───────────────────────────────────────────────
  if (volumes && volumes.length > 5) {
    // 3a. 거래량 5일 평균 대비 (15점) — 6단계
    const past5 = volumes.slice(Math.max(0, n-5), n);
    const avg5  = past5.length ? past5.reduce((a,b)=>a+b,0) / past5.length : 0;
    if (avg5 > 0) {
      const ratio = volumes[n] / avg5;
      if      (ratio >= 3.0) score += 15; // 폭발적
      else if (ratio >= 2.0) score += 12; // 세력 개입
      else if (ratio >= 1.5) score += 9;  // 강한 관심
      else if (ratio >= 1.0) score += 6;  // 평균 이상
      else if (ratio >= 0.7) score += 3;  // 소폭 미달
      // 70% 미만: 0점
    }

    // 3b. OBV 60일 최고치 대비 (15점) — 5단계
    const obv     = calcOBVArr(closes, volumes);
    const window  = obv.slice(Math.max(0, n-60), n+1);
    const obvMax  = Math.max(...window);
    if      (obv[n] >= obvMax * 0.98) score += 15; // 신고치 갱신
    else if (obv[n] >= obvMax * 0.90) score += 11; // 최고치 근접
    else if (obv[n] >= obvMax * 0.80) score += 7;  // 접근
    else if (obv[n] >= obvMax * 0.65) score += 4;  // 중간
    // 65% 미만: 0점
  }

  // ── 볼린저 심리 레이어 — 공포/탐욕 양방향 (±10점) ─────────────────────
  // IV(내재변동성) 대용: BB width → 공포 클라이맥스 + 탐욕 과열 양방향 감지
  // "불안할 때 기회, 안도·탐욕할 때 위험" — 김민겸 IQC 우승 핵심 철학 적용
  if (boll?.upper && volumes?.length > 5) {
    const widths = boll.upper.map((u, i) =>
      u && boll.lower[i] && boll.mid[i] ? (u - boll.lower[i]) / boll.mid[i] : null
    );
    const curW  = widths[n];
    const histW = widths.slice(Math.max(0, n-120), n).filter(x => x !== null);
    if (curW !== null && histW.length >= 20) {
      const minW = Math.min(...histW);
      const vol5 = volumes.slice(Math.max(0, n-5), n).reduce((a,b)=>a+b,0) / 5;

      // [공포] 스퀴즈 후 방향성 돌파 (기존 유지)
      if (curW <= minW * 1.1) {
        if (boll.upper[n] && cur > boll.upper[n] && vol5 > 0 && volumes[n] > vol5 * 2)
          score += 10; // 스퀴즈 상방 대량 돌파
        else if (boll.lower[n] && cur < boll.lower[n])
          score -= 10; // 스퀴즈 하방 붕괴
      }

      // [탐욕 과열 감지] RSI 극과매수 + 거래량 소멸 → 역발상 경고 ★
      // "사람들이 안도·탐욕할 때 오히려 위험" — 김민겸 IV 역발상
      if (rsi !== null && rsi >= 75 && vol5 > 0) {
        const isVolDrying = volumes[n] < vol5 * 0.7;  // 거래량 30% 이상 소멸
        const isBBNarrow  = curW <= minW * 1.5;        // BB 역사적 저변동 구간
        if      (rsi >= 80 && isVolDrying && isBBNarrow) score -= 6; // 극단 탐욕
        else if (rsi >= 78 && isVolDrying)                score -= 4; // 강한 탐욕
        else if (rsi >= 75 && isVolDrying)                score -= 3; // 과열 경고
        else if (rsi >= 80)                               score -= 2; // RSI 극단
      }
    }
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── 국장 특화 스코어 (30점) ─────────────────────────────────────────────────
// PBR 저평가(12) + max(PER저평가, 미래성장가점)(8) + 패닉셀링 감지(10)

// 성장 섹터 등급 (이평선 배열과 겹치지 않는 독립 지표)
// Tier1=6점: 국장 최고 성장 테마 / Tier2=5점 / Tier3=4점 / Tier4=2점 / 일반=0점
const GROWTH_TIER1 = ['반도체', '방위산업'];
const GROWTH_TIER2 = ['바이오', '의약품', '2차전지', '로봇', '우주항공'];
const GROWTH_TIER3 = ['소프트웨어', '인터넷', '게임', '의료기기', '디스플레이'];
const GROWTH_TIER4 = ['통신장비', '전기장비'];
const GROWTH_SECTOR_KW = [...GROWTH_TIER1, ...GROWTH_TIER2, ...GROWTH_TIER3, ...GROWTH_TIER4];

// 회사명 직접 화이트리스트 (KIS 업종 분류 오류 보완)
// 예: 삼성전자·SK하이닉스 → KIS 업종 "전기·전자" (반도체 아님) → 이름으로 직접 매핑
const TIER1_STOCK_NAMES = [
  // ── 반도체 ────────────────────────────────────────────────────────────
  '삼성전자', 'SK하이닉스', 'DB하이텍', '한미반도체', '피에스케이', '피에스케이홀딩스',
  '이오테크닉스', '원익IPS', '주성엔지니어링', '유진테크', '에프에스티', '두산테스나',
  '에스티아이', '싸이맥스', '파크시스템스', '예스티', '테스', '브이엠', 'SFA반도체',
  '원익머트리얼즈', '솔브레인', '이엔에프테크놀로지', '리노공업', '네패스', '네패스아크',
  '제주반도체', '어보브반도체', '퀄리타스반도체', '가온칩스', '칩스앤미디어', '텔레칩스',
  '하나마이크론', '심텍', '이수페타시스', '대덕전자', '코리아써키트', '뱅크웨어글로벌',
  // ── 방산 ──────────────────────────────────────────────────────────────
  '한화에어로스페이스', 'LIG넥스원', '현대로템', '한화시스템', '한화오션',
  '한국항공우주', '풍산', '빅텍', '퍼스텍', '스페코', '한일단조', '아이쓰리시스템',
];

// 섹터 점수만 반환 (0~14점) — 이름 화이트리스트 우선, 업종명 보조
// T1=14: 반도체·방산(국장 최고 성장 테마)
// T2=11: 바이오·2차전지·로봇·우주항공
// T3=8:  소프트웨어·인터넷·게임·의료기기
// T4=4:  통신장비·전기장비
function sectorGrowthScore(sector, name = '') {
  const nm = (name || '').trim();
  const s  = sector || '';
  // 이름 화이트리스트 우선 체크 (업종 오분류 대형주 보완)
  if (nm && TIER1_STOCK_NAMES.includes(nm)) return 14;
  if (GROWTH_TIER1.some(k => s.includes(k))) return 14;
  if (GROWTH_TIER2.some(k => s.includes(k))) return 11;
  if (GROWTH_TIER3.some(k => s.includes(k))) return 8;
  if (GROWTH_TIER4.some(k => s.includes(k))) return 4;
  return 0;
}

// 미래 성장성 가점 (최대 14점)
// = 성장 섹터 등급(0~14) + 외인+기관 5일 순매수 방향(0~4)
// 이평선 배열은 기술지표 70점에 이미 반영 → 여기선 사용 안 함
function calcGrowthBonus(sector, d5FrgnInst, name = '') {
  const secScore = sectorGrowthScore(sector, name);
  const buyScore = (typeof d5FrgnInst === 'number' && d5FrgnInst > 0) ? 4 : 0;
  return { total: Math.min(14, secScore + buyScore), secScore, buyScore };
}

// 종목 성격 태그: 'value' | 'growth' | 'neutral'
function getStockTag(pbr, per, sector, name = '') {
  const nm = (name || '').trim();
  const isGrowthSector = GROWTH_SECTOR_KW.some(k => (sector || '').includes(k))
    || (nm && TIER1_STOCK_NAMES.includes(nm));
  if (per > 40 || (isGrowthSector && per > 15)) return 'growth';
  if (pbr > 0 && pbr < 1.2 && per > 0 && per < 18) return 'value';
  return 'neutral';
}

// ─── 공시 모멘텀 (-2 ~ +2점) ───────────────────────────────────────────────
// 뉴스 모멘텀 전략의 국장 적용 — DART 최근 공시 호재/악재 자동 감지
// 김민겸 IQC 우승: "종가·재무제표 외 뉴스 데이터를 팩터로 수치화"
const DISC_GOOD_KW = ['수주', '계약체결', '흑자전환', '증가', '승인', '완료', '특허', '임상성공', '수상'];
const DISC_BAD_KW  = ['손실', '적자', '감소', '소송', '횡령', '조사', '회수', '불성실공시', '영업정지'];

function calcDisclosureBonus(disclosures) {
  if (!Array.isArray(disclosures) || disclosures.length === 0) return 0;
  let pts = 0;
  for (const d of disclosures) {
    const nm = d.reportName || '';
    if (DISC_GOOD_KW.some(k => nm.includes(k))) pts += 1;
    if (DISC_BAD_KW.some(k => nm.includes(k)))  pts -= 1;
  }
  return Math.max(-2, Math.min(2, pts));
}

// ─── 국장 특화 스코어 → 객체 반환 (total + 세부 컴포넌트) ─────────────────
// PBR(8) + max(PER저평가[10], 섹터프리미엄[14])(14) + 수급(4) + 공포보너스(+4) + 공시(±2)
// 슈퍼사이클 주도주(삼성전자·하이닉스 등)도 90점대 진입 가능한 구조
function calcKoreanScore(pbr, per, rsiLatest, closes, sector, d5FrgnInst, disclosures = [], stockName = '') {
  const n   = closes.length - 1;
  const cur = closes[n];

  // PBR 저평가 (최대 8점) — 선형: PBR 0배=8점, 1.5배=0점
  const pbrScore = pbr > 0 ? Math.max(0, 8 * (1.5 - pbr) / 1.5) : 0;

  // 섹터 프리미엄 vs PER 저평가 (최대 14점, 높은 값 선택)
  // 반도체/방산 슈퍼사이클(14점) ↔ 극도 저평가 가치주(PER≤8배, ~10점)
  const secScore  = sectorGrowthScore(sector, stockName);
  const perScore  = per > 0 ? Math.max(0, 10 * (25 - per) / 25) : 0;
  const perFinal  = Math.max(perScore, secScore);

  // 수급 모멘텀 (최대 4점) — 외인+기관 5일 순매수 방향
  const supplyScore = (typeof d5FrgnInst === 'number' && d5FrgnInst > 0) ? 4 : 0;

  // BB width로 내재변동성(IV) 근사 → 공포 클라이맥스 감지
  const recentHigh = Math.max(...closes.slice(Math.max(0, n - 120), n + 1));
  const drawdown   = recentHigh > 0 ? (recentHigh - cur) / recentHigh * 100 : 0;

  const boll2    = calcBollinger(closes);
  const bbWidths = boll2.upper.map((u, i) =>
    (u && boll2.lower[i] && boll2.mid[i]) ? (u - boll2.lower[i]) / boll2.mid[i] : null
  );
  const curBBW  = bbWidths[n];
  const histBBW = bbWidths.slice(Math.max(0, n - 120), n).filter(x => x !== null);
  const maxBBW  = histBBW.length >= 10 ? Math.max(...histBBW) : null;
  const isIVExtreme = maxBBW !== null && curBBW !== null && curBBW >= maxBBW * 0.80;

  // 공포 클라이맥스 (보너스 +4점) — 기술지표 강세와 충돌하지 않도록 보너스 방식
  let panicScore = 0;
  if (rsiLatest !== null && rsiLatest !== undefined) {
    if      (rsiLatest < 25 && drawdown >= 30)                panicScore = 4;
    else if (rsiLatest < 30 && drawdown >= 25 && isIVExtreme) panicScore = 4;
    else if (rsiLatest < 35 && drawdown >= 20)                panicScore = 3;
    else if (rsiLatest < 35 && isIVExtreme)                   panicScore = 3;
    else if (rsiLatest < 35)                                  panicScore = 2;
    else if (rsiLatest < 40)                                  panicScore = 1;
  }

  // 공시 모멘텀 (-2 ~ +2점)
  const discScore = calcDisclosureBonus(disclosures);

  const total = Math.min(30, Math.round(pbrScore + perFinal + supplyScore + panicScore + discScore));
  return { total,
           pbrScore:    Math.round(pbrScore * 10) / 10,
           perScore:    Math.round(perScore * 10) / 10,
           perFinal:    Math.round(perFinal * 10) / 10,
           supplyScore, panicScore, discScore, drawdown, isIVExtreme };
}

function calcRecommend(cur, ma5, ma20, supportNum, resistanceNum, score) {
  // 7:3 스코어링 기준: 기술지표 최대 70점 + 국장특화 최대 30점
  // 기술적으로 좋은 대형주(국장특화 0점)는 43~49점대가 정상 → neutral 임계값 하향
  const grade = score >= 68 ? 'bull' : score >= 40 ? 'neutral' : 'bear';
  if (grade === 'bear') {
    const bearReason = (ma5 && ma20 && ma5 < ma20) ? '이평선 하락 추세' : '종합 점수 미달 (지지선 확인 후 재진입)';
    return { grade, label: '매수 비추천', reason: bearReason, color: '#ef4444' };
  }
  const ref     = grade === 'bull' ? (ma5 || cur) : (ma20 || cur);
  const buyLow  = Math.round(ref * 0.985);
  const buyHigh = Math.round(ref * 1.005);
  const target  = resistanceNum > cur ? resistanceNum : Math.round(cur * 1.07);
  const stop    = Math.round(Math.max(supportNum * 0.97, buyLow * 0.92));
  return {
    grade, color: grade === 'bull' ? '#22c55e' : '#f59e0b',
    label: grade === 'bull' ? '매수 유리' : '조건부 매수',
    reason: grade === 'bull' ? 'MA5 기준 (단기 지지)' : 'MA20 기준 (중기 지지)',
    buyLow, buyHigh, target, stop,
    gainPct: ((target - buyLow) / buyLow * 100).toFixed(1),
    lossPct: ((buyLow - stop)   / buyLow * 100).toFixed(1),
  };
}

function buildChecklist(closes, ma5arr, ma20arr, ma60arr, rsiArr) {
  const n   = closes.length - 1;
  const cur = closes[n];
  const ma5  = ma5arr[n]  || 0;
  const ma20 = ma20arr[n] || 0;
  const ma60 = ma60arr[n] || 0;
  const rsi  = rsiArr[n];
  const pm5  = (n >= 1 ? ma5arr[n-1]  : 0) || 0;
  const pm20 = (n >= 1 ? ma20arr[n-1] : 0) || 0;

  const isGolden  = pm5 && pm20 && ma5 && ma20 && pm5 <= pm20 && ma5 > ma20;
  const isDead    = pm5 && pm20 && ma5 && ma20 && pm5 >= pm20 && ma5 < ma20;
  const isPerfect = ma5 && ma20 && ma60 && ma5 > ma20 && ma20 > ma60;
  const isReverse = ma5 && ma20 && ma60 && ma5 < ma20 && ma20 < ma60;
  const aboveAll  = ma5 && ma20 && cur > ma5 && cur > ma20;
  const aboveSome = !aboveAll && ((ma5 && cur > ma5) || (ma20 && cur > ma20));
  const supportNum    = Math.min(...closes.slice(-20));
  const supportGapPct = (cur - supportNum) / cur * 100;

  return [
    {
      status: isPerfect ? 'ok' : isReverse ? 'fail' : 'warn',
      label: '이평선 배열',
      desc:  isPerfect ? '정배열 — 5일>20일>60일, 강한 상승 추세' :
             isReverse ? '역배열 — 하락 추세 진행 중, 매수 주의' :
                         '혼조 배열 — 추세 불명확, 관망 권장',
    },
    {
      status: aboveAll ? 'ok' : aboveSome ? 'warn' : 'fail',
      label: '현재가 위치',
      desc:  aboveAll  ? 'MA5·MA20 모두 위 — 단기·중기 모두 강세' :
             aboveSome ? '일부 이평선 위 — 혼조세, 추이 확인 필요' :
                         '이평선 아래 — 매도 압력 우세',
    },
    {
      status: rsi === null ? 'warn' : rsi < 30 ? 'ok' : rsi > 70 ? 'warn' : rsi >= 50 ? 'ok' : 'warn',
      label: 'RSI 모멘텀',
      desc:  rsi === null ? 'RSI 계산 불가 (데이터 부족)' :
             rsi < 30    ? `RSI ${rsi} — 과매도 구간, 반등 가능성` :
             rsi > 70    ? `RSI ${rsi} — 과매수 구간, 조정 주의` :
             rsi >= 50   ? `RSI ${rsi} — 강세 흐름 유지` :
                           `RSI ${rsi} — 약세 흐름, 하락 압력`,
    },
    {
      status: isGolden ? 'ok' : isDead ? 'fail' : 'warn',
      label: '크로스 신호',
      desc:  isGolden ? '골든크로스 발생 — 단기 매수 신호, 상승 전환 기대' :
             isDead   ? '데드크로스 발생 — 하락 전환 신호, 손절 검토' :
                        '크로스 없음 — 현재 추세 지속 중',
    },
    {
      status: supportGapPct > 7 ? 'ok' : supportGapPct > 3 ? 'warn' : 'fail',
      label: '손절 여유',
      desc:  `20일 지지선 ${supportNum.toLocaleString()}원 · 현재가에서 -${supportGapPct.toFixed(1)}% 아래`,
    },
  ];
}

function buildAnalysis(closes, ma5arr, ma20arr, ma60arr, rsiArr) {
  const n = closes.length - 1;
  const cur = closes[n];
  const ma5 = ma5arr[n], ma20 = ma20arr[n], ma60 = ma60arr[n];
  const currentRSI = rsiArr[n];

  const signals = [];
  let bull = 0, bear = 0;

  if (ma5 && ma20 && ma60) {
    if (ma5 > ma20 && ma20 > ma60) { signals.push('정배열 — 강한 상승 추세'); bull += 3; }
    else if (ma5 < ma20 && ma20 < ma60) { signals.push('역배열 — 강한 하락 추세'); bear += 3; }
    if (cur > ma5 && ma5 > ma20) { signals.push('단기 이평선 위 — 상승 흐름'); bull += 2; }
    else if (cur < ma5 && ma5 < ma20) { signals.push('단기 이평선 아래 — 하락 흐름'); bear += 2; }
  }

  if (currentRSI !== null) {
    if (currentRSI >= 70) { signals.push(`RSI ${currentRSI} — 과매수 구간`); bear += 2; }
    else if (currentRSI <= 30) { signals.push(`RSI ${currentRSI} — 과매도 구간`); bull += 2; }
    else if (currentRSI > 55) { signals.push(`RSI ${currentRSI} — 강세 흐름`); bull += 1; }
    else if (currentRSI < 45) { signals.push(`RSI ${currentRSI} — 약세 흐름`); bear += 1; }
  }

  const highs  = closes.slice(-20);
  const lows   = closes.slice(-20);
  const resistance = Math.max(...highs);
  const support    = Math.min(...lows);

  let opinion, opinionColor;
  if (bull > bear + 2)      { opinion='매수 우위'; opinionColor='#22c55e'; }
  else if (bear > bull + 2) { opinion='매도 우위'; opinionColor='#ef4444'; }
  else                      { opinion='중립 / 관망'; opinionColor='#f59e0b'; }

  return {
    opinion, opinionColor, signals: signals.slice(0,4),
    bull, bear, currentRSI,
    ma5:  ma5  ? ma5.toLocaleString()  : '-',
    ma20: ma20 ? ma20.toLocaleString() : '-',
    ma60: ma60 ? ma60.toLocaleString() : '-',
    resistance: resistance.toLocaleString(),
    support: support.toLocaleString(),
    resistanceGap: ((resistance-cur)/cur*100).toFixed(1),
    supportGap:    ((cur-support)/cur*100).toFixed(1),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const query = (req.query?.query || '').trim().toLowerCase();
  if (!query) return res.status(200).json({ success:false, error:'종목명 또는 코드를 입력하세요' });

  try {
    const isCode = /^\d{6}$/.test(query);
    let code = isCode ? query : (STOCK_MAP[query] || null);
    let name = '';

    // KIS로 코드·이름 검색
    const token = await getKisToken().catch(() => null);

    if (!code && token) {
      const sr = await timedFetch(
        `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/search-stock-info?PDNO=${encodeURIComponent(query)}&PRDT_TYPE_CD=300`,
        { headers:{ Authorization:`Bearer ${token}`, appkey:process.env.KIS_APP_KEY, appsecret:process.env.KIS_APP_SECRET, 'tr_id':'CTPF1002R', 'Content-Type':'application/json' } }
      ).then(r=>r.json()).catch(()=>({}));
      if (sr?.output?.shtn_pdno) { code=sr.output.shtn_pdno; name=sr.output.prdt_abrv_name||''; }
    }

    // DART 회사명 검색 fallback (KIS 코드 검색 실패 시)
    if (!code) {
      const dartKey = process.env.DART_API_KEY;
      if (dartKey) {
        const dart = await timedFetch(
          `https://opendart.fss.or.kr/api/company.json?crtfc_key=${dartKey}&corp_name=${encodeURIComponent(query)}`
        ).then(r => r.json()).catch(() => null);
        if (dart?.status === '000' && dart?.stock_code?.trim()) {
          code = dart.stock_code.trim().padStart(6, '0');
          name = dart.corp_name || query;
        }
      }
    }

    if (!code) return res.status(200).json({ success:false, error:'종목을 찾을 수 없습니다. 종목코드(6자리)로 다시 시도해보세요.' });

    // KIS 4개 병렬 호출: 현재가 + 주봉 5년 차트 (3개 구간)
    if (!token) throw new Error('KIS 토큰 없음');

    const now  = new Date(Date.now() + 9 * 3600 * 1000); // KST
    const fmtD = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
    const ago  = (days) => now.getTime() - days * 864e5;

    const kisHdr = (tr) => ({
      Authorization: `Bearer ${token}`,
      appkey:    process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      'tr_id':   tr,
      custtype:  'P',
      'Content-Type': 'application/json',
    });
    const chartBase = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`;
    const chartUrl  = (d1, d2) =>
      `${chartBase}?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_INPUT_DATE_1=${d1}&FID_INPUT_DATE_2=${d2}&FID_PERIOD_DIV_CODE=W&FID_ORG_ADJ_PRC=0`;

    const dailyUrl = (d1, d2) =>
      `${chartBase}?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_INPUT_DATE_1=${d1}&FID_INPUT_DATE_2=${d2}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`;

    // 현재가: KOSPI(J) 우선, 가격 0이면 KOSDAQ(Q) 재시도
    const priceUrl = (mktCd) =>
      `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=${mktCd}&FID_INPUT_ISCD=${code}`;

    const [priceRaw, cd1, cw1, cw2, cw3] = await Promise.all([
      timedFetch(priceUrl('J'), { headers: kisHdr('FHKST01010100') }).then(r => r.json()).catch(() => null),
      timedFetch(dailyUrl(fmtD(ago(240)),  fmtD(now.getTime())), { headers: kisHdr('FHKST03010100') }).then(r => r.json()).catch(() => null),
      timedFetch(chartUrl(fmtD(ago(700)),  fmtD(now.getTime())), { headers: kisHdr('FHKST03010100') }).then(r => r.json()).catch(() => null),
      timedFetch(chartUrl(fmtD(ago(1400)), fmtD(ago(700))),      { headers: kisHdr('FHKST03010100') }).then(r => r.json()).catch(() => null),
      timedFetch(chartUrl(fmtD(ago(1850)), fmtD(ago(1400))),     { headers: kisHdr('FHKST03010100') }).then(r => r.json()).catch(() => null),
    ]);

    // J로 가격 0이면 KOSDAQ(Q)으로 재시도
    let pOut = priceRaw?.output;
    if (!pOut?.stck_prpr || pOut.stck_prpr === '0') {
      const priceRawQ = await timedFetch(priceUrl('Q'), { headers: kisHdr('FHKST01010100') })
        .then(r => r.json()).catch(() => null);
      pOut = priceRawQ?.output;
    }
    if (!pOut?.stck_prpr || pOut.stck_prpr === '0') throw new Error('현재가 조회 실패 (KOSPI·KOSDAQ 모두 시도)');
    if (!name) name = pOut.hts_kor_isnm?.trim()
      || cd1?.output1?.hts_kor_isnm?.trim()
      || cw1?.output1?.hts_kor_isnm?.trim()
      || CODE_TO_NAME[code]
      || code;

    const convRow = (d) => ({
      date:   `${d.stck_bsop_date.slice(0,4)}-${d.stck_bsop_date.slice(4,6)}-${d.stck_bsop_date.slice(6,8)}`,
      open:   parseNum(d.stck_oprc),
      high:   parseNum(d.stck_hgpr),
      low:    parseNum(d.stck_lwpr),
      close:  parseNum(d.stck_clpr),
      volume: parseNum(d.acml_vol),
    });
    // 일봉: 분석 지표 계산용 (MA/RSI/지지저항 등)
    const dailyRows = (cd1?.output2 || []).filter(d => parseNum(d.stck_clpr) > 0);
    const dailyHistory = dailyRows.slice().reverse().map(convRow);
    if (dailyHistory.length === 0) throw new Error('일봉 데이터 없음');

    // 주봉: 차트 표시용 (5년)
    const rows1 = (cw1?.output2 || []).filter(d => parseNum(d.stck_clpr) > 0);
    const rows2 = (cw2?.output2 || []).filter(d => parseNum(d.stck_clpr) > 0);
    const rows3 = (cw3?.output2 || []).filter(d => parseNum(d.stck_clpr) > 0);
    const history = [
      ...rows3.slice().reverse().map(convRow),
      ...rows2.slice().reverse().map(convRow),
      ...rows1.slice().reverse().map(convRow),
    ]
      .sort((a, b) => a.date.localeCompare(b.date))
      .filter((d, i, arr) => i === 0 || d.date !== arr[i-1].date);
    if (history.length === 0) throw new Error('차트 데이터 없음');

    // 분석은 일봉 기준으로 계산
    const closes  = dailyHistory.map(d => d.close);
    const volumes = dailyHistory.map(d => d.volume);
    // 차트 지표는 주봉 기준 (chart xAxis와 데이터 수 일치)
    const weeklyCloses = history.map(d => d.close);
    const isDown = ['4', '5'].includes(pOut.prdy_vrss_sign);
    const latest = {
      close:  parseNum(pOut.stck_prpr),
      open:   parseNum(pOut.stck_oprc),
      high:   parseNum(pOut.stck_hgpr),
      low:    parseNum(pOut.stck_lwpr),
      volume: parseNum(pOut.acml_vol),
    };

    // 투자자 수급 + 점수 (GitHub Actions 사전 계산 → Redis 읽기)
    // → 메인 페이지와 분석기가 항상 동일한 점수를 표시하도록 Redis 저장값을 우선 사용
    const _redisUrl   = process.env.KV_REST_API_URL;
    const _redisToken = process.env.KV_REST_API_TOKEN;

    let investorSupply = null;
    try {
      const invRaw = await timedFetch(`${_redisUrl}/get/investor_supply`, {
        headers: { Authorization: `Bearer ${_redisToken}` },
      }).then(r => r.json());
      if (invRaw.result) {
        const invMap = JSON.parse(invRaw.result);
        investorSupply = invMap[code] || null;
      }
    } catch (_) {}

    // stock_scores (소형 맵, 워크플로우 후 생성) 우선 → 없으면 recommend_v2 에서 직접 조회
    // → recommend_v2 는 이미 Redis 에 존재하므로 워크플로우 재실행 없이 즉시 동기화
    let storedScore = null;
    try {
      const scRaw = await timedFetch(`${_redisUrl}/get/stock_scores`, {
        headers: { Authorization: `Bearer ${_redisToken}` },
      }).then(r => r.json());
      if (scRaw.result) {
        const scMap = JSON.parse(scRaw.result);
        if (scMap[code] !== undefined) storedScore = scMap[code];
      }
    } catch (_) {}

    if (storedScore === null) {
      try {
        const rv2Raw = await timedFetch(`${_redisUrl}/get/recommend_v2`, {
          headers: { Authorization: `Bearer ${_redisToken}` },
        }).then(r => r.json());
        if (rv2Raw.result) {
          const rv2 = JSON.parse(rv2Raw.result);
          const found = (rv2.stocks || []).find(s => s.code === code);
          if (found?.score !== undefined) storedScore = found.score;
        }
      } catch (_) {}
    }

// DART EPS 읽기 (분기 1회 업데이트, dart_eps 키)
// PER = 현재가 ÷ dart_eps 로 실시간 계산 (연결 기준, KIS 별도 기준보다 정확)
let dartEps = null;
try {
  const dpRaw = await timedFetch(`${_redisUrl}/get/dart_eps`, {
    headers: { Authorization: `Bearer ${_redisToken}` },
  }).then(r => r.json());
  if (dpRaw.result) {
    const dpMap = JSON.parse(dpRaw.result);
    if (dpMap[code] !== undefined) dartEps = dpMap[code];
  }
} catch (_) {}
    
    const investor = null;

    // DART 공시
    const dartKey = process.env.DART_API_KEY;
    let disclosures = [];
    if (dartKey) {
      const today   = new Date(Date.now()+9*3600*1000).toISOString().slice(0,10).replace(/-/g,'');
      const monthAgo= new Date(Date.now()+9*3600*1000-30*86400*1000).toISOString().slice(0,10).replace(/-/g,'');
      const dr = await timedFetch(
        `https://opendart.fss.or.kr/api/list.json?crtfc_key=${dartKey}&stock_code=${code}&bgn_de=${monthAgo}&end_de=${today}&sort=date&sort_mth=desc&page_count=5`
      ).then(r=>r.json()).catch(()=>({status:'err'}));
      if (dr.status==='000') {
        disclosures = (dr.list||[]).map(item=>({
          reportName: item.report_nm,
          date: `${parseInt(item.rcept_dt.slice(4,6))}/${parseInt(item.rcept_dt.slice(6,8))}`,
          url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
        }));
      }
    }

    // 일봉 기반 분석 지표 (점수·체크리스트·추천 전략용)
    const ma5arr  = calcMA(closes, 5);
    const ma20arr = calcMA(closes, 20);
    const ma60arr = calcMA(closes, Math.min(60, closes.length));
    const rsiArr  = calcRSI(closes);
    const boll    = calcBollinger(closes);
    const analysis = buildAnalysis(closes, ma5arr, ma20arr, ma60arr, rsiArr);

    // 주봉 기반 차트 지표 (chart xAxis 길이와 맞춤)
    const wMA5  = calcMA(weeklyCloses, 5);
    const wMA20 = calcMA(weeklyCloses, 20);
    const wMA60 = calcMA(weeklyCloses, Math.min(60, weeklyCloses.length));
    const wRSI  = calcRSI(weeklyCloses);
    const wBoll = calcBollinger(weeklyCloses);

    // 시장 구분 + 시가총액
    const market = pOut.rprs_mrkt_kor_name || '';
    const marketCapV = parseInt(pOut.hts_avls || 0);
    const marketCap = marketCapV >= 10000
      ? (marketCapV / 10000).toFixed(1) + '조'
      : marketCapV ? marketCapV.toLocaleString() + '억' : '';

    const chgAmt  = parseNum(pOut.prdy_vrss) * (isDown ? -1 : 1);
    const chgRate = (parseFloat(pOut.prdy_ctrt || 0) * (isDown ? -1 : 1)).toFixed(2);

    const n             = closes.length - 1;
    const recentCloses  = closes.slice(-20);
    const supportNum    = Math.min(...recentCloses);
    const resistanceNum = Math.max(...recentCloses);
    // 국장 특화 점수 (항상 실시간 계산 — 분석기 상세 표시용)
    // KIS per/pbr: KIS가 자체 계산한 연결 기준 PER·PBR — 네이버 등 외부 사이트와 동일 basis
    // (EPS/BPS 직접 계산 시 KIS eps가 별도 기준이라 연결 기준 네이버 값과 괴리 발생)
    // DART EPS 있으면 실시간 연결 PER 계산, 없으면 KIS PER fallback
    // latest.close = 현재가 (parseNum(pOut.stck_prpr), 위에서 이미 정의)
    const per2 = (dartEps && dartEps > 0 && latest.close > 0)
      ? Math.round(latest.close / dartEps * 10) / 10
      : parseF(pOut.per || '0');
    const pbr2     = parseF(pOut.pbr || '0');
    const sector2  = (pOut.bstp_kor_isnm || pOut.bstp_kor_isn_nm || '').trim();
    // 외인+기관 5일 순매수 (미래성장 가점용 — 이평선 배열과 겹치지 않는 독립 지표)
    const _d5 = investorSupply?.d5;
    const d5FrgnInst2 = _d5 ? (_d5.foreign || 0) + (_d5.inst || 0) : null;
    const techScore = calcScore(closes, volumes, boll);
    const ks        = calcKoreanScore(pbr2, per2, rsiArr[n], closes, sector2, d5FrgnInst2, disclosures, name);
    const korScore  = ks.total;
    const liveScore = Math.min(100, Math.round(techScore * 0.7) + korScore);
    // Redis 저장 점수 우선 사용 → 없으면 실시간 계산 (메인/분석기 점수 일치 보장)
    // 분析기 상세는 항상 실시간 계산 점수 사용 (storedScore 저장 당시 기준 - 로직 변경 후 불일치 방지)
    const score     = liveScore;
    const recommend = calcRecommend(latest.close, ma5arr[n], ma20arr[n], supportNum, resistanceNum, score);

    // 이평선 세부 점수 (배열 20점 + MA20 이격도 20점 = 최대 40점)
    const _ma60a  = calcMA(closes, Math.min(60,  closes.length));
    const _ma120a = calcMA(closes, Math.min(120, closes.length));
    const _ma5  = ma5arr[n]  || 0, _ma20 = ma20arr[n] || 0;
    const _ma60 = _ma60a[n]  || 0, _ma120 = _ma120a[n] || 0;
    const _pm5  = (n > 0 ? ma5arr[n-1]  : 0) || 0;
    const _pm20 = (n > 0 ? ma20arr[n-1] : 0) || 0;
    let maArrangement = 0;
    if (_ma5 && _ma20 && _ma60 && _ma120 && _ma5 > _ma20 && _ma20 > _ma60 && _ma60 > _ma120) maArrangement = 20;
    else if (_ma5 && _ma20 && _ma60 && _ma5 > _ma20 && _ma20 > _ma60) maArrangement = 16;
    else if (_pm5 && _pm20 && _ma5 && _ma20 && _pm5 <= _pm20 && _ma5 > _ma20) maArrangement = 13;
    else if (_ma20 && _ma60 && _ma20 > _ma60) maArrangement = 8;
    else if (_ma5 && _ma20 && _ma5 > _ma20)   maArrangement = 4;
    let maDeviation = 0;
    if (_ma20) {
      const d = latest.close / _ma20 * 100;
      if      (d >= 101 && d <= 106)                             maDeviation = 20;
      else if ((d >= 100 && d < 101) || (d > 106 && d <= 109))  maDeviation = 16;
      else if ((d >=  95 && d < 100) || (d > 109 && d <= 112))  maDeviation = 10;
      else if ((d >=  92 && d <  95) || (d > 112 && d <= 116))  maDeviation = 5;
    }
    const maScore = { arrangement: maArrangement, deviation: maDeviation, total: maArrangement + maDeviation };
    const checklist = buildChecklist(closes, ma5arr, ma20arr, ma60arr, rsiArr);

    res.status(200).json({
      success: true,
      stock: { name, code, market, marketCap, price:latest.close, chgAmt, chgRate, open:latest.open, high:latest.high, low:latest.low, volume:latest.volume },
      history,
      indicators: { ma5:wMA5, ma20:wMA20, ma60:wMA60, rsi:wRSI, bollUpper:wBoll.upper, bollMid:wBoll.mid, bollLower:wBoll.lower },
      analysis,
      score,
      korScore: (() => {
        // ks = calcKoreanScore 반환 객체 (위에서 이미 계산)
        const { pbrScore: pbrS, perScore: perS, perFinal: perFinalS,
                supplyScore: supplyS, panicScore: panicS, discScore: discS,
                drawdown: drawdownPct, isIVExtreme } = ks;
        // 미래성장 가점 상세 (섹터 등급 + 외인기관 수급)
        const { total: growthS, secScore: growthSecS, buyScore: growthBuyS } =
          calcGrowthBonus(sector2, d5FrgnInst2, name);
        const rsiNow = rsiArr[n];
        const tag    = getStockTag(pbr2, per2, sector2, name);
        const growthComment = (tag === 'growth' && per2 > 30)
          ? `이 종목은 [🔥 국장 주도 성장주] 태그에 해당하여, 현재 PER(${per2.toFixed(1)}배)로는 비싸 보이지만 성장 섹터(${growthSecS}점)·외인기관 수급(${growthBuyS}점)을 반영한 [섹터 프리미엄 ${growthS}점]을 부여했습니다.`
          : null;
        return {
          total: korScore, pbr: pbr2, per: per2,
          pbrScore: pbrS, perScore: perS,
          growthScore: growthS, growthSector: growthSecS, growthBuy: growthBuyS,
          perFinal: perFinalS, supplyScore: supplyS, panicScore: panicS,
          disclosureScore: discS,
          isIVExtreme,
          techScore: Math.round(techScore * 0.7),
          rsi: rsiNow !== null ? Math.round(rsiNow * 10) / 10 : null,
          drawdown: drawdownPct,
          tag,
          growthComment,
          dartEps,
          perSource: dartEps ? 'dart' : 'kis',
        };
      })(),
      maScore,
      recommend,
      checklist,
      investorSupply,
      investor,
      disclosures,
    });

  } catch(e) {
    console.error('[analyze]', e.message);
    res.status(200).json({ success:false, error:e.message });
  }
}
