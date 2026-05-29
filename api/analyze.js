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

// ── ATR (Average True Range 14) ─────────────────────────────────────────────
function calcATR14(rows, period = 14) {
  if (!rows || rows.length < 2) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const h = rows[i].high, l = rows[i].low, pc = rows[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  if (!recent.length) return null;
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ── 점수 계산 (최고 100점 / 최악 0점) ───────────────────────────────────────
// 추세(40) + 모멘텀(30) + 수급(30) + 볼린저스퀴즈 보너스/패널티(±10)
// 반환: { total: 0~100, detail: { arrangement, deviation, rsi, macd, volume, obv, boll } }
function calcScore(closes, volumes, boll) {
  const n = closes.length - 1;
  const cur = closes[n];
  const ZERO = { total: 0, detail: { arrangement:0, deviation:0, rsi:0, macd:0, volume:0, obv:0, boll:0 } };
  if (n < 21 || !cur) return ZERO;

  let arrangementPts = 0, deviationPts = 0, rsiPts = 0, macdPts = 0, volPts = 0, obvPts = 0, bollPts = 0;

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
    arrangementPts = 20; // 완벽 정배열 5>20>60>120
  else if (ma5 && ma20 && ma60 && ma5 > ma20 && ma20 > ma60)
    arrangementPts = 16; // 3선 정배열 5>20>60
  else if (pm5 && pm20 && ma5 && ma20 && pm5 <= pm20 && ma5 > ma20)
    arrangementPts = 13; // 골든크로스
  else if (ma20 && ma60 && ma20 > ma60)
    arrangementPts = 8;  // 중기 정배열 20>60
  else if (ma5 && ma20 && ma5 > ma20)
    arrangementPts = 4;  // 단기 우위

  // 1b. MA20 이격도 (20점) — 5단계
  if (ma20) {
    const d = cur / ma20 * 100;
    if      (d >= 101 && d <= 106)                             deviationPts = 20; // 이상적 상승권
    else if ((d >= 100 && d <  101) || (d > 106 && d <= 109)) deviationPts = 16; // 안정 상승
    else if ((d >=  95 && d < 100)  || (d > 109 && d <= 112)) deviationPts = 10; // 소폭 이탈/과열
    else if ((d >=  92 && d <  95)  || (d > 112 && d <= 116)) deviationPts = 5;  // 중간 이탈/과열
    // 92% 미만 or 116% 초과: 0점
  }

  // ── 2. 모멘텀 (30점) ────────────────────────────────────────────────────
  // 2a. RSI (15점) — 6단계
  const rsiArr = calcRSI(closes);
  const rsi = rsiArr[n];
  if (rsi !== null) {
    if      (rsi >= 58 && rsi <  68) rsiPts = 15; // 최적 상승
    else if (rsi >= 52 && rsi <  58) rsiPts = 10; // 강세
    else if (rsi >= 68 && rsi <  73) rsiPts = 10; // 과매수 초입
    else if (rsi >= 47 && rsi <  52) rsiPts = 6;  // 중립
    else if (rsi >= 73)              rsiPts = 3;  // 과매수
    else if (rsi >= 40 && rsi <  47) rsiPts = 2;  // 약세
    // RSI < 40: 0점
  }

  // 2b. MACD (15점) — 5단계
  const macd = calcMACDFull(closes);
  if (macd) {
    if      (macd.hist > 0 && macd.prevHist !== null && macd.hist > macd.prevHist)
      macdPts = 15; // 양수 확장 (양전환 포함)
    else if (macd.hist > 0 && macd.prevHist !== null && macd.prevHist > 0 && macd.hist > macd.prevHist * 0.7)
      macdPts = 10; // 양수 미미 축소 (70% 이상 유지)
    else if (macd.hist > 0)
      macdPts = 7;  // 양수 강한 축소
    else if (macd.hist !== null && macd.prevHist !== null && macd.hist < 0
          && macd.hist > macd.prevHist && macd.hist > macd.prevHist * 0.5)
      macdPts = 5;  // 음수 강하게 수축
    else if (macd.hist !== null && macd.prevHist !== null && macd.hist < 0 && macd.hist > macd.prevHist)
      macdPts = 3;  // 음수 수축
    // 음수 확장: 0점
  }

  // ── 3. 거래량 수급 (30점) ───────────────────────────────────────────────
  if (volumes && volumes.length > 5) {
    // 3a. 거래량 5일 평균 대비 (15점) — 6단계
    const past5 = volumes.slice(Math.max(0, n-5), n);
    const avg5  = past5.length ? past5.reduce((a,b)=>a+b,0) / past5.length : 0;
    if (avg5 > 0) {
      const ratio = volumes[n] / avg5;
      if      (ratio >= 3.0) volPts = 15; // 폭발적
      else if (ratio >= 2.0) volPts = 12; // 세력 개입
      else if (ratio >= 1.5) volPts = 9;  // 강한 관심
      else if (ratio >= 1.0) volPts = 6;  // 평균 이상
      else if (ratio >= 0.7) volPts = 3;  // 소폭 미달
      // 70% 미만: 0점
    }

    // 3b. OBV 60일 최고치 대비 (15점) — 5단계
    const obv     = calcOBVArr(closes, volumes);
    const window  = obv.slice(Math.max(0, n-60), n+1);
    const obvMax  = Math.max(...window);
    if      (obv[n] >= obvMax * 0.98) obvPts = 15; // 신고치 갱신
    else if (obv[n] >= obvMax * 0.90) obvPts = 11; // 최고치 근접
    else if (obv[n] >= obvMax * 0.80) obvPts = 7;  // 접근
    else if (obv[n] >= obvMax * 0.65) obvPts = 4;  // 중간
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
          bollPts += 10; // 스퀴즈 상방 대량 돌파
        else if (boll.lower[n] && cur < boll.lower[n])
          bollPts -= 10; // 스퀴즈 하방 붕괴
      }

      // [탐욕 과열 감지] RSI 극과매수 + 거래량 소멸 → 역발상 경고 ★
      // "사람들이 안도·탐욕할 때 오히려 위험" — 김민겸 IV 역발상
      if (rsi !== null && rsi >= 75 && vol5 > 0) {
        const isVolDrying = volumes[n] < vol5 * 0.7;  // 거래량 30% 이상 소멸
        const isBBNarrow  = curW <= minW * 1.5;        // BB 역사적 저변동 구간
        if      (rsi >= 80 && isVolDrying && isBBNarrow) bollPts -= 6; // 극단 탐욕
        else if (rsi >= 78 && isVolDrying)                bollPts -= 4; // 강한 탐욕
        else if (rsi >= 75 && isVolDrying)                bollPts -= 3; // 과열 경고
        else if (rsi >= 80)                               bollPts -= 2; // RSI 극단
      }
    }
  }

  const total = Math.max(0, Math.min(100, Math.round(arrangementPts + deviationPts + rsiPts + macdPts + volPts + obvPts + bollPts)));
  return { total, detail: { arrangement: arrangementPts, deviation: deviationPts, rsi: rsiPts, macd: macdPts, volume: volPts, obv: obvPts, boll: bollPts } };
}

