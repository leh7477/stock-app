"""
마켓스코어 히스토리 백필 스크립트
- 2026-05-01 ~ 어제 날짜의 일별 마켓스코어를 계산해 Redis market_history에 추가
- 기존 Redis 항목은 유지하고 없는 날짜만 채움
- supply·news·trading 컴포넌트는 역사 데이터 없으므로 null (나머지 가중치 재분배)
- 1회성 실행 (GitHub Actions workflow_dispatch)
"""

import os, json, math, datetime, time, requests

HIST_KEY  = "market_history"
HIST_TTL  = 100 * 86400   # 100일
BACKFILL_START = "20260501"   # 백필 시작일 (YYYYMMDD)

WEIGHTS = dict(
    indexPos=0.20, supply=0.20, trading=0.15,
    nasdaq=0.15,   usd=0.10,   vix=0.10, news=0.10
)

NAVER_UA = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    "Referer":    "https://m.stock.naver.com",
}
TIMEOUT = 20


# ─── 점수 계산 (api/market.js 와 동일) ────────────────────────────────────────

def clamp(v, lo, hi):
    return max(lo, min(hi, v))

def score_index_pos(kospi_rate, kosdaq_rate):
    if kospi_rate is None and kosdaq_rate is None:
        return None
    combined = (kospi_rate or 0) * 0.70 + (kosdaq_rate or 0) * 0.30
    return clamp(50 + combined * 16.67, 0, 100)

def score_nasdaq(rate):
    return None if rate is None else clamp(50 + rate * 16.67, 0, 100)

def score_usd(rate):
    return None if rate is None else clamp(50 - rate * 20, 0, 100)

def score_vix(price):
    return None if (not price or price <= 0) else clamp(150 - price * 5, 0, 100)

def calc_weighted(scores):
    total_w, total_v = 0, 0
    for key, w in WEIGHTS.items():
        s = scores.get(key)
        if s is None:
            continue
        total_v += s * w
        total_w += w
    return round(total_v / total_w) if total_w > 0 else 50


# ─── 데이터 수집 ──────────────────────────────────────────────────────────────

def fetch_naver_index(symbol, start=BACKFILL_START, end=None):
    """Naver 지수 일별 등락률 반환 → {date_str: change_rate}"""
    if end is None:
        end = datetime.datetime.now().strftime("%Y%m%d")
    url = (
        f"https://m.stock.naver.com/api/index/{symbol}/price"
        f"?startTime={start}&endTime={end}&timeframe=day"
    )
    r = requests.get(url, headers=NAVER_UA, timeout=TIMEOUT)
    r.raise_for_status()
    data = r.json()
    result = {}
    if isinstance(data, list):
        for item in data:
            date = str(item.get("localTradedAt", ""))[:10]
            if not date or len(date) < 10:
                continue
            rate_raw = item.get("fluctuationsRatio") or item.get("fluctuationRate") or "0"
            rate = float(str(rate_raw).replace(",", ""))
            result[date] = rate
    return result


def fetch_yahoo_history(symbol, days=90):
    """Yahoo Finance 일별 종가 반환 → {date_str: close_price}"""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range={days}d"
    r = requests.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    chart = r.json().get("chart", {}).get("result", [None])[0]
    if not chart:
        return {}
    timestamps = chart.get("timestamp", [])
    closes = chart.get("indicators", {}).get("quote", [{}])[0].get("close", [])
    result = {}
    for ts, price in zip(timestamps, closes):
        if price is None:
            continue
        date = datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
        result[date] = price
    return result


def prices_to_daily_rate(prices_by_date):
    """종가 dict → 일별 등락률 dict  (close[d] - close[d-1]) / close[d-1] * 100"""
    sorted_dates = sorted(prices_by_date)
    rates = {}
    for i in range(1, len(sorted_dates)):
        d0, d1 = sorted_dates[i - 1], sorted_dates[i]
        p0, p1 = prices_by_date[d0], prices_by_date[d1]
        if p0:
            rates[d1] = (p1 - p0) / p0 * 100
    return rates


# ─── MA20 적용 ────────────────────────────────────────────────────────────────

def apply_ma20(entries_asc):
    """오래된 순(asc)으로 입력받아 MA20 적용 후 score 반환 (in-place)"""
    for i, e in enumerate(entries_asc):
        prev = entries_asc[max(0, i - 20):i]
        if not prev:
            e["score"]  = e["rawScore"]
            e["ma20"]   = None
            e["maLen"]  = 0
        else:
            n  = len(prev)
            ma = sum(p["rawScore"] for p in prev) / n
            e["score"]  = max(0, min(100, round(0.40 * e["rawScore"] + 0.60 * ma)))
            e["ma20"]   = round(ma)
            e["maLen"]  = n
    return entries_asc


# ─── Redis ────────────────────────────────────────────────────────────────────

