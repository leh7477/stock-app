const TIMEOUT_MS = 7000;

async function timedFetch(url, options = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

function kstDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * -86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function fmtDate(s) {
  return `${parseInt(s.slice(4, 6))}/${parseInt(s.slice(6, 8))}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const key = process.env.DART_API_KEY;
  const today = kstDateStr(0);
  const weekAgo = kstDateStr(7);

  try {
    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${key}&bgn_de=${weekAgo}&end_de=${today}&pblntf_ty=B&page_count=20&sort=date&sort_mth=desc`;
    const data = await timedFetch(url).then(r => r.json());

    if (data.status !== '000') throw new Error('DART: ' + data.message);

    const disclosures = (data.list || [])
      .filter(item => item.corp_cls === 'Y' || item.corp_cls === 'K')
      .slice(0, 8)
      .map(item => ({
        corpName: item.corp_name,
        reportName: item.report_nm,
        date: fmtDate(item.rcept_dt),
        market: item.corp_cls === 'Y' ? '유가' : '코스닥',
        url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
      }));

    res.status(200).json({ success: true, disclosures });
  } catch (e) {
    console.error('[dart]', e.message);
    res.status(200).json({ success: true, disclosures: [], _err: e.message });
  }
}
