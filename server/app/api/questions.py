"""题目（M1 的最小实现）：先建 question 一张表，kp/mistake/card 留给 M2/M3。

字段与 docs/03 §5 对齐，M1 起就写 stem_preview_png 与 source_page，避免 M2 回填。
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import CaptureTask, Question

router = APIRouter(tags=["questions"])


def _crop_question(page_path: str, bbox: list, out_path) -> str:
    """按 bbox（归一化 0–1000）从原页裁出题目图，带 1% 边距。图题靠它给模型看。"""
    if not page_path or not bbox or len(bbox) < 4:
        return ""
    try:
        from PIL import Image
    except ImportError:
        return ""
    try:
        im = Image.open(page_path)
        w, h = im.size
        x1, y1, x2, y2 = (float(v) for v in bbox[:4])
        pad = max(4, int(0.012 * max(w, h)))
        left = max(0, int(x1 * w / 1000) - pad)
        top = max(0, int(y1 * h / 1000) - pad)
        right = min(w, int(x2 * w / 1000) + pad)
        bottom = min(h, int(y2 * h / 1000) + pad)
        if right - left < 8 or bottom - top < 8:
            return ""
        out_path.parent.mkdir(parents=True, exist_ok=True)
        im.crop((left, top, right, bottom)).save(out_path, "PNG")
        return str(out_path)
    except Exception:  # noqa: BLE001
        return ""


class QuestionOut(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    subject: str
    stem_md: str
    answer_md: str
    solution_md: str
    qtype: str
    options: list = []
    source: str
    source_page: int
    created_at: datetime | None = None


class ConfirmIn(BaseModel):
    groups: list = []


def _out(q: Question) -> dict:
    return {
        "id": q.id,
        "subject": q.subject,
        "image_url": f"/api/v1/questions/{q.id}/image" if q.stem_preview_png else "",
        "stem_md": q.stem_md,
        "answer_md": q.answer_md,
        "solution_md": q.solution_md,
        "qtype": q.qtype,
        "options": q.options or [],
        "source": q.source,
        "source_page": q.source_page,
        "created_at": q.created_at.isoformat() if q.created_at else None,
    }


@router.patch("/capture/tasks/{task_id}/groups")
def save_draft(task_id: str, payload: ConfirmIn, db: Session = Depends(get_db)):
    """复核时先存草稿（不改题目，只改这份解析结果）。"""
    task = db.get(CaptureTask, task_id)
    if task is None:
        raise HTTPException(404, "任务不存在")
    task.groups_json = {"groups": payload.groups}
    db.commit()
    return {"ok": True, "groups": len(payload.groups)}


@router.post("/capture/tasks/{task_id}/confirm")
def confirm(task_id: str, payload: ConfirmIn, db: Session = Depends(get_db)):
    """确认入库：把（可能被人工改过的）题组写成 question；确认前不污染知识图谱。"""
    task = db.get(CaptureTask, task_id)
    if task is None:
        raise HTTPException(404, "任务不存在")
    if task.status == "done":
        raise HTTPException(409, "这一页已经入库了")

    groups = payload.groups or (task.groups_json or {}).get("groups") or []
    created: list[str] = []
    for g in groups:
        shared = (g.get("shared_stem") or "").strip()
        for q in g.get("questions") or []:
            stem = (q.get("stem") or "").strip()
            if not stem:
                continue
            if shared and not stem.startswith(shared):
                stem = f"{shared}\n\n{stem}"
            qid = uuid.uuid4().hex
            row = Question(
                id=qid,
                subject=task.subject,
                stem_md=stem,
                answer_md=(q.get("answer") or "").strip(),
                solution_md=(q.get("solution") or "").strip(),
                qtype=(q.get("type") or "short")[:16],
                options=q.get("options") or [],
                source="capture",
                source_page=int(q.get("source_page") or task.page_no or 1),
                bbox=q.get("bbox") or [],
                page_path=task.page_path,
                stem_preview_png="",
            )
            from pathlib import Path

            from ..config import settings as _settings

            crop = _crop_question(
                task.page_path,
                q.get("bbox") or [],
                Path(_settings.data_path).parent / "questions" / f"{qid}.png",
            )
            row.stem_preview_png = crop
            db.add(row)
            created.append(row.id)

    task.groups_json = {"groups": groups}
    task.status = "done"
    task.question_count = len(created)
    db.commit()
    return {"ok": True, "created": len(created), "ids": created}


@router.get("/questions")
def list_questions(
    subject: str = "",
    q: str = "",
    limit: int = 50,
    before: str | None = None,
    db: Session = Depends(get_db),
):
    stmt = select(Question).order_by(Question.created_at.desc()).limit(max(1, min(limit, 200)))
    if subject:
        stmt = stmt.where(Question.subject == subject)
    if q:
        stmt = stmt.where(Question.stem_md.ilike(f"%{q}%"))
    if before:
        anchor = db.get(Question, before)
        if anchor is not None:
            stmt = stmt.where(Question.created_at < anchor.created_at)
    rows = list(db.scalars(stmt).all())
    return {"items": [_out(q) for q in rows], "total": int(db.scalar(select(func.count()).select_from(Question)) or 0)}


@router.get("/questions/{qid}")
def get_question(qid: str, db: Session = Depends(get_db)):
    q = db.get(Question, qid)
    if q is None:
        raise HTTPException(404, "题目不存在")
    return _out(q)

@router.get("/questions/{qid}/image")
def question_image(qid: str, db: Session = Depends(get_db)):
    """题目裁图（带图题靠它看原题）。"""
    from pathlib import Path

    from fastapi.responses import FileResponse

    q = db.get(Question, qid)
    if q is None or not q.stem_preview_png or not Path(q.stem_preview_png).exists():
        raise HTTPException(404, "没有题目图")
    return FileResponse(q.stem_preview_png)
