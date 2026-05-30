"""
전종목 해자(경제적 해자) 분석 스크립트 (분기 1회 실행)
- recommend_v2 Redis에서 전종목 로드
- 종목명 + 섹터 → Gemini 배치 분석 → 해자 유형/설명/점수 생성
- Redis moat_analysis에 저장 (TTL 95일)
"""

import os
import json
import re
import time
import requests
import logging
from google import genai
from google.genai.errors import ClientError
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential, before_sleep_log

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

KV_URL     = os.environ["KV_REST_API_URL"]
KV_TOKEN   = os.environ["KV_REST_API_TOKEN"]
GEMINI_KEY = os.environ["GEMINI_API_KEY"]

BATCH_SIZE  = 20    # 요청당 종목 수 (해자 분석은 상세해서 적게)
BATCH_DELAY = 15.0  # 배치 간 대기(초)
TIMEOUT     = 30
TTL_95D     = 95 * 24 * 3600


# ─── Redis ───────────────────────────────────────────────────────────────────

def redis_get(key):
    r = requests.get(
        f"{KV_URL}/get/{key}",
        headers={"Authorization": f"Bearer {KV_TOKEN}"},
        timeout=TIMEOUT,
    )
    return r.json().get("result")


def redis_set(key, value, ttl_sec):
    requests.post(
        f"{KV_URL}/pipeline",
        headers={"Authorization": f"Bearer {KV_TOKEN}", "Content-Type": "application/json"},
        json=[["SET", key, json.dumps(value, ensure_ascii=False), "EX", str(ttl_sec)]],
        timeout=TIMEOUT,
    )


# ─── Gemini 해자 분석 ─────────────────────────────────────────────────────────

def _is_retryable(exc: BaseException) -> bool:
    msg = str(exc)
    if not isinstance(exc, ClientError):
        return False
    # 503 서버 과부하 → 재시도
    if "503" in msg or "UNAVAILABLE" in msg or "high demand" in msg:
        return True
    # 429 분당 한도 → 재시도 (단, 일일 한도 초과는 재시도 안 함)
    if ("429" in msg or "RESOURCE_EXHAUSTED" in msg or "rateLimitExceeded" in msg):
        return "PerDay" not in msg and "DAILY" not in msg.upper()
    return False


@retry(
    retry=retry_if_exception(_is_retryable),
    wait=wait_exponential(multiplier=2, min=60, max=300),
    stop=stop_after_attempt(4),
    reraise=True,
    before_sleep=before_sleep_log(log, logging.WARNING),
)
def analyze_batch(client, stocks: list) -> dict:
    """종목 리스트 → {code: 해자분석} dict 반환"""
    lines = "\n".join(
        f"{s['code']} {s['name']} / {s.get('sector', '')}"
        for s in stocks
    )

    prompt = f"""아래 한국 상장 주식 종목들의 경제적 해자(Economic Moat)를 분석해주세요.

종목 목록 (종목코드 종목명 / 업종):
{lines}

각 종목에 대해 아래 JSON 형식으로만 응답하세요:
{{
  "종목코드": {{
    "moatType": "해자 유형 (아래 6가지 중 1개)",
    "oneliner": "한 줄 핵심 사업 설명 (10자 이내)",
    "description": "왜 경쟁사가 따라잡기 어려운가 (2~3문장, 구체적 근거)",
    "scores": {{
      "switching": 전환비용 점수 1~5,
      "network": 네트워크효과 점수 1~5,
      "iprd": IP·R&D 점수 1~5,
      "costAdv": 비용우위 점수 1~5,
      "roic": 자본효율(ROIC 우수성) 점수 1~5
    }}
  }},
  ...
}}

해자 유형 6가지:
- 브랜드·무형자산: 강한 브랜드 또는 특허·라이선스 기반
- 네트워크효과: 사용자 증가로 가치 상승
- 전환비용: 고객이 다른 제품으로 바꾸기 어려움
- 비용우위: 구조적으로 낮은 원가
- IP·기술독점: 독보적 기술·특허
- 규제·라이선스: 진입장벽이 규제·허가 기반

점수 기준: 1=매우 낮음, 2=낮음, 3=보통, 4=높음, 5=매우 높음
해당 없는 항목도 반드시 1~5 점수 부여 (0 금지)
JSON 형식으로만 응답하고 다른 설명 없이 출력"""

    resp = client.models.generate_content(model="gemini-3.1-flash-lite", contents=prompt)
    text = resp.text.strip()

    m = re.search(r"\{[\s\S]+\}", text)
    if not m:
        raise ValueError(f"JSON 없음: {text[:300]}")
    return json.loads(m.group())


# ─── 메인 ────────────────────────────────────────────────────────────────────

def run():
    log.info("=== 해자 분석 생성 시작 ===")

    # 1. recommend_v2 로드
    raw = redis_get("recommend_v2")
    if not raw:
        raise RuntimeError("recommend_v2 없음 — update-stocks 먼저 실행 필요")

    data   = json.loads(raw) if isinstance(raw, str) else raw
    stocks = data.get("stocks", [])
    log.info(f"[1/3] recommend_v2 로드: {len(stocks)}개 종목")

    # 2. 기존 데이터 초기화 (개별 키 방식으로 변경 — 전체 맵 GET 용량 초과 방지)
    moat_data = {}

    # 3. Gemini 배치 분석
    client        = genai.Client(api_key=GEMINI_KEY)
    total_batches = (len(stocks) - 1) // BATCH_SIZE + 1
    errors        = 0

    for i in range(0, len(stocks), BATCH_SIZE):
        batch     = stocks[i : i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        log.info(f"[2/3] 배치 {batch_num}/{total_batches} ({len(batch)}개) 분석 중...")

        try:
            result = analyze_batch(client, batch)
            moat_data.update(result)
            log.info(f"       → {len(result)}개 완료 (누적 {len(moat_data)}개)")
        except Exception as e:
            log.error(f"       → 배치 {batch_num} 실패: {str(e)[:120]}")
            errors += 1

        if batch_num < total_batches:
            time.sleep(BATCH_DELAY)

    log.info(f"[2/3] 분석 완료: {len(moat_data)}개 (실패 배치 {errors}개)")

    if not moat_data:
        raise RuntimeError("분석 결과 없음 — Redis 저장 중단")

    # 4. 종목별 개별 키로 저장 (moat:{code}) — 파이프라인 100개씩 분할
    # 전체 맵 하나로 저장하면 1MB+ 초과로 GET 실패 → 개별 키 방식으로 해결
    log.info(f"[3/3] Redis 개별 키 저장 중... (moat:{{code}}, {len(moat_data)}개)")
    PIPE_SIZE = 100
    codes = list(moat_data.keys())
    saved = 0
    for i in range(0, len(codes), PIPE_SIZE):
        batch_codes = codes[i:i+PIPE_SIZE]
        pipeline = [
            ["SET", f"moat:{c}", json.dumps(moat_data[c], ensure_ascii=False), "EX", str(TTL_95D)]
            for c in batch_codes
        ]
        requests.post(
            f"{KV_URL}/pipeline",
            headers={"Authorization": f"Bearer {KV_TOKEN}", "Content-Type": "application/json"},
            json=pipeline,
            timeout=TIMEOUT,
        )
        saved += len(batch_codes)
    log.info(f"[3/3] 저장 완료: {saved}개 (TTL 95일)")
    log.info("=== 완료 ===")


if __name__ == "__main__":
    run()
