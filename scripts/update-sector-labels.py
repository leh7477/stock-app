"""
전종목 테마 섹터 분류 스크립트 (주 1회 실행)
- recommend_v2 Redis에서 전종목 로드
- 종목명 + KIS 업종명 → Gemini 배치 분류 → 테마 섹터명 생성
- Redis sector_labels에 저장 (TTL 8일)
"""

import os
import json
import re
import time
import requests
import logging
from google import genai

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

KV_URL     = os.environ["KV_REST_API_URL"]
KV_TOKEN   = os.environ["KV_REST_API_TOKEN"]
GEMINI_KEY = os.environ["GEMINI_API_KEY"]

BATCH_SIZE    = 150   # Gemini 1회 요청당 종목 수
BATCH_DELAY   = 2.0   # 배치 간 대기(초) — Rate Limit 방지
TIMEOUT       = 20
TTL_8D        = 8 * 24 * 3600


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


# ─── Gemini 배치 분류 ─────────────────────────────────────────────────────────

def classify_batch(client, stocks: list) -> dict:
    """종목 리스트 → {code: 테마명} dict 반환"""
    lines = "\n".join(
        f"{s['code']} {s['name']} / {s.get('sector', '')}"
        for s in stocks
    )

    prompt = f"""아래 한국 주식 종목들의 테마 섹터명을 현재 주식시장 트렌드에 맞게 분류해주세요.

종목 목록 (종목코드 종목명 / KIS업종명):
{lines}

분류 규칙:
- 지금 한국 주식시장에서 실제 통용되는 테마명으로 분류 (아래 예시 참고)
- 예시: 메모리·HBM, AI서버기판·패키징, 반도체장비·소재, 파운드리·후공정,
        2차전지·소재, 전기차·부품, 자동차·부품, 조선·해운, 방산·항공,
        K-푸드·음료, 바이오·신약, 의료기기·헬스케어, 게임·엔터,
        인터넷·플랫폼, 금융·보험, 건설·부동산, 원전·에너지, 화학·정유
- 테마명은 12자 이내
- 반드시 JSON 형식으로만 응답: {{"종목코드": "테마명", ...}}"""

    resp = client.models.generate_content(model="gemini-2.0-flash", contents=prompt)
    text = resp.text.strip()

    m = re.search(r"\{[\s\S]+\}", text)
    if not m:
        raise ValueError(f"JSON 없음: {text[:300]}")
    return json.loads(m.group())


# ─── 메인 ────────────────────────────────────────────────────────────────────

def run():
    log.info("=== 테마 섹터 분류 시작 ===")

    # 1. recommend_v2 로드
    raw = redis_get("recommend_v2")
    if not raw:
        raise RuntimeError("recommend_v2 없음 — update-stocks 먼저 실행 필요")

    data   = json.loads(raw) if isinstance(raw, str) else raw
    stocks = data.get("stocks", [])
    log.info(f"[1/3] recommend_v2 로드: {len(stocks)}개 종목")

    # 2. Gemini 배치 분류
    client        = genai.Client(api_key=GEMINI_KEY)
    sector_labels = {}
    total_batches = (len(stocks) - 1) // BATCH_SIZE + 1
    errors        = 0

    for i in range(0, len(stocks), BATCH_SIZE):
        batch     = stocks[i : i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        log.info(f"[2/3] 배치 {batch_num}/{total_batches} ({len(batch)}개) 분류 중...")

        try:
            result = classify_batch(client, batch)
            sector_labels.update(result)
            log.info(f"       → {len(result)}개 분류 완료 (누적 {len(sector_labels)}개)")
        except Exception as e:
            log.error(f"       → 배치 {batch_num} 실패: {e}")
            errors += 1

        if batch_num < total_batches:
            time.sleep(BATCH_DELAY)

    log.info(f"[2/3] 분류 완료: {len(sector_labels)}개 (실패 배치 {errors}개)")

    if not sector_labels:
        raise RuntimeError("분류 결과 없음 — Redis 저장 중단")

    # 3. Redis 저장 (TTL 8일)
    redis_set("sector_labels", sector_labels, TTL_8D)
    log.info("[3/3] Redis sector_labels 저장 완료 (TTL 8일)")
    log.info("=== 완료 ===")


if __name__ == "__main__":
    run()