// ─── 국장 특화 스코어 (30점) ─────────────────────────────────────────────────
// PBR 저평가(12) + max(PER저평가, 미래성장가점)(8) + 패닉셀링 감지(10)

// ── 생태계 기반 종목 티어 매핑 (코드 → Tier 1~6) ──────────────────────────────
// scripts/classify-ecosystem.js 실행 시 regenerate → update-recommend.js / api/analyze.js 에 반영
// Tier1=반도체·방산(14pt) / Tier2=배터리·로봇·원전(11pt) / Tier3=바이오·게임·SW·조선(8pt)
// Tier4=자동차·통신·화학·전자(5pt) / Tier5=금융·유통·건설(2pt) / Tier6=전통산업(0pt)
// prettier-ignore
const ECO_TIER = {
"000020":3,"000040":4,"000080":5,"000100":3,"000120":6,"000140":5,"000270":4,"000320":4,"000370":1,"000400":5,"000540":5,"000640":3,"000660":1,"000670":5,"000680":5,"000720":5,"000810":5,"000880":1,"000910":6,"000990":1,"001060":3,"001230":5,"001270":5,"001430":5,"001450":5,"001500":5,"001510":5,"001520":6,"001570":4,"001630":3,"001680":5,"001740":4,"001800":5,"002310":6,"002320":6,"002350":4,"002360":4,"002380":4,"002390":3,"002630":3,
"002790":5,"002810":5,"002880":4,"002990":5,"003000":3,"003030":5,"003060":3,"003070":2,"003090":3,"003200":6,"003220":3,"003230":5,"003240":3,"003280":6,"003470":5,"003480":6,"003490":6,"003520":3,"003530":1,"003540":5,"003550":5,"003580":3,"003610":6,"003620":4,"003650":5,"003670":2,"003690":5,"003830":1,"003850":3,"003920":6,"003960":5,"004000":4,"004020":5,"004140":3,"004150":1,"004170":5,"004360":6,"004370":5,"004380":2,"004440":2,
"004490":6,"004540":6,"004560":5,"004960":5,"004980":6,"004990":5,"005070":2,"005090":6,"005180":5,"005250":3,"005290":1,"005300":5,"005380":4,"005430":6,"005490":5,"005500":3,"005740":5,"005810":1,"005830":5,"005850":4,"005930":1,"005940":5,"005950":2,"005960":5,"006260":5,"006280":3,"006360":5,"006400":2,"006650":4,"006800":5,"006910":2,"007070":5,"007160":5,"007210":6,"007310":5,"007570":3,"007590":3,"007660":1,"007700":6,"007770":6,
"007810":1,"008060":1,"008490":5,"008730":4,"008930":3,"008970":6,"009140":1,"009150":1,"009190":5,"009200":6,"009270":6,"009410":5,"009420":3,"009450":4,"009540":3,"009810":3,"009830":1,"009970":6,"010060":4,"010130":5,"010140":3,"010280":3,"010400":2,"010580":3,"010690":4,"010770":4,"010780":6,"010820":1,"010950":6,"011000":3,"011040":3,"011070":1,"011170":4,"011210":2,"011230":1,"011420":3,"011500":2,"011760":3,"011780":4,"011790":4,
"012030":5,"012170":3,"012330":4,"012450":1,"012510":3,"012690":6,"012750":4,"013520":3,"013570":4,"013580":5,"013700":5,"013810":1,"014190":1,"014440":4,"014620":2,"014680":1,"015260":1,"015750":4,"015760":2,"015860":4,"015890":4,"016360":5,"016380":5,"016610":5,"017000":6,"017480":5,"017670":4,"017900":1,"017960":3,"018290":5,"018500":4,"018620":2,"018880":4,"019170":3,"019180":4,"020000":6,"020120":3,"020150":5,"020180":4,"020560":6,
"021040":5,"021240":4,"021320":4,"021820":4,"023160":3,"023530":5,"023770":3,"023800":4,"023810":4,"024110":5,"024800":2,"024850":3,"024900":4,"024910":4,"025540":4,"025820":2,"025860":4,"025900":2,"026150":5,"026960":6,"027970":6,"028260":5,"028300":3,"028670":5,"030190":5,"030350":3,"030520":3,"030530":1,"030610":5,"031310":4,"031330":1,"031430":5,"031440":5,"031820":3,"031980":1,"032350":5,"032560":5,"032640":4,"032800":3,"032820":2,
"032830":5,"032940":1,"033160":1,"033170":1,"033500":3,"033530":5,"033640":1,"033920":5,"034020":2,"034120":3,"034220":3,"035420":3,"035510":5,"035720":3,"035760":3,"035900":3,"036010":1,"036200":1,"036420":3,"036530":1,"036540":1,"036570":3,"036620":3,"036630":4,"036710":1,"036810":1,"036830":1,"036930":1,"037070":4,"037460":1,"037560":5,"037710":5,"038110":4,"038500":6,"038530":3,"039030":1,"039200":3,"039440":1,"039490":5,"039840":3,
"039860":3,"039980":3,"040910":1,"041190":2,"041510":3,"041520":1,"041650":3,"041830":3,"041910":3,"041920":3,"042420":3,"042660":1,"042700":1,"043100":3,"043150":3,"043260":1,"043610":4,"043650":5,"044340":4,"044820":5,"044990":2,"045100":1,"045520":1,"046120":1,"046210":3,"046390":3,"046890":1,"047040":5,"047050":5,"047310":1,"047400":6,"047560":3,"047810":1,"047820":3,"047920":3,"048410":3,"048530":3,"048550":3,"049070":1,"049080":1,
"049800":2,"049960":3,"050760":1,"051370":1,"051490":2,"051500":5,"051600":2,"051900":5,"051910":4,"052260":3,"052690":2,"052710":1,"053030":3,"053050":2,"053060":4,"053610":1,"053700":4,"054450":1,"054780":3,"054950":1,"055490":6,"055550":5,"056080":2,"058110":3,"058470":1,"058610":2,"058630":3,"058650":5,"058850":4,"058860":4,"060370":5,"060380":6,"060720":3,"060900":3,"061250":4,"061970":1,"062970":1,"063080":3,"063160":3,"064290":1,
"064350":1,"064400":2,"064550":3,"064760":1,"064960":1,"065450":1,"065650":3,"065680":1,"066410":3,"066570":4,"066910":3,"066970":2,"067000":3,"067170":4,"067310":1,"067390":1,"067630":3,"067990":4,"068270":3,"068760":3,"069080":3,"069260":4,"069540":1,"069620":3,"069960":5,"071050":5,"071670":4,"071840":5,"072710":5,"072770":3,"073110":1,"073240":4,"073490":1,"073570":2,"074600":1,"075580":3,"077360":1,"078020":5,"078070":1,"078150":1,
"078160":3,"078340":3,"078350":1,"078520":5,"078600":2,"079370":1,"079550":1,"079900":2,"079960":6,"080220":1,"080720":6,"082210":1,"082640":5,"082740":1,"083310":1,"083450":1,"083500":2,"083650":2,"084370":1,"084650":3,"084670":6,"084690":5,"085620":5,"085660":3,"086060":3,"086280":4,"086390":1,"086450":3,"086520":2,"086790":5,"086890":3,"086900":3,"086980":3,"088350":1,"088790":4,"088800":1,"089030":1,"089590":6,"089600":4,"089860":5,
"089970":1,"090360":2,"090430":5,"090460":1,"090710":2,"091810":6,"091970":1,"092070":1,"092190":1,"092230":4,"093050":6,"093320":3,"093370":1,"094360":1,"094820":2,"094970":1,"095610":1,"095660":3,"095700":3,"095910":6,"096530":3,"096610":1,"096770":2,"097230":3,"097520":1,"097950":5,"098120":1,"098460":2,"098660":2,"099190":3,"099320":1,"099410":3,"100120":3,"100840":1,"101360":2,"101390":1,"101490":1,"101530":5,"101670":2,"101730":3,
"102120":1,"102710":1,"103140":1,"103590":4,"104040":3,"104460":4,"104830":1,"105560":5,"105630":6,"105840":2,"108230":2,"108320":1,"108490":2,"108670":6,"108860":3,"109070":3,"109820":3,"111770":6,"112040":3,"112290":1,"114190":6,"114810":1,"115450":3,"117580":6,"117730":2,"119850":2,"121600":2,"122310":3,"122350":4,"122640":1,"123040":4,"123420":3,"123860":1,"124500":3,"126340":1,"126640":4,"126730":1,"128940":3,"130660":2,"131970":1,
"134380":4,"137400":2,"137940":1,"138070":3,"138930":5,"139130":5,"139480":5,"140860":1,"141000":1,"142210":1,"142280":3,"143210":3,"144960":1,"145020":3,"145720":3,"149950":3,"149980":3,"150900":3,"160190":2,"160550":3,"160980":1,"161390":4,"161890":5,"166090":1,"168360":1,"170900":3,"171010":1,"172670":1,"173940":3,"174900":3,"175330":5,"178920":1,"179530":3,"180640":6,"182400":3,"183190":6,"183300":1,"185490":3,"185750":3,"187270":1,
"187420":3,"189330":3,"190650":5,"192080":3,"192400":4,"192820":5,"194370":2,"194480":3,"195870":1,"195990":3,"196170":3,"196300":3,"196490":2,"199550":3,"199800":3,"200350":3,"200470":1,"200710":1,"200880":4,"201490":3,"203450":6,"204320":4,"206640":3,"206650":3,"207940":3,"210540":4,"211270":1,"213420":1,"214150":3,"214320":3,"214390":3,"214420":5,"214450":3,"214680":2,"215480":6,"215600":3,"217270":3,"217730":3,"217820":1,"218410":1,
"219550":4,"221840":1,"222040":5,"222080":1,"222800":1,"223250":1,"225570":3,"226320":5,"226950":3,"227840":3,"228340":6,"228670":3,"228850":3,"229640":5,"232830":2,"234030":3,"234690":3,"235980":3,"237690":3,"237820":3,"237880":5,"239340":3,"240550":3,"240600":1,"240810":1,"241710":5,"241770":1,"241790":2,"241840":3,"243840":2,"246250":4,"247540":2,"249420":3,"251270":3,"251370":1,"251630":2,"252990":2,"253450":3,"253840":3,"256150":3,
"256630":1,"257370":2,"257720":5,"259630":2,"259960":3,"263050":3,"263750":3,"263800":3,"264450":4,"264660":1,"265520":1,"267980":6,"270660":2,"271560":5,"271980":3,"272110":1,"272210":1,"272290":1,"272450":6,"274090":1,"274400":3,"277810":2,"278280":2,"278470":5,"278650":3,"280360":5,"281740":1,"281820":1,"282330":5,"282720":4,"285490":3,"286940":5,"293490":3,"294090":3,"295310":1,"297890":3,"298000":4,"298380":3,"298690":6,"299030":2,
"299900":3,"300720":6,"301300":3,"302430":2,"304100":3,"307950":3,"310870":4,"314130":3,"314930":3,"315640":3,"316140":5,"317450":3,"317870":3,"318160":3,"319660":1,"320000":1,"321550":3,"322000":2,"322180":5,"322510":3,"323410":3,"323990":3,"329180":3,"330860":1,"334970":3,"336260":2,"336370":2,"336570":3,"338220":3,"338840":3,"340810":3,"344820":4,"347860":3,"348150":3,"348340":2,"348350":1,"348370":2,"352820":3,"353200":1,"356680":1,
"357780":1,"357880":1,"361390":1,"365340":2,"368770":1,"373170":3,"373220":2,"375500":5,"377300":3,"377330":1,"377480":3,"378340":2,"382900":2,"383220":6,"383310":2,"383800":5,"384470":2,"388050":6,"389260":6,"389500":2,"394280":1,"396270":1,"399720":1,"402030":3,"403550":3,"403870":1,"408900":3,"408920":3,"412350":1,"415380":3,"417200":5,"417840":1,"418420":1,"418470":4,"419050":4,"419540":3,"420770":1,"424960":3,"425420":1,"432470":2,
"432720":1,"439090":5,"440110":1,"443060":3,"443250":3,"444530":3,"445090":1,"445680":1,"448710":1,"448900":1,"450080":2,"451220":1,"452190":3,"452260":1,"452430":1,"453450":3,"454910":2,"457550":2,"459510":2,"460860":5,"460870":3,"461030":1,"463020":3,"466100":2,"474650":3,"478340":1,"489790":1,"490470":1,"493280":1,"900070":3,"900140":1,"900310":3,"950190":3,"950210":3
};
const ECO_TIER_SCORES = { 1:14, 2:11, 3:8, 4:5, 5:2, 6:0 };

