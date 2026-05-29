"""
썸팁 국장 브리핑 생성 스크립트
- Python이 먼저 뉴스·시세를 수집 → Gemini에 단 1회만 요청 (AFC/Function Calling 없음)
- 매일 08:00 KST (UTC 23:00 전날) GitHub Actions 실행
- 결과를 Upstash Redis(daily_newsletter)에 저장
"""

import os
import json
import datetime
import time
import xml.etree.ElementTree as ET
import requests
import logging
from google import genai
from google.genai import types
from google.genai.errors import ClientError
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
    before_sleep_log,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


# ─── 뉴스 수집 ───────────────────────────────────────────────────────────────

def fetch_news() -> str:
    """Google News RSS에서 한국 증시 최신 뉴스 15건 수집 (URL 포함)"""
    url = (
        "https://news.google.com/rss/search"
        "?q=코스피+코스닥+주식시장+증시&hl=ko&gl=KR&ceid=KR:ko"
    )
    try:
        resp = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        root = ET.fromstring(resp.content)
        items = root.findall(".//item")[:15]
        lines = []
        for item in items:
            title   = item.findtext("title",   "").strip()
            link    = item.findtext("link",    "#").strip() or item.findtext("guid", "#").strip()
            pubdate = item.findtext("pubDate", "").strip()
            if title:
                lines.append(f"- 제목: {title}\n  URL: {link}\n  날짜: {pubdate}")
        result = "\n".join(lines)
        log.info(f"[news] {len(lines)}건 수집 완료")
        return result or "(뉴스 수집 결과 없음)"
    except Exception as e:
        log.warning(f"[news] 수집 실패: {e}")
        return "(뉴스 수집 실패)"


# ─── 시장 데이터 수집 ─────────────────────────────────────────────────────────

def fetch_market() -> str:
    """Yahoo Finance에서 KOSPI·KOSDAQ·나스닥·S&P500 최근 종가 수집"""
    symbols = {
        "KOSPI":  "^KS11",
        "KOSDAQ": "^KQ11",
        "나스닥":  "^IXIC",
        "S&P500": "^GSPC",
    }
    lines = []
    for name, sym in symbols.items():
        try:
            url  = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d"
            data = requests.get(url, timeout=8, headers={"User-Agent": "Mozilla/5.0"}).json()
            result = data["chart"]["result"][0]
            closes = result["indicators"]["quote"][0]["close"]
            valid  = [c for c in closes if c is not None]
            if len(valid) >= 2:
                prev, last = valid[-2], valid[-1]
                chg = (last - prev) / prev * 100
                sign = "+" if chg >= 0 else ""
                lines.append(f"- {name}: {last:,.2f}  전일대비 {sign}{chg:.2f}%")
            elif valid:
                lines.append(f"- {name}: {valid[-1]:,.2f}")
        except Exception as e:
            log.warning(f"[market] {name} 수집 실패: {e}")

    result = "\n".join(lines)
    log.info(f"[market] {len(lines)}개 지수 수집 완료")
    return result or "(시장 데이터 수집 실패)"


# ─── Gemini 단발 호출 (재시도 포함) ──────────────────────────────────────────

def _is_retryable(exc: BaseException) -> bool:
    msg = str(exc)
    return isinstance(exc, ClientError) and (
        "429" in msg or "RESOURCE_EXHAUSTED" in msg or "rateLimitExceeded" in msg
    ) and "PerDay" not in msg and "DAILY" not in msg.upper()


@retry(
    retry=retry_if_exception(_is_retryable),
    wait=wait_exponential(multiplier=2, min=60, max=300),
    stop=stop_after_attempt(4),
    reraise=True,
    before_sleep=before_sleep_log(log, logging.WARNING),
)
def _generate(client: genai.Client, prompt: str) -> str:
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.75,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        ),
    )
    return response.text.strip()


# ─── Redis 저장 ──────────────────────────────────────────────────────────────

