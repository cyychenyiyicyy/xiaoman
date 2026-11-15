"""题目解析：答案 + 解析 + 知识点标签 + 年级 / 难度。

触发点有三处（都在后台，不挡用户）：
1. 拍题确认入库后（capture confirm）；
2. 对话里 `question_add` 收录后（缺答案 / 解析时）；
3. 题库里手动点「重新生成解析」。

模型不可用（没连 provider / 只有内置演示）时标 `skipped`，不假装有解析。
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import httpx
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import Question
from ..seed import get_current
from . import knowledge
from .llm import complete_text

SOLVE_SYSTEM = """你是高中九科老师，任务是给题库里的题目补「答案 + 解析」，并打知识点标签。

输入是一个 JSON：
{"subject":"化学","grade":"高一","qtype":"choice","stem":"…","options":["A. …"],"knowledge_candidates":["…"],"has_image":false}

只输出 JSON（不要解释、不要代码块）：
{
  "answer": "…",
  "solution": "…",
  "grade": "高一",
  "difficulty": 3,
  "knowledge": [{"name": "…", "weight": 0.9, "primary": true}]
}

规则：
- answer：选择题只写选项字母（如 "B"），多选写 "AC"；填空写各空答案，用「/」分隔；解答题写最终结果。不要重复题干。
- solution：第一句点考点，再写关键步骤与易错点；公式用行内 LaTeX（$...$）；不超过 160 字；不要重抄题干。
- knowledge：2–4 个知识点，优先从 knowledge_candidates 里选（用原名）；候选里没有合适的，才用你自己的标准叫法。必须且只有一个 primary。
- grade：只能是 高一 / 高二 / 高三。
- difficulty：1（最易）到 5（最难）的整数。
- 题面看不清或条件不足：answer 写「条件不足」，solution 说明缺什么。
- 不要输出图片、HTML；数学式子用 $...$。"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_json(raw: str) -> dict:
    t = (raw or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(t[start : end + 1])
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def payload_for(db: Session, q: Question) -> dict:
    stem = (q.stem_md or "").strip()
    return {
        "subject": q.subject,
        "grade": q.grade or "",
        "qtype": q.qtype or "short",
        "stem": stem[:3000],
        "options": [str(o)[:300] for o in (q.options or [])][:8],
        "knowledge_candidates": knowledge.candidates(db, q.subject, stem, limit=36),
        "has_image": bool(q.stem_preview_png),
    }


def _num(v, lo: int, hi: int) -> int:
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return 0
    return min(hi, max(lo, n))


def apply_result(db: Session, q: Question, data: dict, overwrite: bool = False) -> None:
    answer = str(data.get("answer") or "").strip()
    solution = str(data.get("solution") or "").strip()
    if not answer and not solution:
        raise ValueError("模型没有给出答案或解析")

    if answer and (overwrite or not (q.answer_md or "").strip()):
        q.answer_md = answer[:4000]
    if solution and (overwrite or not (q.solution_md or "").strip()):
        q.solution_md = solution[:8000]

    grade = str(data.get("grade") or "").strip()
    if grade in ("高一", "高二", "高三") and (overwrite or not q.grade):
        q.grade = grade

    diff = _num(data.get("difficulty"), 1, 5)
    if diff and (overwrite or not q.difficulty):
        q.difficulty = diff

    items = data.get("knowledge") or []
    if isinstance(items, list) and items and (overwrite or not _has_kps(db, q.id)):
        knowledge.tag_question(db, q, items)

    q.solve_status = "done"
    q.solve_error = ""
    q.solved_at = _now()
    meta = dict(q.ai_meta or {})
    meta["solve"] = {
        "answer": answer,
        "solution": solution,
        "grade": grade,
        "difficulty": diff,
        "knowledge": items if isinstance(items, list) else [],
    }
    q.ai_meta = meta


def _has_kps(db: Session, qid: str) -> bool:
    from sqlalchemy import func, select

    from ..models import QuestionKp

    return bool(db.scalar(select(func.count()).select_from(QuestionKp).where(QuestionKp.question_id == qid)))


async def _call_model(db: Session, q: Question, provider, model, use_image: bool) -> str:
    payload = payload_for(db, q)
    image = ""
    if use_image and q.stem_preview_png and Path(q.stem_preview_png).exists():
        image = q.stem_preview_png
    user = json.dumps(payload, ensure_ascii=False)
    return await complete_text(
        provider,
        model,
        SOLVE_SYSTEM,
        user,
        max_tokens=2200,
        image_path=image,
    )


async def solve_one(question_id: str, overwrite: bool = False) -> str:
    """跑一道题，返回最终状态（done / failed / skipped）。"""
    with SessionLocal() as db:
        q = db.get(Question, question_id)
        if q is None:
            return "missing"
        q.solve_status = "running"
        q.solve_error = ""
        db.commit()

        provider, model, _ = get_current(db)
        if provider is None or model is None or provider.kind == "mock" or not (provider.base_url or "").strip():
            q.solve_status = "skipped"
            q.solve_error = "没有可用的模型：先在设置里连接一个 provider"
            db.commit()
            return "skipped"

        raw = ""
        try:
            use_image = bool(model.supports_images)
            try:
                raw = await _call_model(db, q, provider, model, use_image)
            except httpx.HTTPStatusError:
                if not use_image:
                    raise
                raw = await _call_model(db, q, provider, model, False)  # 模型不认图：退回纯文本
            data = _parse_json(raw)
            if not data:
                raise ValueError(f"解析结果不是 JSON：{(raw or '空响应')[:120]}")
            apply_result(db, q, data, overwrite=overwrite)
            db.commit()
            return "done"
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            row = db.get(Question, question_id)
            if row is not None:
                row.solve_status = "failed"
                row.solve_error = f"{type(exc).__name__}: {str(exc)[:240]}"
                db.commit()
            return "failed"


async def solve_many(question_ids: list[str], overwrite: bool = False) -> None:
    """队列化跑一批：每道题之间歇一下，避免一把打满 provider 的限流。"""
    for qid in question_ids:
        try:
            await solve_one(qid, overwrite=overwrite)
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(0.4)