// ── 테마 티어 오버라이드 (코드 → theme_tier) ────────────────────────────────
// 본업 ECO_TIER와 별도로, 강한 테마 노출이 있는 종목에 테마 티어 부여
// sectorGrowthScore에서 min(ECO_TIER, ECO_THEME) → 두 티어 중 높은 점수 자동 선택
// prettier-ignore
const ECO_THEME = {
  // ── 원전 테마 건설주 ── (본업: 건설_인프라 T5=2pt → 테마 점수 상향)
  "000720": 3,  // 현대건설  — 국내 원전 EPC 주계약자         (T5→T3: 8pt)
  "028260": 3,  // 삼성물산  — APR1400 원전 건설·EPC 핵심사   (T5→T3: 8pt)
  "047040": 4,  // 대우건설  — 원전 시공 참여                  (T5→T4: 5pt)
  "006360": 4,  // GS건설   — 원전 시공 참여                   (T5→T4: 5pt)
  "375500": 4,  // DL이앤씨 — 원전 시공 참여                   (T5→T4: 5pt)
};

// KIS 업종명 fallback (ECO_TIER에 없는 미분류 종목용)
const GROWTH_TIER1 = ['반도체', '방위산업'];
const GROWTH_TIER2 = ['바이오', '의약품', '2차전지', '로봇', '우주항공'];
const GROWTH_TIER3 = ['소프트웨어', '인터넷', '게임', '의료기기', '디스플레이'];
const GROWTH_TIER4 = ['통신장비', '전기장비'];
const GROWTH_SECTOR_KW = [...GROWTH_TIER1, ...GROWTH_TIER2, ...GROWTH_TIER3, ...GROWTH_TIER4];

