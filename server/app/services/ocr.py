"""OCR / 文档解析适配层（M1）。

换引擎只实现同一个 `parse_to_blocks()`：cloud / mock / local（后续）。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from ..config import settings


class OcrError(RuntimeError):
    pass


async def parse_to_blocks(image: Path, provider: str | None = None) -> dict:
    """返回 {pages:[{page_no,width,height,blocks:[{type,text,bbox,html}]}], markdown, provider}。"""
    name = (provider or settings.ocr_provider or "mock").lower()
    if name == "mock":
        return await _mock(image)
    if name == "cloud":
        return await _cloud(image)
    raise OcrError(f"未知 OCR provider：{name}")


async def _mock(image: Path) -> dict:
    await asyncio.sleep(0.2)
    blocks = [
        {"type": "text", "text": "1. 关于摩擦力，下列说法正确的是（ ）", "bbox": [72, 96, 620, 130]},
        {"type": "text", "text": "A. 摩擦力方向总与运动方向相反", "bbox": [72, 140, 560, 168]},
        {"type": "text", "text": "B. 静摩擦力大小与正压力成正比", "bbox": [72, 176, 560, 204]},
        {"type": "text", "text": "2. 如图所示，滑块在斜面上匀速下滑，求动摩擦因数。", "bbox": [72, 230, 640, 286]},
        {"type": "image", "text": "", "bbox": [96, 300, 400, 440], "html": ""},
    ]
    return {
        "provider": "mock",
        "pages": [{"page_no": 1, "width": 800, "height": 1000, "blocks": blocks}],
        "markdown": "\n".join(b.get("text", "") for b in blocks if b.get("text")),
    }


async def _cloud(image: Path) -> dict:
    """云文档解析（合合/阿里/百度高精度含公式）。缺 key 时明确报错，不静默降级。"""
    if not settings.ocr_api_key:
        raise OcrError("没配 OCR_API_KEY，先用 mock 或去设置里填云 OCR 的 key")
    raise OcrError("云 OCR 适配器待接入（M1.2）：接口形状已定，换实现即可")


async def extract_groups(blocks: dict) -> dict:
    """把解析结果组织成题组（M1.3 会换成 LLM 抽取；先用规则把链路跑通）。"""
    pages = blocks.get("pages") or []
    text_lines: list[tuple[int, str]] = []
    for p in pages:
        for b in p.get("blocks") or []:
            if b.get("type") == "text" and b.get("text"):
                text_lines.append((p.get("page_no") or 1, b["text"]))

    groups: list[dict] = []
    current: dict | None = None
    for page_no, line in text_lines:
        stripped = line.strip()
        is_question = bool(stripped[:2].rstrip(".．、)）").isdigit()) and ("." in stripped[:3] or "、" in stripped[:3])
        is_option = stripped[:2] in ("A.", "B.", "C.", "D.") or stripped[:1] in ("A", "B", "C", "D") and stripped[1:2] in (".", "、")
        if is_question and not is_option:
            if current:
                groups.append(current)
            current = {
                "group_id": f"G{len(groups) + 1}",
                "shared_stem": "",
                "source_pages": [page_no],
                "questions": [
                    {
                        "number": stripped.split(".")[0].split("、")[0].strip(),
                        "type": "choice" if True else "short",
                        "stem": stripped,
                        "options": [],
                        "source_page": page_no,
                    }
                ],
            }
        elif is_option and current:
            current["questions"][-1]["options"].append(stripped)
        elif current:
            q = current["questions"][-1]
            q["stem"] = (q["stem"] + "\n" + stripped).strip() if q.get("stem") else stripped
    if current:
        groups.append(current)
    return {"groups": groups, "warnings": [] if groups else ["没识别出题目"]}


def confidence_of(groups: dict) -> float:
    gs = groups.get("groups") or []
    if not gs:
        return 0.0
    q = sum(len(g.get("questions") or []) for g in gs)
    return min(0.99, 0.5 + 0.1 * q) if q else 0.2