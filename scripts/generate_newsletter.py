"""
썸팁 국장 브리핑 생성 스크립트
- Gemini 2.0 Flash + Google Search Grounding
- 매일 08:00 KST (UTC 23:00 전날) GitHub Actions 실행
- 결과를 Upstash Redis(daily_newsletter)에 저장
- 429 RESOURCE_EXHAUSTED → 70초 대기 후 최대 3회 재시도
"""

import os
import json
import datetime
import requests
from google import genai
from google.genai import types
from google.genai.errors import ClientError
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_fixed,
    before_sleep_log,
)
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


# ─── 429 판별 ─────────────────────────────────────────────────────────────────

def _is_rate_limit(exc: BaseException) -> bool:
    """Gemini 429 RESOURCE_EXHAUSTED 이면 True"""
    return isinstance(exc, ClientError) and "429" in str(exc)


# ─── Gemini 호출 (재시도 포함) ───────────────────────────────────────────────

@retry(
    retry=retry_if_exception(_is_rate_limit),
    wait=wait_fixed(70),            # 429 → 70초 대기 (분당 제한 갱신 여유)
    stop=stop_after_attempt(3),     # 최대 3회 시도 (원본 1회 + 재시도 2회)
    reraise=True,
    before_sleep=before_sleep_log(log, logging.WARNING),
)
def _generate(client: genai.Client, prompt: str) -> str:
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=prompt,
        config=types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())],
            temperature=0.75,
        ),
    )
    return response.text.strip()


# ─── Redis 저장 ──────────────────────────────────────────────────────────────

def save_to_redis(payload: dict, kv_url: str, kv_token: str):
    body = json.dumps([
        ["SET", "daily_newsletter", json.dumps(payload, ensure_ascii=False), "EX", str(26 * 3600)]
    ])
    resp = requests.post(
        f"{kv_url}/pipeline",
        headers={
            "Authorization": f"Bearer {kv_token}",
            "Content-Type":  "application/json",
        },
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

    # KST 날짜
    kst       = datetime.timezone(datetime.timedelta(hours=9))
    today     = datetime.datetime.now(kst).strftime("%Y년 %m월 %d일")
    today_iso = datetime.datetime.now(kst).strftime("%Y-%m-%d")

    prompt = f"""
오늘은 {today}이다. 지금은 한국 주식시장 개장 전 아침 8시다.

[역할 및 페르소나]
너는 대한민국 주식 시장(국장)의 하루 흐름을 날카롭고 명쾌하게 요약하여 투자자들에게 전달하는
전문 뉴스레터 에디터이자 최고의 증시 분석가다.
단순한 사실 나열을 넘어 시장의 맥락을 짚어내고, 초보 투자자도 쉽게 이해할 수 있는 친절한 톤앤매너를 유지해라.

[작성 원칙]
- Google Search로 오늘({today}) 기준 최신 국내 증시 관련 뉴스를 직접 검색하여 실제 데이터 기반으로 작성해라.
- 개장 전이므로 전날 마감 수치 + 미국 나스닥·S&P500 야간 흐름 + 오늘 예상 시나리오 중심으로 작성해라.
- 아래 [HTML 구조]를 반드시 그대로 지켜라. 마크다운, 코드블록, 추가 설명 없이 순수 HTML만 출력해라.
- 금융 전문 용어는 쉽게 풀어 설명하고, 독자에게 '지적 즐거움'을 주는 비하인드 스토리를 반드시 포함해라.

[HTML 구조 — 이 형식 외 어떤 텍스트도 출력 금지]

<h1 class="nl-headline">[오늘 국장 흐름을 단 한 줄로 요약하는 매력적인 제목]</h1>
<p class="nl-meta">{today} · 썸팁 국장 브리핑</p>

<section class="nl-section">
<h2>[전일 마감·미국 시장·오늘 예상 흐름을 담은 임팩트 있는 한 문장]</h2>
<p>[전날 코스피·코스닥 마감 수치, 미국 나스닥·S&P500 야간 흐름, 오늘 국장 방향 예상 2~3문장]</p>
<h3>읽기쉬운 해석</h3>
<p>[주식 초보자도 이해할 수 있도록 왜 이런 흐름인지 거시경제·대외 변수와 연결해 쉽게 설명]</p>
</section>

<section class="nl-section">
<h2>[오늘 국장에서 가장 뜨거울 핵심 이슈·테마 제목]</h2>
<p>[오늘 시장을 움직일 핵심 이슈 타임라인과 현황 딥다이브 분석]</p>
<h3>시장 영향력 분석</h3>
<p>[이 이슈가 왜 중요한지, 어떤 섹터에 어떤 영향을 미치는지]</p>
<h3>향후 관점 포인트</h3>
<p>[투자자들이 오늘·이번 주 체크해야 할 후속 뉴스·일정·변수 가이드]</p>
</section>

<section class="nl-section">
<h2>주요 대형주 및 섹터 동향</h2>
<ul class="nl-list">
<li><b><a href="URL" target="_blank">[섹터/종목] 뉴스 타이틀</a></b><br> - 핵심 내용 및 주가 움직임 요약</li>
<li><b><a href="URL" target="_blank">[섹터/종목] 뉴스 타이틀</a></b><br> - 핵심 내용 및 주가 움직임 요약</li>
<li><b><a href="URL" target="_blank">[섹터/종목] 뉴스 타이틀</a></b><br> - 핵심 내용 및 주가 움직임 요약</li>
</ul>
</section>

<section class="nl-section">
<h2>오늘의 여의도 TMI &amp; 비하인드</h2>
<p>[오늘 이슈와 관련된 흥미롭고 숨겨진 비하인드 스토리. 무릎을 탁 칠 만한 Intellectual Entertainment]</p>
</section>
"""

    log.info(f"[gemini] 브리핑 생성 시작 ({today})...")

    client = genai.Client(api_key=api_key)

    try:
        html = _generate(client, prompt)
    except ClientError as e:
        log.error(f"[gemini] 최대 재시도 초과 — {e}")
        # 실패해도 에러 상태를 Redis에 저장해 프런트에 안내 표시
        err_payload = {
            "html":        f'<p style="color:#9ca3af;text-align:center;padding:40px;">오늘 브리핑 생성에 실패했습니다. 잠시 후 다시 확인해 주세요.<br><small>{e}</small></p>',
            "date":        today,
            "dateIso":     today_iso,
            "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "error":       str(e),
        }
        save_to_redis(err_payload, kv_url, kv_token)
        return

    # 혹시 포함된 마크다운 코드블록 제거
    if html.startswith("```"):
        lines = html.split("\n")
        html  = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])

    log.info(f"[gemini] 생성 완료 ({len(html)}자)")
    log.info(html[:200] + " ...")

    payload = {
        "html":        html,
        "date":        today,
        "dateIso":     today_iso,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    save_to_redis(payload, kv_url, kv_token)
    log.info("=== 완료 ===")


if __name__ == "__main__":
    run()
