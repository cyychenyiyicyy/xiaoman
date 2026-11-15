"""OCR / 文档解析适配层（M1）。

换引擎只实现同一个 `parse_to_blocks()`：cloud / mock / local（后续）。
"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path

import httpx

from ..config import settings


class OcrError(RuntimeError):
    pass


async def parse_to_blocks(image: Path, provider: str | None = None, api_key: str = "") -> dict:
    """返回 {pages:[{page_no,width,height,blocks:[{type,text,bbox,html}]}], markdown, provider}。"""
    name = (provider or settings.ocr_provider or "mock").lower()
    if name == "mock":
        return await _mock(image)
    if name == "cloud":
        return await _cloud(image, api_key=api_key)
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


DEEPSEEK_OCR_URL = "https://api.deepseek.com/v1/tools/ocr"
# DeepSeek-OCR 的 grounding 标记：<|ref|>文本<|/ref|><|det|>[[x1,y1,x2,y2]]<|/det|>
_BAR = r"[|\uff5c]"  # DeepSeek OCR 用全角 ｜ 作分隔，兼容两种
_MARK = re.compile(
    rf"<{_BAR}ref{_BAR}>(?P<kind>[^<]*)<{_BAR}/ref{_BAR}><{_BAR}box{_BAR}>\[\["
    rf"\s*(?P<x1>\d+)\s*,\s*(?P<y1>\d+)\s*,\s*(?P<x2>\d+)\s*,\s*(?P<y2>\d+)\s*"
    rf"\]\]<{_BAR}/box{_BAR}>\s*(?P<text>.*?)(?=\n<{_BAR}ref{_BAR}|\Z)",
    re.S,
)


def _parse_page(text: str) -> list[dict]:
    """把 grounding 标记拆成 blocks：正文在标记之后，ref 里是类型（title/text/table/formula…）。"""
    blocks = []
    for m in _MARK.finditer(text or ""):
        body = (m.group("text") or "").strip()
        if not body:
            continue
        blocks.append(
            {
                "type": "text",
                "kind": (m.group("kind") or "text").strip() or "text",
                "text": body,
                "bbox": [int(m.group("x1")), int(m.group("y1")), int(m.group("x2")), int(m.group("y2"))],
            }
        )
    if not blocks and (text or "").strip():
        blocks.append({"type": "text", "kind": "text", "text": text.strip(), "bbox": [0, 0, 1000, 1000]})
    return blocks


async def _cloud(image: Path, purpose: str = "rich_layout_recognition", api_key: str = "") -> dict:
    """DeepSeek OCR（POST /v1/tools/ocr）：1.5 元 / 1000 页，按成功页数计费。

    返回逐页文本；文本里带 grounding 标记（文本 + 归一化坐标），可据此裁图与定位。
    """
    key = (api_key or settings.ocr_api_key or settings.deepseek_api_key or "").strip()
    if not key:
        raise OcrError("没有可用的 DeepSeek key：先配 OCR_API_KEY 或把一个 DeepSeek provider 填好 key")

    raw = image.read_bytes()
    mime = "image/png" if raw.startswith(b"\x89PNG") else "image/jpeg"
    async with httpx.AsyncClient(timeout=httpx.Timeout(240.0, connect=15.0)) as client:
        resp = await client.post(
            DEEPSEEK_OCR_URL,
            headers={"Authorization": f"Bearer {key}"},
            data={"purpose": purpose},
            files={"file": (image.name, raw, mime)},
        )
        if resp.status_code >= 400:
            raise OcrError(f"OCR HTTP {resp.status_code}: {resp.text[:200]}")
        data = resp.json()

    if isinstance(data, dict) and data.get("error"):
        raise OcrError(str(data["error"].get("message") or data["error"])[:300])

    pages = []
    for p in data.get("pages") or []:
        pages.append(
            {
                "page_no": int(p.get("index") or 0) + 1,
                "width": 1000,
                "height": 1000,
                "blocks": _parse_page(p.get("text") or ""),
                "raw_text": p.get("text") or "",
                "finish_reason": p.get("finish_reason"),
            }
        )
    return {
        "provider": "deepseek-ocr",
        "purpose": data.get("purpose"),
        "pages": pages,
        "markdown": "\n\n".join(
            "\n".join(b.get("text", "") for b in pg["blocks"]) for pg in pages
        ).strip(),
        "page_count": data.get("page_count"),
        "usage": data.get("usage"),
    }


async def extract_groups(blocks: dict, provider=None, model=None) -> dict:
    """兼容入口：转交 services.extract（LLM 优先，失败退回规则）。"""
    from . import extract as extract_service

    return await extract_service.extract(blocks, provider, model)


def confidence_of(groups: dict) -> float:
    from . import extract as extract_service

    return extract_service.confidence_of(groups)
