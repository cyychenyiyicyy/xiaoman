"""学习档案：出题检测 / 沉淀撤销 / 主动消息。

这三个动作是「她记得你」的落点：
- quiz：Agent 工具或主动消息出一道题，答完立刻留掌握度证据；
- deposit：回答后自动沉淀，前端可以撤销；
- nudge：每天最多一条主动消息。
"""
from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Artifact, Conversation, Kp, KpEvidence, Message, Quiz
from ..services import artifacts as artifact_service
from ..services import deposit as deposit_service
from ..services import nudge as nudge_service
from ..services import quiz as quiz_service
from ..services import skills as skills_service

import uuid as _uuid
from datetime import datetime, timezone

router = APIRouter(tags=["learn"])


class AutoIn(BaseModel):
    conversation_id: str = ""
    question_id: str = ""
    kp_id: str = ""
    due: bool = False


@router.post("/quizzes/auto")
def auto_quiz(payload: AutoIn, db: Session = Depends(get_db)):
    """现出一道检测题：按题重做 / 按知识点生成 / 从到期题里挑。"""
    conv = db.get(Conversation, payload.conversation_id) if payload.conversation_id else None
    if conv is None:
        conv = db.scalar(select(Conversation).order_by(Conversation.updated_at.desc()).limit(1))
    if conv is None:
        conv = Conversation(subject="全部", title="今天")
        db.add(conv)
        db.commit()
        db.refresh(conv)

    msg: Message | None = None
    try:
        if payload.question_id:
            msg = quiz_service.auto_from_question(db, conv.id, payload.question_id)
        elif payload.kp_id:
            msg = quiz_service.auto_from_kp(db, conv.id, payload.kp_id)
        elif payload.due:
            msg = quiz_service.auto_due(db, conv.id, conv.subject)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if msg is None:
        raise HTTPException(404, "没有可以出的题")
    part = next((p for p in (msg.parts or []) if p.get("type") == "quiz"), None)
    return {
        "ok": True,
        "conversation_id": conv.id,
        "message_id": msg.id,
        "text": msg.content_md,
        "quiz": part.get("quiz") if part else None,
    }


@router.get("/quizzes/{quiz_id}")
def get_quiz(quiz_id: str, db: Session = Depends(get_db)):
    quiz = db.get(Quiz, quiz_id)
    if quiz is None:
        raise HTTPException(404, "题目不存在")
    return quiz_service.payload(quiz)


class AnswerIn(BaseModel):
    chosen: str


@router.post("/quizzes/{quiz_id}/answer")
def answer(quiz_id: str, payload: AnswerIn, db: Session = Depends(get_db)):
    res = quiz_service.answer_quiz(db, quiz_id, payload.chosen)
    if res is None:
        raise HTTPException(404, "题目不存在")
    return res


@router.post("/deposits/{deposit_id}/undo")
def undo_deposit(deposit_id: str, db: Session = Depends(get_db)):
    res = deposit_service.undo(db, deposit_id)
    if res is None:
        raise HTTPException(404, "没有这条记录，或者已经撤销了")
    return res


@router.post("/nudges/check")
def check_nudge(db: Session = Depends(get_db)):
    """每天最多一条：到期题 / 最近薄弱点。没有就不发。"""
    return nudge_service.maybe_nudge(db)


@router.get("/skills")
def list_skills():
    """技能列表（不含提示词）。前端在输入框旁边选。"""
    return {"items": skills_service.public_list()}