def redis_get_list(key, kv_url, kv_token):
    r = requests.get(
        f"{kv_url}/get/{key}",
        headers={"Authorization": f"Bearer {kv_token}"},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    raw = r.json().get("result")
    return json.loads(raw) if raw else []


def redis_set(key, value, ttl, kv_url, kv_token):
    body = json.dumps([[
        "SET", key, json.dumps(value, ensure_ascii=False), "EX", str(ttl)
    ]])
    r = requests.post(
        f"{kv_url}/pipeline",
        headers={"Authorization": f"Bearer {kv_token}", "Content-Type": "application/json"},
        data=body,
        timeout=TIMEOUT,
    )
    r.raise_for_status()


# ─── 메인 ────────────────────────────────────────────────────────────────────

def run():
    kv_url   = os.environ.get("KV_REST_API_URL")
    kv_token = os.environ.get("KV_REST_API_TOKEN")
    if not kv_url or not kv_token:
        print("[!] Redis 환경변수 없음 — 종료"); return

    kst       = datetime.timezone(datetime.timedelta(hours=9))
    today_str = datetime.datetime.now(kst).strftime("%Y-%m-%d")
    print(f"[백필] 기준일: {today_str}, 시작일: {BACKFILL_START[:4]}-{BACKFILL_START[4:6]}-{BACKFILL_START[6:]}")

    # ── 1) Naver 지수 수집 ──────────────────────────────────────
    print("[1] Naver 코스피·코스닥 등락률 수집 중...")
    kospi_rates  = fetch_naver_index("KOSPI")
    time.sleep(1)
    kosdaq_rates = fetch_naver_index("KOSDAQ")
    print(f"    코스피 {len(kospi_rates)}일, 코스닥 {len(kosdaq_rates)}일")

    # ── 2) Yahoo Finance 수집 ───────────────────────────────────
    print("[2] Yahoo Finance 나스닥·환율·VIX 수집 중...")
    nasdaq_prices = fetch_yahoo_history("%5EIXIC",    90)
    time.sleep(0.5)
    usd_prices    = fetch_yahoo_history("USDKRW%3DX", 90)
    time.sleep(0.5)
    vix_prices    = fetch_yahoo_history("%5EVIX",     90)

    nasdaq_rates = prices_to_daily_rate(nasdaq_prices)
    usd_rates    = prices_to_daily_rate(usd_prices)
    print(f"    나스닥 {len(nasdaq_rates)}일, USD/KRW {len(usd_rates)}일, VIX {len(vix_prices)}일")

    # ── 3) 기존 Redis 히스토리 로드 ────────────────────────────
    print("[3] 기존 Redis 히스토리 읽는 중...")
    existing = redis_get_list(HIST_KEY, kv_url, kv_token)
    existing_by_date = {e["date"]: e for e in existing}
    print(f"    기존 {len(existing)}개 항목")

    # ── 4) 백필 대상 거래일 = KOSPI 데이터가 있는 날 중 오늘 제외 ─
    backfill_start_iso = f"{BACKFILL_START[:4]}-{BACKFILL_START[4:6]}-{BACKFILL_START[6:]}"
    trading_days = sorted([
        d for d in kospi_rates
        if d >= backfill_start_iso and d < today_str
    ])
    print(f"[4] 백필 대상 거래일 {len(trading_days)}개")

    # ── 5) 각 날짜 점수 계산 ───────────────────────────────────
    new_entries = []
    skipped = 0
    for date in trading_days:
        if date in existing_by_date:
            skipped += 1
            continue  # 이미 있는 날짜는 스킵

        kospi_r  = kospi_rates.get(date)
        kosdaq_r = kosdaq_rates.get(date)
        nasdaq_r = nasdaq_rates.get(date)
        usd_r    = usd_rates.get(date)
        vix_p    = vix_prices.get(date)

        raw_scores = {
            "indexPos": score_index_pos(kospi_r, kosdaq_r),
            "supply":   None,    # 역사 수급 데이터 없음
            "trading":  None,    # 역사 거래대금 없음
            "nasdaq":   score_nasdaq(nasdaq_r),
            "usd":      score_usd(usd_r),
            "vix":      score_vix(vix_p),
            "news":     None,    # 역사 뉴스 없음
        }

        raw = calc_weighted(raw_scores)

        # ts: 해당 날짜 KST 00:00 기준 Unix ms
        y, mo, d_ = int(date[:4]), int(date[5:7]), int(date[8:10])
        ts = int(datetime.datetime(y, mo, d_, tzinfo=kst).timestamp() * 1000)

        new_entries.append({
            "date":       date,
            "rawScore":   raw,
            "score":      raw,   # MA20 적용 전 임시값 (아래에서 덮어씀)
            "ts":         ts,
            "components": {k: (round(v) if v is not None else None) for k, v in raw_scores.items()},
            "_backfill":  True,  # 백필 항목 표시 (선택)
        })

    print(f"    신규 계산 {len(new_entries)}개, 스킵(기존) {skipped}개")

    if not new_entries:
        print("[!] 추가할 데이터가 없습니다.")
        return

    # ── 6) MA20 적용 (오래된 순 → 새 순) ──────────────────────
    # 기존 항목 + 신규 항목 합쳐서 날짜 오름차순 정렬 후 MA20 계산
    all_entries = list(existing_by_date.values()) + new_entries
    all_entries.sort(key=lambda x: x["date"])
    apply_ma20(all_entries)   # in-place

    # ── 7) 최신순으로 정렬, 90일 trim, Redis 저장 ──────────────
    all_entries.sort(key=lambda x: x["date"], reverse=True)
    trimmed = all_entries[:90]

    print(f"[5] Redis 저장 중 ({len(trimmed)}개)...")
    redis_set(HIST_KEY, trimmed, HIST_TTL, kv_url, kv_token)

    # 캐시 무효화 (market_v4)
    try:
        requests.post(
            f"{kv_url}/del/market_v4",
            headers={"Authorization": f"Bearer {kv_token}"},
            timeout=10,
        )
        print("    market_v4 캐시 무효화 완료")
    except Exception:
        pass

    print("\n=== 백필 완료 ===")
    print(f"{'날짜':<12} {'raw':>4} {'score':>5} {'maLen':>5}")
    print("-" * 28)
    for e in trimmed[:10]:
        print(f"{e['date']:<12} {e['rawScore']:>4} {e['score']:>5} {e.get('maLen', 0):>5}")
    if len(trimmed) > 10:
        print(f"  ... (총 {len(trimmed)}개)")


if __name__ == "__main__":
    run()