def save_to_redis(payload: dict, kv_url: str, kv_token: str, sentiment_score: int | None = None,
                  news_boost: dict | None = None):
    pipeline = [
        ["SET", "daily_newsletter", json.dumps(payload, ensure_ascii=False), "EX", str(26 * 3600)]
    ]
    if sentiment_score is not None:
        kst_date = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime("%Y-%m-%d")
        senti_payload = json.dumps({
            "score":    sentiment_score,
            "source":   "ai_briefing",
            "note":     payload.get("date", ""),
            "date":     kst_date,
            "storedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }, ensure_ascii=False)
        pipeline.append(["SET", "market_sentiment", senti_payload, "EX", str(26 * 3600)])
        pipeline.append(["DEL", "market_v4"])  # 마켓스코어 캐시 무효화
        log.info(f"[sentiment] 점수 저장: {sentiment_score}")
    if news_boost is not None:
        pipeline.append(["SET", "news_boost", json.dumps(news_boost, ensure_ascii=False), "EX", str(26 * 3600)])
        log.info(f"[news_boost] 저장: {news_boost}")
    body = json.dumps(pipeline)
    resp = requests.post(
        f"{kv_url}/pipeline",
        headers={"Authorization": f"Bearer {kv_token}", "Content-Type": "application/json"},
        data=body,
        timeout=15,
    )
    resp.raise_for_status()
    log.info(f"[redis] 저장 완료 — status: {resp.status_code}")


# ─── 메인 ────────────────────────────────────────────────────────────────────

def run():
    api_key  = os.environ.get("GEMINI_API_KEY")
    kv_url   = os.environ.get("KV_REST_API_URL")
    kv_token = os.environ.get("KV_REST_API_TOKEN")

    if not api_key:
        log.error("[!] GEMINI_API_KEY 없음 — 종료"); return
    if not kv_url or not kv_token:
        log.error("[!] Redis 환경변수 없음 — 종료"); return

    kst       = datetime.timezone(datetime.timedelta(hours=9))
    today     = datetime.datetime.now(kst).strftime("%Y년 %m월 %d일")
    today_iso = datetime.datetime.now(kst).strftime("%Y-%m-%d")

    # 1단계: 데이터 먼저 수집
    log.info("[step 1] 뉴스·시장 데이터 수집 중...")
    news_text   = fetch_news()
    market_text = fetch_market()
    time.sleep(1)  # 수집 후 잠시 대기

    # 2단계: Gemini에 단 1회 요청
    log.info(f"[step 2] Gemini 브리핑 생성 시작 ({today})...")

    prompt = f"""오늘은 {today}이다.

[사전 수집된 시장 데이터]
{market_text}

[사전 수집된 당일 뉴스 데이터]
{news_text}

---

[역할 및 페르소나]
너는 대한민국 주식 시장(국장)의 하루 흐름을 날카롭고 명쾌하게 요약하여 투자자들에게 전달하는 전문 뉴스레터 에디터이자 최고의 증시 분석가이다.
단순한 사실 나열을 넘어 시장의 맥락을 짚어내고, 초보 투자자도 쉽게 이해할 수 있는 친절한 톤앤매너를 유지해라.

[작성 원칙]
- 제공되는 당일 시황 및 뉴스 데이터를 바탕으로 아래 [Content Guidelines]의 HTML 구조를 엄격히 준수하여 한국어로 작성해라.
- 금융 전문 용어는 쉽게 풀어서 설명하고, 독자에게 '지적 즐거움(Intellectual Entertainment)'을 선사하는 비하인드 스토리를 반드시 포함해라.

---

[Content Guidelines]

1. **Main Headline**
   - 오늘 하루 대한민국 증시(국장)의 전체적인 흐름을 단 한 줄로 요약하는 캐치하고 매력적인 한글 제목을 작성해라.

2. **Section 1: Market Flow**
   - **H2 Title**: 오늘 코스피/코스닥 시황을 요약하는 임팩트 있는 한 문장 문구. (예: '코스피, 외인·기관 양매도에 2,550선 후퇴…반도체 동반 약세')
   - **Content**: 코스피와 코스닥 지수의 마감 수치, 등락 폭, 그리고 시장을 움직인 핵심 수급 주체(외인, 기관, 개인)의 움직임과 하락/상승 원인을 2~3문장으로 명확히 요약해라.
   - **H3 (Sub)**: '읽기쉬운 해석' (오늘 시장이 왜 이렇게 움직였는지 주식 초보자도 바로 이해할 수 있도록 거시경제나 대외 변수와 연결하여 쉽게 설명해라.)

3. **Section 2: Focus Issue**
   - **H2 Title**: 오늘 국장에서 가장 뜨거웠던 최고의 핵심 이슈나 주도 테마를 제목으로 작성해라. (예: '고려아연 경영권 분쟁 격화, 지분 싸움에 장중 변동성 극대화')
   - **Content**: 오늘 시장을 뒤흔든 가장 중요한 #1 뉴스 또는 테마의 타임라인과 구체적인 현황을 딥다이브하여 상세히 분석해라.
   - **H3 (Sub)**: '시장 영향력 분석' (이 이슈가 오늘 국장 전체 또는 특정 섹터에 왜 강력한 영향을 미쳤는지 그 중요성을 서술해라.)
   - **H3 (Sub)**: '향후 관점 포인트' (투자자들이 앞으로 이 이슈와 관련해서 어떤 후속 뉴스나 일정, 변수를 눈여겨보아야 하는지 가이드를 제시해라.)

4. **Section 3: Sector Watch**
   - **H2 Title**: '주요 대형주 및 섹터 동향'
   - **Content**: 주도 테마 외에 오늘 주목해야 할 국장의 3가지 핵심 뉴스나 섹터(예: 2차전지, 바이오, 엔터, 원전 등)의 개별 종목 흐름을 픽업해라.
   - **Format**: 아래의 HTML 형식을 반드시 칼같이 지켜서 리스트 형태로 출력해라. 뉴스 원본에 제공된 실제 URL이 있다면 매핑하고, 없다면 '#'으로 처리해라.
   `<li><b><a href='URL' target='_blank'>[섹터명/종목명] 뉴스 및 종목 타이틀</a></b><br> - 핵심 내용 및 주가 움직임 요약...</li>`

5. **Section 4: Yeouido TMI (Fun/Interesting Fact)**
   - **H2 Title**: '오늘의 여의도 TMI & 비하인드'
   - **Content**: 흔한 증시 리포트의 딱딱한 분석 대신, 오늘 급등락한 기업의 역사적 배경, CEO의 과거 흥미로운 발언, 과거 증시 역사 속 유사 사례, 혹은 여의도 증권가 찌라시 뒤편의 비하인드 스토리 등 흥미진진하고 약간은 숨겨진 이야기를 들려주어라.
   - **Goal**: 독자가 글을 읽고 무릎을 탁 칠 만한 흥미롭고 유익한 'Intellectual Entertainment'를 제공해야 한다.

---

[HTML 출력 형식 — 마크다운·코드블록·추가 설명 없이 순수 HTML만 출력, 마지막에 반드시 아래 태그 5개 추가]

HTML 출력이 모두 끝난 후 아래 5개 태그를 순서대로 맨 마지막에 출력해라.

① 오늘 뉴스에서 직접 수혜가 확실한 종목 코드(6자리, 확실한 것만 최대 5개)와 수혜 섹터 키워드(최대 3개, 예: 반도체,방산,원전):
<!--BOOST_CODES:코드1,코드2-->
<!--BOOST_SECTORS:키워드1,키워드2-->

② 오늘 뉴스에서 직접 악재가 있는 종목 코드(6자리, 확실한 것만 최대 5개)와 피해 섹터 키워드(최대 3개):
<!--PENALTY_CODES:코드1,코드2-->
<!--PENALTY_SECTORS:키워드1,키워드2-->

③ 오늘 국장 전체 투자심리 점수 (0=극도의 공포·폭락, 25=약세, 50=중립, 75=강세, 100=극도의 탐욕·급등):
<!--SENTIMENT:점수-->

종목코드 불확실하면 빈칸 허용 (예: <!--BOOST_CODES:-->). 섹터 키워드는 한 단어로 간결하게.

[HTML 출력 형식]

<h1 class="nl-headline">[Main Headline]</h1>
<p class="nl-meta">{today} · 썸팁 국장 브리핑</p>

<section class="nl-section">
<h2>[Section 1 H2]</h2>
<p>[Section 1 Content]</p>
<h3>읽기쉬운 해석</h3>
<p>[Interpretation]</p>
</section>

<section class="nl-section">
<h2>[Section 2 H2]</h2>
<p>[Section 2 Content]</p>
<h3>시장 영향력 분석</h3>
<p>[Market Impact Analysis]</p>
<h3>향후 관점 포인트</h3>
<p>[Future Viewpoints]</p>
</section>

<section class="nl-section">
<h2>주요 대형주 및 섹터 동향</h2>
<ul class="nl-list">
<li><b><a href='URL' target='_blank'>[섹터명/종목명] 뉴스 및 종목 타이틀</a></b><br> - 핵심 내용 및 주가 움직임 요약</li>
<li><b><a href='URL' target='_blank'>[섹터명/종목명] 뉴스 및 종목 타이틀</a></b><br> - 핵심 내용 및 주가 움직임 요약</li>
<li><b><a href='URL' target='_blank'>[섹터명/종목명] 뉴스 및 종목 타이틀</a></b><br> - 핵심 내용 및 주가 움직임 요약</li>
</ul>
</section>

<section class="nl-section">
<h2>오늘의 여의도 TMI &amp; 비하인드</h2>
<p>[TMI Content]</p>
</section>"""

    client = genai.Client(api_key=api_key)

    try:
        html = _generate(client, prompt)
    except ClientError as e:
        err_str = str(e)
        log.error(f"[gemini] 생성 실패 — {err_str[:200]}")
        msg = (
            '<p style="color:#9ca3af;text-align:center;padding:40px;">'
            '오늘 브리핑 생성에 실패했습니다. 잠시 후 다시 확인해 주세요.'
            '</p>'
        )
        save_to_redis({"html": msg, "date": today, "dateIso": today_iso,
                       "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                       "error": err_str[:300]}, kv_url, kv_token)
        return

    if html.startswith("```"):
        lines = html.split("\n")
        html  = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])

    # 태그 파싱 및 HTML에서 제거
    import re

    def _parse_tag(text, tag):
        m = re.search(rf'<!--{tag}:(.*?)-->', text)
        if not m:
            return []
        return [v.strip() for v in m.group(1).split(',') if v.strip()]

    # BOOST / PENALTY 파싱 (종목코드는 6자리 숫자만 허용)
    boost_codes    = [c for c in _parse_tag(html, 'BOOST_CODES')   if re.fullmatch(r'\d{6}', c)]
    boost_sectors  = _parse_tag(html, 'BOOST_SECTORS')
    penalty_codes  = [c for c in _parse_tag(html, 'PENALTY_CODES') if re.fullmatch(r'\d{6}', c)]
    penalty_sectors = _parse_tag(html, 'PENALTY_SECTORS')
    log.info(f"[news_boost] BOOST 종목:{boost_codes} 섹터:{boost_sectors} / PENALTY 종목:{penalty_codes} 섹터:{penalty_sectors}")

    # SENTIMENT 파싱
    sentiment_score = None
    m = re.search(r'<!--SENTIMENT:(\d+)-->', html)
    if m:
        sentiment_score = max(0, min(100, int(m.group(1))))
        log.info(f"[sentiment] 파싱 완료: {sentiment_score}")
    else:
        log.warning("[sentiment] 점수 태그 없음")

    # 모든 태그 HTML에서 제거
    for tag in ['BOOST_CODES', 'BOOST_SECTORS', 'PENALTY_CODES', 'PENALTY_SECTORS', 'SENTIMENT']:
        html = re.sub(rf'<!--{tag}:.*?-->', '', html)
    html = html.rstrip()

    log.info(f"[gemini] 생성 완료 ({len(html)}자)")

    payload = {
        "html":        html,
        "date":        today,
        "dateIso":     today_iso,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    kst_date = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime("%Y-%m-%d")
    news_boost_payload = {
        "boostCodes":    boost_codes,
        "boostSectors":  boost_sectors,
        "penaltyCodes":  penalty_codes,
        "penaltySectors": penalty_sectors,
        "date":     kst_date,
        "storedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    } if (boost_codes or boost_sectors or penalty_codes or penalty_sectors) else None

    save_to_redis(payload, kv_url, kv_token, sentiment_score, news_boost_payload)
    log.info("=== 완료 ===")


if __name__ == "__main__":
    run()
