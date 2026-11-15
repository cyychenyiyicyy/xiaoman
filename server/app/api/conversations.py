"""对话列表（ChatGPT 式）：新建 / 列表 / 改名 / 删除。"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Conversation, Message
from ..services import spaces

router = APIRouter(tags=["conversations"])


class NewIn(BaseModel):
    subject: str = "全部"


class PatchIn(BaseModel):
    title: str | None = None
    subject: str | None = None


def _out(db: Session, c: Conversation) -> dict:
    last = db.scalar(
        select(Message)
        .where(Message.conversation_id == c.id)
        .order_by(Message.seq.desc())
        .limit(1)
    )
    count = int(db.scalar(select(func.count()).select_from(Message).where(Message.conversation_id == c.id)) or 0)
    return {
        "id": c.id,
        "title": c.title or "新对话",
        "subject": c.subject,
        "count": count,
        "preview": ((last.content_md or "").strip().replace("\n", " ")[:80] if last else ""),
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


@router.get("/conversations")
def list_conversations(subject: str = "", limit: int = 100, db: Session = Depends(get_db)):
    stmt = select(Conversation).order_by(Conversation.updated_at.desc()).limit(max(1, min(limit, 300)))
    if subject:
        stmt = select(Conversation).where(Conversation.subject == subject).order_by(
            Conversation.updated_at.desc()
        ).limit(max(1, min(limit, 300)))
    rows = db.scalars(stmt).all()
    items = [_out(db, c) for c in rows]
    # 空对话（还没发过消息）不列出来
    items = [x for x in items if x["count"] > 0]
    return {"items": items}


@router.post("/conversations", status_code=201)
def new_conversation(payload: NewIn, db: Session = Depends(get_db)):
    subject = (payload.subject or "全部")[:20]
    conv = spaces.create_conversation(db, subject)
    return {"id": conv.id, "subject": subject, "title": "新对话"}


@router.patch("/conversations/{cid}")
def patch_conversation(cid: str, payload: PatchIn, db: Session = Depends(get_db)):
    conv = db.get(Conversation, cid)
    if conv is None:
        raise HTTPException(404, "对话不存在")
    if payload.title is not None:
        conv.title = payload.title.strip()[:80]
    if payload.subject is not None:
        conv.subject = payload.subject.strip()[:20]
    db.commit()
    return {"ok": True, "item": _out(db, conv)}


@router.delete("/conversations/{cid}")
def delete_conversation(cid: str, db: Session = Depends(get_db)):
    conv = db.get(Conversation, cid)
    if conv is None:
        raise HTTPException(404, "对话不存在")
    db.query(Message).filter(Message.conversation_id == cid).delete()
    db.delete(conv)
    db.commit()
    return {"ok": True}