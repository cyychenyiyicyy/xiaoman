"""题目：题库列表 / 详情 / 编辑 / 解析生成（M1 + 知识点关联）。

字段与 docs/03 §5 对齐：答案、解析、知识点、年级、难度都在 question 上，
M1 起就写 stem_preview_png 与 source_page，避免 M2 回填。
"""
from __future__ import annotations

import hashlib
import re as _re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import CaptureTask, Kp, Question, QuestionKp
from ..services import knowledge, solve

router = APIRouter(tags=["questions"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _fp(subject: str, stem: str) -> str:
    """题干指纹：去空白与 LaTeX 符号后取前 48 字，用于跨页去重。"""
    norm = _re.sub(r"\s+", "", stem or "")
    norm = _re.sub(r"[$\\{}_^]", "", norm)
    return hashlib.sha1(norm[:48].encode()).hexdigest()


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


class ConfirmIn(BaseModel):
    groups: list = []


def _out(q: Question, kps: list[dict] | None = None) -> dict:
    return {
        "id": q.id,
        "subject": q.subject,
        "image_url": f"/api/v1/questions/{q.id}/image" if q.stem_preview_png else "",
        "stem_md": q.stem_md,
        "answer_md": q.answer_md,
        "solution_md": q.solution_md,
        "qtype": q.qtype,
        "options": q.options or [],
        "grade": q.grade or "",
        "difficulty": int(q.difficulty or 0),
        "solve_status": q.solve_status or "",
        "solve_error": q.solve_error or "",
        "solved": bool((q.answer_md or "").strip() and (q.solution_md or "").strip()),
        "kps": kps if kps is not None else [],
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
def confirm(
    task_id: str,
    payload: ConfirmIn,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """确认入库：把（可能被人工改过的）题组写成 question；随后后台生成答案 / 解析 / 知识点。"""
    task = db.get(CaptureTask, task_id)
    if task is None:
        raise HTTPException(404, "任务不存在")
    if task.status == "done":
        raise HTTPException(409, "这一页已经入库了")

    groups = payload.groups or (task.groups_json or {}).get("groups") or []
    created: list[str] = []
    skipped = 0

    for g in groups:
        shared = (g.get("shared_stem") or "").strip()
        for q in g.get("questions") or []:
            stem = (q.get("stem") or "").strip()
            if not stem:
                continue
            if shared and not stem.startswith(shared):
                stem = f"{shared}\n\n{stem}"
            fp = _fp(task.subject, stem)
            if db.scalar(select(Question.id).where(Question.stem_fp == fp)):
                skipped += 1
                continue

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
                stem_fp=fp,
                solve_status="queued",
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

    if created:
        background.add_task(solve.solve_many, created, True)
    return {"ok": True, "created": len(created), "skipped": skipped, "ids": created, "solving": len(created)}


@router.get("/questions")
def list_questions(
    subject: str = "",
    grade: str = "",
    difficulty: int = 0,
    kp: str = "",
    q: str = "",
    has_answer: str = "",
    limit: int = 50,
    before: str | None = None,
    db: Session = Depends(get_db),
):
    where = []
    if subject:
        where.append(Question.subject == subject)
    if grade:
        where.append(Question.grade == grade)
    if difficulty:
        where.append(Question.difficulty == int(difficulty))
    if has_answer == "1":
        where.append(Question.answer_md != "")
    elif has_answer == "0":
        where.append(Question.answer_md == "")
    if q:
        where.append(Question.stem_md.ilike(f"%{q}%"))
    if kp:
        row = db.get(Kp, kp)
        if row is not None and row.kind == "chapter":
            # 选章节 = 选它下面所有知识点
            child_ids = [k for k in db.scalars(select(Kp.id).where(Kp.parent_id == kp)).all()]
            where.append(
                Question.id.in_(
                    select(QuestionKp.question_id).where(QuestionKp.kp_id.in_(child_ids or [""]))
                )
            )
        else:
            where.append(
                Question.id.in_(select(QuestionKp.question_id).where(QuestionKp.kp_id == kp))
            )
    if before:
        anchor = db.get(Question, before)
        if anchor is not None:
            where.append(Question.created_at < anchor.created_at)

    stmt = (
        select(Question)
        .where(*where)
        .order_by(Question.created_at.desc())
        .limit(max(1, min(limit, 200)))
    )
    rows = list(db.scalars(stmt).all())
    kmap = knowledge.kps_map(db, [r.id for r in rows])
    total = int(db.scalar(select(func.count()).select_from(Question).where(*where)) or 0)
    return {"items": [_out(q, kmap.get(q.id)) for q in rows], "total": total}


@router.get("/questions/{qid}")
def get_question(qid: str, db: Session = Depends(get_db)):
    q = db.get(Question, qid)
    if q is None:
        raise HTTPException(404, "题目不存在")
    return _out(q, knowledge.question_kps(db, q.id))


@router.get("/questions/{qid}/image")
def question_image(qid: str, db: Session = Depends(get_db)):
    """题目裁图（带图题靠它看原题）。"""
    from pathlib import Path

    from fastapi.responses import FileResponse

    q = db.get(Question, qid)
    if q is None or not q.stem_preview_png or not Path(q.stem_preview_png).exists():
        raise HTTPException(404, "没有题目图")
    return FileResponse(q.stem_preview_png)


class EditIn(BaseModel):
    stem: str | None = None
    answer: str | None = None
    solution: str | None = None
    options: list[str] | None = None
    subject: str | None = None
    qtype: str | None = None
    grade: str | None = None
    difficulty: int | None = None
    kps: list[str] | None = None


@router.patch("/questions/{qid}")
def edit_question(qid: str, payload: EditIn, db: Session = Depends(get_db)):
    q = db.get(Question, qid)
    if q is None:
        raise HTTPException(404, "题目不存在")
    if payload.stem is not None:
        q.stem_md = payload.stem.strip()
        q.stem_fp = _fp(q.subject, q.stem_md)
    if payload.answer is not None:
        q.answer_md = payload.answer.strip()
    if payload.solution is not None:
        q.solution_md = payload.solution.strip()
    if payload.options is not None:
        q.options = payload.options
    if payload.subject is not None:
        q.subject = payload.subject[:20]
    if payload.qtype is not None:
        q.qtype = payload.qtype[:16]
    if payload.grade is not None:
        q.grade = payload.grade.strip()[:10] if payload.grade.strip() in ("高一", "高二", "高三") else ""
    if payload.difficulty is not None:
        q.difficulty = max(0, min(5, int(payload.difficulty)))
    if payload.kps is not None:
        knowledge.set_question_kps(db, q, payload.kps)
    db.commit()
    db.refresh(q)
    return _out(q, knowledge.question_kps(db, q.id))


@router.post("/questions/{qid}/solve")
def solve_question(
    qid: str,
    background: BackgroundTasks,
    overwrite: bool = True,
    db: Session = Depends(get_db),
):
    """重新生成答案 / 解析 / 知识点（后台跑，前端轮询 solve_status）。"""
    q = db.get(Question, qid)
    if q is None:
        raise HTTPException(404, "题目不存在")
    q.solve_status = "queued"
    q.solve_error = ""
    db.commit()
    background.add_task(solve.solve_many, [q.id], overwrite)
    return {"ok": True, "status": "queued"}


@router.post("/questions/solve-missing")
def solve_missing(
    background: BackgroundTasks,
    limit: int = 20,
    db: Session = Depends(get_db),
):
    """给还没解析的题补解析（题库页的「补解析」）。"""
    rows = list(
        db.scalars(
            select(Question)
            .where(
                (Question.solution_md == "")
                | (Question.solve_status.in_(["", "failed", "skipped"]))
            )
            .order_by(Question.created_at.desc())
            .limit(max(1, min(limit, 50)))
        ).all()
    )
    ids = [r.id for r in rows]
    for r in rows:
        r.solve_status = "queued"
        r.solve_error = ""
    db.commit()
    if ids:
        background.add_task(solve.solve_many, ids, False)
    return {"queued": len(ids)}
