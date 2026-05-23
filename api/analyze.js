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

    // NAVER 가격 히스토리 (60일, 주된 데이터 소스)
    const rawPrices = await timedFetch(
      `https://m.stock.naver.com/api/stock/${code}/price?pageSize=60&page=1`,
      { headers:{ Referer:'https://m.stock.naver.com', 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' } }
    ).then(r=>r.json());

    if (!Array.isArray(rawPrices) || rawPrices.length === 0) throw new Error('가격 데이터 없음');

    // NAVER는 최신이 앞 → 역순으로 시간순
    const history = rawPrices.reverse().map(d => ({
      date:   d.localTradedAt,
      open:   parseNum(d.openPrice),
      high:   parseNum(d.highPrice),
      low:    parseNum(d.lowPrice),
      close:  parseNum(d.closePrice),
      volume: d.accumulatedTradingVolume,
      chgRate: parseFloat(d.fluctuationsRatio||0),
    }));

    const closes = history.map(d=>d.close);
    const latest = history[history.length-1];
    const prev   = history[history.length-2];

    // NAVER 종목 기본정보 (이름)
    if (!name) {
      const basic = await timedFetch(
        `https://m.stock.naver.com/api/stock/${code}/basic`,
        { headers:{ Referer:'https://m.stock.naver.com', 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' } }
      ).then(r=>r.json()).catch(()=>({}));
      name = basic.stockName || basic.name || code;
    }

    // KIS 투자자 수급 (장중만 유효)
    let investor = null;
    if (token) {
      const kisHeaders = { Authorization:`Bearer ${token}`, appkey:process.env.KIS_APP_KEY, appsecret:process.env.KIS_APP_SECRET, 'Content-Type':'application/json' };
      const inv = await timedFetch(
        `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-investor?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`,
        { headers:{ ...kisHeaders, 'tr_id':'FHKST01010900', custtype:'P' } }
      ).then(r=>r.json()).catch(()=>null);
      if (inv?.output) {
        const f=parseInt(inv.output.frgn_ntby_qty||0), i=parseInt(inv.output.orgn_ntby_qty||0), p=parseInt(inv.output.indv_ntby_qty||0);
        if (f!==0||i!==0||p!==0) investor = { foreignNet:f, instNet:i, personalNet:p };
      }
    }

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

    const chgAmt  = latest.close - prev.close;
    const chgRate = (chgAmt/prev.close*100).toFixed(2);

    res.status(200).json({
      success: true,
      stock: { name, code, price:latest.close, chgAmt, chgRate, open:latest.open, high:latest.high, low:latest.low, volume:latest.volume },
      history,
      indicators: { ma5:ma5arr, ma20:ma20arr, ma60:ma60arr, rsi:rsiArr, bollUpper:boll.upper, bollMid:boll.mid, bollLower:boll.lower },
      analysis,
      investor,
      disclosures,
    });

  } catch(e) {
    console.error('[analyze]', e.message);
    res.status(200).json({ success:false, error:e.message });
  }
}