// 섹터 점수 반환 (0~14점) — 생태계 코드 우선 + 테마 오버라이드, KIS 업종 fallback
function sectorGrowthScore(sector, name = '', code = '') {
  // 1순위: 생태계 분류 + 테마 오버라이드 (코드 기반 — 가장 정확)
  if (code) {
    const primaryTier = ECO_TIER[code];
    const themeTier   = ECO_THEME[code];
    let tier;
    if (primaryTier !== undefined && themeTier !== undefined) {
      tier = Math.min(primaryTier, themeTier); // 번호 낮을수록 점수 높음 → 유리한 쪽 선택
    } else {
      tier = themeTier ?? primaryTier;
    }
    if (tier !== undefined) return ECO_TIER_SCORES[tier] ?? 3;
  }
  // 2순위: KIS 업종명 키워드 (미분류 종목 fallback)
  const s = sector || "";
  if (GROWTH_TIER1.some(k => s.includes(k))) return 14;
  if (GROWTH_TIER2.some(k => s.includes(k))) return 11;
  if (GROWTH_TIER3.some(k => s.includes(k))) return 8;
  if (GROWTH_TIER4.some(k => s.includes(k))) return 4;
  return 3; // 미분류 기본값
}

// 미래 성장성 가점 (최대 14점) — 표시용
function calcGrowthBonus(sector, d5FrgnInst, name = '', code = '') {
  const secScore = sectorGrowthScore(sector, name, code);
  const buyScore = (typeof d5FrgnInst === 'number' && d5FrgnInst > 0) ? 4 : 0;
  // 섹터(최대 14) + 수급(최대 4) = 최대 18 (표시용 합계 — 실제 점수는 calcKoreanScore에서 별도 합산)
  return { total: Math.min(18, secScore + buyScore), secScore, buyScore };
}

