"""
moat_analysis 단일 키 → moat:{code} 개별 키 마이그레이션 (1회 실행)
Gemini 재호출 없이 기존 저장 데이터를 개별 키로 재구성
"""

import os
import json
import requests
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

KV_URL   = os.environ["KV_REST_API_URL"]
KV_TOKEN = os.environ["KV_REST_API_TOKEN"]
TTL_95D  = 95 * 24 * 3600
TIMEOUT  = 60  # 큰 JSON 수신 여유


def run():
    # 1. 기존 moat_analysis 전체 읽기
    log.info("[1/3] moat_analysis 읽는 중...")
    r = requests.get(
        f"{KV_URL}/get/moat_analysis",
        headers={"Authorization": f"Bearer {KV_TOKEN}"},
        timeout=TIMEOUT,
    )
    raw = r.json().get("result")
    if not raw:
        raise RuntimeError("moat_analysis 키 없음 — 워크플로우 먼저 실행 필요")

    moat_data = json.loads(raw) if isinstance(raw, str) else raw
    log.info(f"[1/3] 로드 완료: {len(moat_data)}개 종목")

    # 2. 개별 키 파이프라인 저장 (100개씩 분할)
    log.info("[2/3] moat:{{code}} 개별 키 저장 중...")
    codes   = list(moat_data.keys())
    PIPE    = 100
    saved   = 0

    for i in range(0, len(codes), PIPE):
        batch = codes[i : i + PIPE]
        pipeline = [
            ["SET", f"moat:{c}", json.dumps(moat_data[c], ensure_ascii=False), "EX", str(TTL_95D)]
            for c in batch
        ]
        requests.post(
            f"{KV_URL}/pipeline",
            headers={"Authorization": f"Bearer {KV_TOKEN}", "Content-Type": "application/json"},
            json=pipeline,
            timeout=30,
        )
        saved += len(batch)
        log.info(f"      {saved}/{len(codes)}개 저장 완료")

    log.info(f"[2/3] 개별 키 저장 완료: {saved}개")

    # 3. 기존 big key 삭제 (선택)
    requests.post(
        f"{KV_URL}/pipeline",
        headers={"Authorization": f"Bearer {KV_TOKEN}", "Content-Type": "application/json"},
        json=[["DEL", "moat_analysis"]],
        timeout=10,
    )
    log.info("[3/3] 기존 moat_analysis 키 삭제 완료")
    log.info("=== 마이그레이션 완료 ===")


if __name__ == "__main__":
    run()
