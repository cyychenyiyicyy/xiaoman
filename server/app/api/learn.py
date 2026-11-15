"""学习档案：出题检测 / 沉淀撤销 / 主动消息。

这三个动作是「她记得你」的落点：
- quiz：Agent 工具或主动消息出一道题，答完立刻留掌握度证据；
- deposit：回答后自动沉淀，前端可以撤销；
- nudge：每天最多一条主动消息。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Conversation, Message, Quiz
from ..services import deposit as deposit_service
from ..services import nudge as nudge_service
from ..services import quiz as quiz_service

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