// 종목 성격 태그: 'value' | 'growth' | 'neutral'
function getStockTag(pbr, per, sector, name = '', code = '') {
  // 본업 티어와 테마 티어 중 낮은 번호(높은 점수) 선택
  const effectiveTier = code
    ? Math.min(ECO_TIER[code] ?? 99, ECO_THEME[code] ?? 99)
    : 99;
  const isGrowthSector = GROWTH_SECTOR_KW.some(k => (sector || "").includes(k))
    || effectiveTier <= 3;
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
function calcKoreanScore(pbr, per, rsiLatest, closes, sector, d5FrgnInst, disclosures = [], stockName = '', stockCode = '') {
  const n   = closes.length - 1;
  const cur = closes[n];

  // PBR 저평가 (최대 8점) — 선형: PBR 0배=8점, 1.5배=0점
  const pbrScore = pbr > 0 ? Math.max(0, 8 * (1.5 - pbr) / 1.5) : 0;

  // 섹터 프리미엄 vs PER 저평가 (최대 14점, 높은 값 선택)
  // 반도체/방산 슈퍼사이클(14점) ↔ 극도 저평가 가치주(PER≤8배, ~10점)
  const secScore  = sectorGrowthScore(sector, stockName, stockCode);
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

/* ─── 중장기 목표가 (PBR+PER 복합 적정 가격) ────────────────────────
 * growthScore 0~18을 반영해 적정 PBR(0.8~3.0)·적정 PER(12~35) 산출 후
 * 투자 스타일(tag)에 따라 가중 혼합
 * ─────────────────────────────────────────────────────────────────── */
function calcMidLongTarget(cur, per, pbr, growthScore, tag, ma60) {
  // 1. PBR 기반 적정가
  let pbrTarget = null;
  if (pbr > 0) {
    const fairPBR = 0.8 + (growthScore / 18) * 2.2;  // 0.8 ~ 3.0
    pbrTarget = Math.round(cur / pbr * fairPBR);
  }

  // 2. PER 기반 적정가 (이상치·무의미 PER 제외)
  let perTarget = null;
  if (per > 0 && per < 200) {
    const eps     = cur / per;
    const fairPER = 12 + (growthScore / 18) * 23;    // 12 ~ 35
    perTarget = Math.round(eps * fairPER);
  }

  // 3. 태그별 가중 혼합
  let price = null;
  let basis = '';
  if (pbrTarget && perTarget) {
    const pbrW = tag === 'value' ? 0.65 : tag === 'growth' ? 0.30 : 0.50;
    price = Math.round(pbrTarget * pbrW + perTarget * (1 - pbrW));
    basis = tag === 'growth' ? 'PER 중심 복합' : tag === 'value' ? 'PBR 중심 복합' : 'PBR+PER 복합';
  } else if (pbrTarget) {
    price = pbrTarget; basis = 'PBR 기반';
  } else if (perTarget) {
    price = perTarget; basis = 'PER 기반';
  } else if (ma60 > 0) {
    // 폴백: MA60 × 성장 프리미엄 (PBR·PER 모두 없는 경우)
    price = Math.round(ma60 * (1 + growthScore / 18 * 0.30));
    basis = 'MA60 기반';
  }

  if (!price) return null;

  const upside  = (price - cur) / cur * 100;
  const horizon = Math.abs(upside) > 30 ? '12개월' : Math.abs(upside) > 15 ? '6~12개월' : '3~6개월';

  return { price, upside: upside.toFixed(1), basis, horizon };
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

    // ATR 14일 (일봉 기준 진폭 — 분할매수 가이드·포지션 리스크 계산용)
    const atr14val = calcATR14(dailyHistory);
    const atrObj = (atr14val && latest.close > 0) ? {
      price: Math.round(atr14val),
      pct:   Math.round(atr14val / latest.close * 10000) / 100,
    } : null;

    // 투자자 수급 + 점수 (GitHub Actions 사전 계산 → Redis 읽기)
    // → 메인 페이지와 분析기가 항상 동일한 점수를 표시하도록 Redis 저장값을 우선 사용
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

    // Redis 미존재 시 KIS 실시간 fallback (분석기에서 직접 조회한 종목 대응)
    if (!investorSupply) {
      try {
        const mkCode = (pOut.rprs_mrkt_kor_name || '').includes('코스닥') ? 'Q' : 'J';
        const livInv = await timedFetch(
          `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor` +
          `?fid_cond_mrkt_div_code=${mkCode}&fid_input_iscd=${code}`,
          { headers: kisHdr('FHKST01010900') }
        ).then(r => r.json()).catch(() => null);
        const rows = Array.isArray(livInv?.output) ? livInv.output : [];
        if (rows.length >= 5) {
          const sumN    = (arr, f) => arr.reduce((s, d) => s + parseNum(d[f] || '0'), 0);
          const fmtDate = d => { const dt = d?.stck_bsop_date; return dt ? `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}` : ''; };
          const rows5   = rows.slice(0, 5);
          const rows20  = rows.slice(0, Math.min(20, rows.length));
          investorSupply = {
            d5:  { foreign: sumN(rows5,'frgn_ntby_qty'),  inst: sumN(rows5,'orgn_ntby_qty'),  personal: sumN(rows5,'prsn_ntby_qty'),  from: fmtDate(rows5[rows5.length-1]),  to: fmtDate(rows5[0]) },
            d20: { foreign: sumN(rows20,'frgn_ntby_qty'), inst: sumN(rows20,'orgn_ntby_qty'), personal: sumN(rows20,'prsn_ntby_qty'), from: fmtDate(rows20[rows20.length-1]), to: fmtDate(rows20[0]) },
          };
        }
      } catch (_) {}
    }

    // stock_scores (소형 맵) 우선 → 없으면 recommend_v2 fallback
    // recommend_v2 는 RS 퍼센타일 계산에도 필요하므로 항상 읽음
    let storedScore = null;
    let rv2Stocks   = null;
    try {
      const scRaw = await timedFetch(`${_redisUrl}/get/stock_scores`, {
        headers: { Authorization: `Bearer ${_redisToken}` },
      }).then(r => r.json());
      if (scRaw.result) {
        const scMap = JSON.parse(scRaw.result);
        if (scMap[code] !== undefined) storedScore = scMap[code];
      }
    } catch (_) {}

    // Always fetch recommend_v2: storedScore fallback + RS percentile universe
    try {
      const rv2Raw = await timedFetch(`${_redisUrl}/get/recommend_v2`, {
        headers: { Authorization: `Bearer ${_redisToken}` },
      }).then(r => r.json());
      if (rv2Raw.result) {
        const rv2 = JSON.parse(rv2Raw.result);
        rv2Stocks = rv2.stocks || [];
        if (storedScore === null) {
          const found = rv2Stocks.find(s => s.code === code);
          if (found?.score !== undefined) storedScore = found.score;
        }
      }
    } catch (_) {}

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

    // KIS prdy_vrss / prdy_ctrt 는 이미 부호 포함 (하락 시 음수) → 이중 부정 방지
    const chgAmt  = parseNum(pOut.prdy_vrss);
    const chgRate = parseFloat(pOut.prdy_ctrt || 0).toFixed(2);

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
    const techResult  = calcScore(closes, volumes, boll);
    const techScore   = techResult.total;
    const techDetail  = techResult.detail;
    const ks        = calcKoreanScore(pbr2, per2, rsiArr[n], closes, sector2, d5FrgnInst2, disclosures, name, code);
    const korScore  = ks.total;
    const liveScore = Math.min(100, Math.round(techScore * 0.7) + korScore);
    // Redis 저장 점수 우선 사용 → 없으면 실시간 계산 (메인/분석기 점수 일치 보장)
    // 분析기 상세는 항상 실시간 계산 점수 사용 (storedScore 저장 당시 기준 - 로직 변경 후 불일치 방지)
    const score     = liveScore;
    const recommend = calcRecommend(latest.close, ma5arr[n], ma20arr[n], supportNum, resistanceNum, score);

    // 중장기 목표가 — recommend 객체에 추가 (korScore IIFE 이전에 미리 계산)
    const { total: growthS, secScore: growthSecS, buyScore: growthBuyS } =
      calcGrowthBonus(sector2, d5FrgnInst2, name, code);
    const tag = getStockTag(pbr2, per2, sector2, name, code);
    recommend.midLongTarget = calcMidLongTarget(
      latest.close, per2, pbr2, growthS, tag, ma60arr[n]
    );

    // 이평선 세부 점수: calcScore 내부 계산값 재활용 (중복 계산 제거)
    const maScore = {
      arrangement: techDetail.arrangement,
      deviation:   techDetail.deviation,
      total:       techDetail.arrangement + techDetail.deviation,
    };
    const checklist = buildChecklist(closes, ma5arr, ma20arr, ma60arr, rsiArr);

    // RS Rating — 퀀트 점수 기준 스캔 전종목 대비 퍼센타일 (1~99)
    let rsRating = null;
    if (rv2Stocks && rv2Stocks.length > 10) {
      const allScores = rv2Stocks.map(s => s.score).filter(s => typeof s === 'number');
      if (allScores.length > 10) {
        const below = allScores.filter(s => s < score).length;
        rsRating = Math.max(1, Math.min(99, Math.round(below / allScores.length * 98) + 1));
      }
    }


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
        // 미래성장 가점 상세 — 위에서 이미 계산된 growthS, growthSecS, growthBuyS, tag 재활용
        const rsiNow = rsiArr[n];
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
          techDetail,
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
      atr: atrObj,
      rsRating,
    });

  } catch(e) {
    console.error('[analyze]', e.message);
    res.status(200).json({ success:false, error:e.message });
  }
}