@router.get("/artifacts")
def list_artifacts(
    kind: str = "",
    subject: str = "",
    q: str = "",
    limit: int = 80,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """资料库：所有生成过的网页 / PDF / 卡片；q 搜标题、正文与知识点。"""
    where = []
    if kind in ("html", "pdf", "png", "flashcards", "paper"):
        where.append(Artifact.kind == kind)
    if subject:
        where.append(Artifact.subject == subject)
    rows = list(
        db.scalars(
            select(Artifact)
            .where(*where)
            .order_by(Artifact.created_at.desc())
            .limit(300)
        ).all()
    )
    if q:
        needle = q.strip().lower()
        kps = {k.id: k.name for k in db.scalars(select(Kp)).all()}
        hits = []
        for a in rows:
            hay = " ".join(
                [a.title or "", a.subject or "", (a.source_md or "")[:6000]]
                + [kps.get(i, "") for i in (a.kp_ids or [])]
            ).lower()
            if needle in hay:
                hits.append(a)
        rows = hits
    total = len(rows) if q else int(db.scalar(select(func.count()).select_from(Artifact).where(*where)) or 0)
    start = max(0, offset)
    page = rows[start:start + max(1, min(limit, 200))]
    parent_ids = {a.parent_id for a in page if a.parent_id}
    parents = {}
    if parent_ids:
        parents = {
            p.id: p.title
            for p in db.scalars(select(Artifact).where(Artifact.id.in_(parent_ids))).all()
        }
    items = []
    for a in page:
        item = artifact_service.payload(a)
        item["created_at"] = a.created_at.isoformat() if a.created_at else None
        item["conversation_id"] = a.conversation_id
        item["parent_title"] = parents.get(a.parent_id, "") if a.parent_id else ""
        items.append(item)
    return {"items": items, "total": total}


class RenameIn(BaseModel):
    title: str = ""
    subject: str | None = None


@router.patch("/artifacts/{aid}")
def rename_artifact(aid: str, payload: RenameIn, db: Session = Depends(get_db)):
    a = db.get(Artifact, aid)
    if a is None:
        raise HTTPException(404, "产物不存在")
    title = payload.title.strip()
    if title:
        a.title = title[:120]
    if payload.subject is not None:
        a.subject = payload.subject.strip()[:20]
    db.commit()
    db.refresh(a)
    item = artifact_service.payload(a)
    item["created_at"] = a.created_at.isoformat() if a.created_at else None
    return item


@router.delete("/artifacts/{aid}")
def delete_artifact(aid: str, db: Session = Depends(get_db)):
    a = db.get(Artifact, aid)
    if a is None:
        raise HTTPException(404, "产物不存在")
    for p in (Path(a.path), artifact_service.source_path(aid)):
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass
    db.delete(a)
    db.commit()
    return {"ok": True}


class CardReviewIn(BaseModel):
    index: int = 0
    known: bool = False


@router.post("/artifacts/{aid}/card-review")
def review_card(aid: str, payload: CardReviewIn, db: Session = Depends(get_db)):
    """闪卡自评：把「记住 / 没记住」写进知识点证据，接上掌握度。"""
    a = db.get(Artifact, aid)
    if a is None or a.kind != "flashcards":
        raise HTTPException(404, "闪卡不存在")
    for kp_id in a.kp_ids or []:
        db.add(
            KpEvidence(
                id=_uuid.uuid4().hex,
                kp_id=kp_id,
                kind="flashcard_right" if payload.known else "flashcard_wrong",
                weight=0.4 if payload.known else 0.85,
                source=a.id,
                created_at=datetime.now(timezone.utc),
            )
        )
    db.commit()
    return {"ok": True, "known": payload.known, "kps": len(a.kp_ids or [])}


@router.get("/artifacts/{aid}/source")
def artifact_source(aid: str, db: Session = Depends(get_db)):
    """PDF 打印用的临时 HTML 源（生成完就删）。"""
    a = db.get(Artifact, aid)
    if a is None:
        raise HTTPException(404, "产物不存在")
    p = artifact_service.source_path(aid)
    if not p.exists():
        raise HTTPException(404, "源文件已清理")
    return FileResponse(p, media_type="text/html; charset=utf-8")


@router.get("/artifacts/{aid}")
def get_artifact(aid: str, download: bool = False, db: Session = Depends(get_db)):
    a = db.get(Artifact, aid)
    if a is None:
        raise HTTPException(404, "产物不存在")
    p = Path(a.path)
    if not p.exists():
        raise HTTPException(410, "文件已不在")
    headers = {}
    if download:
        suffix = ".pdf" if a.kind == "pdf" else ".html"
        name = f"{(a.title or '小满')}{suffix}"
        headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(name)
    return FileResponse(p, media_type=a.mime, headers=headers)

