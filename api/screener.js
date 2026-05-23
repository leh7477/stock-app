const TIMEOUT_MS = 8000;

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
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
  }).then(r => r.json());
  const token = data.access_token;
  if (!token) throw new Error('KIS 토큰 실패');
  await timedFetch(`${redisUrl}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', 'kis_token', token, 'EX', '82800']]),
  });
  return token;
}

function parseNum(s) {
  return parseInt(String(s || '0').replace(/,/g, '')) || 0;
}

function parseFloat2(s) {
  return parseFloat(String(s || '0').replace(/,/g, '')) || 0;
}

// KIS 거래대금 상위 (FHPST01700000)
async function fetchTradingValue(token, market = 'J') {
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: market,
    fid_cond_scr_div_code: '20171',
    fid_input_iscd: '0001',
    fid_div_cls_code: '0',
    fid_blng_cls_code: '0',
    fid_trgt_cls_code: '111111111',
    fid_trgt_exls_cls_code: '000000',
    fid_input_price_1: '',
    fid_input_price_2: '',
    fid_vol_cnt: '',
    fid_input_date_1: '',
  });
  const res = await timedFetch(
    `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/ranking/trading-value?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
        'tr_id': 'FHPST01700000',
        custtype: 'P',
        'Content-Type': 'application/json',
      },
    }
  ).then(r => r.json());
  return res;
}

// KIS 등락률 상위 (FHPST01810000)
async function fetchFluctuation(token, market = 'J', direction = 'up') {
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: market,
    fid_cond_scr_div_code: '20188',
    fid_input_iscd: '0001',
    fid_rank_sort_cls_code: direction === 'up' ? '0' : '1',  // 0=상승률, 1=하락률
    fid_input_cnt_1: '0',
    fid_prc_cls_code: '1',
    fid_input_price_1: '',
    fid_input_price_2: '',
    fid_vol_cnt: '',
    fid_trgt_cls_code: '0',
    fid_trgt_exls_cls_code: '0',
    fid_div_cls_code: '0',
    fid_rsfl_rate1: '',
    fid_rsfl_rate2: '',
  });
  const res = await timedFetch(
    `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/ranking/fluctuation?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
        'tr_id': 'FHPST01810000',
        custtype: 'P',
        'Content-Type': 'application/json',
      },
    }
  ).then(r => r.json());
  return res;
}

function mapTradingItem(item) {
  return {
    rank: parseNum(item.data_rank),
    code: item.mksc_shrn_iscd || item.stck_shrn_iscd || '',
    name: item.hts_kor_isnm || '',
    price: parseNum(item.stck_prpr),
    chgRate: parseFloat2(item.prdy_ctrt),
    chgAmt: parseNum(item.prdy_vrss),
    volume: parseNum(item.acml_vol),
    tradingValue: parseNum(item.acml_tr_pbmn),
  };
}

function mapFluctuationItem(item) {
  return {
    rank: parseNum(item.data_rank),
    code: item.mksc_shrn_iscd || item.stck_shrn_iscd || '',
    name: item.hts_kor_isnm || '',
    price: parseNum(item.stck_prpr),
    chgRate: parseFloat2(item.prdy_ctrt),
    chgAmt: parseNum(item.prdy_vrss),
    volume: parseNum(item.acml_vol),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  const type = req.query?.type || 'trading-value'; // trading-value | gainers | losers
  const market = req.query?.market || 'J'; // J=KOSPI, Q=KOSDAQ

  try {
    const token = await getKisToken();

    let raw, items;
    if (type === 'trading-value') {
      raw = await fetchTradingValue(token, market);
      console.log('[screener] trading-value rt_cd:', raw?.rt_cd, 'msg:', raw?.msg1, 'output len:', raw?.output?.length);
      items = (raw?.output || []).slice(0, 20).map(mapTradingItem).filter(i => i.code);
    } else if (type === 'gainers') {
      raw = await fetchFluctuation(token, market, 'up');
      console.log('[screener] gainers rt_cd:', raw?.rt_cd, 'output len:', raw?.output?.length);
      items = (raw?.output || []).slice(0, 20).map(mapFluctuationItem).filter(i => i.code);
    } else if (type === 'losers') {
      raw = await fetchFluctuation(token, market, 'down');
      console.log('[screener] losers rt_cd:', raw?.rt_cd, 'output len:', raw?.output?.length);
      items = (raw?.output || []).slice(0, 20).map(mapFluctuationItem).filter(i => i.code);
    } else {
      return res.status(200).json({ success: false, error: '잘못된 type 파라미터' });
    }

    if (!items || items.length === 0) {
      return res.status(200).json({
        success: false,
        error: '데이터 없음 (장 마감 후이거나 API 오류)',
        debug: { rt_cd: raw?.rt_cd, msg1: raw?.msg1 },
      });
    }

    res.status(200).json({ success: true, type, market, items });
  } catch (e) {
    console.error('[screener]', e.message);
    res.status(200).json({ success: false, error: e.message });
  }
}
