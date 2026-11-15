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
            row = Question(
                id=uuid.uuid4().hex,
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
                stem_preview_png="",  # 服务端预渲染留到 M1.4 末尾
            )
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
    limit: int = 50,
    before: str | None = None,
    db: Session = Depends(get_db),
):
    stmt = select(Question).order_by(Question.created_at.desc()).limit(max(1, min(limit, 200)))
    if subject:
        stmt = stmt.where(Question.subject == subject)
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