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

function parseNum(s) {
  return parseInt(String(s||'0').replace(/,/g,''))||0;
}

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

function calcScore(closes, ma5arr, ma20arr, ma60arr, rsiArr) {
  const n   = closes.length - 1;
  const cur = closes[n];
  const ma5  = ma5arr[n]  || 0;
  const ma20 = ma20arr[n] || 0;
  const ma60 = ma60arr[n] || 0;
  const rsi  = rsiArr[n];
  let score  = 50;

  if (ma5 && ma20 && ma60) {
    if (ma5 > ma20 && ma20 > ma60)       score += 15;
    else if (ma5 < ma20 && ma20 < ma60)  score -= 18;
  }
  if (ma5)  score += cur > ma5  ? 8 : -5;
  if (ma20) score += cur > ma20 ? 8 : -5;
  if (ma60) score += cur > ma60 ? 5 : -3;

  if (n >= 1) {
    const pm5 = ma5arr[n-1] || 0, pm20 = ma20arr[n-1] || 0;
    if (pm5 && pm20 && ma5 && ma20) {
      if (pm5 <= pm20 && ma5 > ma20) score += 10;  // 골든크로스
      if (pm5 >= pm20 && ma5 < ma20) score -= 10;  // 데드크로스
    }
  }
  if (rsi !== null) {
    if      (rsi < 30) score += 8;
    else if (rsi > 70) score -= 8;
    else if (rsi > 55) score += 3;
    else if (rsi < 45) score -= 3;
  }
  return Math.max(5, Math.min(99, Math.round(score)));
}

function calcRecommend(cur, ma5, ma20, supportNum, resistanceNum, score) {
  const grade = score >= 68 ? 'bull' : score >= 48 ? 'neutral' : 'bear';
  if (grade === 'bear') {
    return { grade, label: '매수 비추천', reason: '이평선 하락 추세', color: '#ef4444' };
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

    const [priceRaw, cw1, cw2, cw3] = await Promise.all([
      timedFetch(
        `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
        { headers: kisHdr('FHKST01010100') }
      ).then(r => r.json()).catch(() => null),
      timedFetch(chartUrl(fmtD(ago(700)),  fmtD(now.getTime())), { headers: kisHdr('FHKST03010100') }).then(r => r.json()).catch(() => null),
      timedFetch(chartUrl(fmtD(ago(1400)), fmtD(ago(700))),      { headers: kisHdr('FHKST03010100') }).then(r => r.json()).catch(() => null),
      timedFetch(chartUrl(fmtD(ago(1850)), fmtD(ago(1400))),     { headers: kisHdr('FHKST03010100') }).then(r => r.json()).catch(() => null),
    ]);

    const pOut = priceRaw?.output;
    if (!pOut?.stck_prpr || pOut.stck_prpr === '0') throw new Error('현재가 조회 실패');
    if (!name) name = pOut.hts_kor_isnm || code;

    const convRow = (d) => ({
      date:   `${d.stck_bsop_date.slice(0,4)}-${d.stck_bsop_date.slice(4,6)}-${d.stck_bsop_date.slice(6,8)}`,
      open:   parseNum(d.stck_oprc),
      high:   parseNum(d.stck_hgpr),
      low:    parseNum(d.stck_lwpr),
      close:  parseNum(d.stck_clpr),
      volume: parseNum(d.acml_vol),
    });
    const rows1 = (cw1?.output2 || []).filter(d => parseNum(d.stck_clpr) > 0);
    const rows2 = (cw2?.output2 || []).filter(d => parseNum(d.stck_clpr) > 0);
    const rows3 = (cw3?.output2 || []).filter(d => parseNum(d.stck_clpr) > 0);

    // KIS는 최신이 앞 → 각 구간별로 역순 후 날짜순 정렬 + 중복 제거
    const history = [
      ...rows3.slice().reverse().map(convRow),
      ...rows2.slice().reverse().map(convRow),
      ...rows1.slice().reverse().map(convRow),
    ]
      .sort((a, b) => a.date.localeCompare(b.date))
      .filter((d, i, arr) => i === 0 || d.date !== arr[i-1].date);
    if (history.length === 0) throw new Error('차트 데이터 없음');

    const closes = history.map(d => d.close);
    const isDown = ['4', '5'].includes(pOut.prdy_vrss_sign);
    const latest = {
      close:  parseNum(pOut.stck_prpr),
      open:   parseNum(pOut.stck_oprc),
      high:   parseNum(pOut.stck_hgpr),
      low:    parseNum(pOut.stck_lwpr),
      volume: parseNum(pOut.acml_vol),
    };

    // 투자자 수급 (5일/20일 누적) — GitHub Actions 사전 계산 → Redis 읽기
    let investorSupply = null;
    try {
      const redisUrl   = process.env.KV_REST_API_URL;
      const redisToken = process.env.KV_REST_API_TOKEN;
      const invRaw = await timedFetch(`${redisUrl}/get/investor_supply`, {
        headers: { Authorization: `Bearer ${redisToken}` },
      }).then(r => r.json());
      if (invRaw.result) {
        const invMap = JSON.parse(invRaw.result);
        investorSupply = invMap[code] || null;
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

    // 지표 계산
    const ma5arr  = calcMA(closes, 5);
    const ma20arr = calcMA(closes, 20);
    const ma60arr = calcMA(closes, Math.min(60, closes.length));
    const rsiArr  = calcRSI(closes);
    const boll    = calcBollinger(closes);
    const analysis = buildAnalysis(closes, ma5arr, ma20arr, ma60arr, rsiArr);

    const chgAmt  = parseNum(pOut.prdy_vrss) * (isDown ? -1 : 1);
    const chgRate = (parseFloat(pOut.prdy_ctrt || 0) * (isDown ? -1 : 1)).toFixed(2);

    const n             = closes.length - 1;
    const recentCloses  = closes.slice(-20);
    const supportNum    = Math.min(...recentCloses);
    const resistanceNum = Math.max(...recentCloses);
    const score     = calcScore(closes, ma5arr, ma20arr, ma60arr, rsiArr);
    const recommend = calcRecommend(latest.close, ma5arr[n], ma20arr[n], supportNum, resistanceNum, score);
    const checklist = buildChecklist(closes, ma5arr, ma20arr, ma60arr, rsiArr);

    res.status(200).json({
      success: true,
      stock: { name, code, price:latest.close, chgAmt, chgRate, open:latest.open, high:latest.high, low:latest.low, volume:latest.volume },
      history,
      indicators: { ma5:ma5arr, ma20:ma20arr, ma60:ma60arr, rsi:rsiArr, bollUpper:boll.upper, bollMid:boll.mid, bollLower:boll.lower },
      analysis,
      score,
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
