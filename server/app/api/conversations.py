"""对话列表（ChatGPT 式）：新建 / 列表 / 改名 / 删除。"""
from __future__ import annotations

import re
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Conversation, Message
from ..services import spaces
from ..seed import get_current
from ..services.llm import complete_text

router = APIRouter(tags=["conversations"])

TITLE_SYS = """你在给一段学习对话起标题。要求：
- 不超过 10 个字，中文；
- 说出她在问什么（如「二次函数最值」「化学方程式配平」），不要用「对话」「提问」这种空词；
- 只输出标题本身，不要引号、不要句号、不要解释。"""


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

@router.post("/conversations/{cid}/autotitle")
async def autotitle(cid: str, db: Session = Depends(get_db)):
    """用模型把这段对话概括成 10 字内的标题（每个对话只做一次）。"""
    conv = db.get(Conversation, cid)
    if conv is None:
        raise HTTPException(404, "对话不存在")
    if conv.title_auto:
        return {"title": conv.title, "skipped": True}

    rows = db.scalars(
        select(Message).where(Message.conversation_id == cid).order_by(Message.seq.asc()).limit(8)
    ).all()
    if len(rows) < 2:
        return {"title": conv.title, "skipped": True, "reason": "too_short"}

    provider, model, _ = get_current(db)
    if provider is None or model is None:
        return {"title": conv.title, "skipped": True, "reason": "no_model"}

    text = "\n".join(
        f"{'她' if m.role == 'user' else '小满'}：{(m.content_md or '').strip()[:200]}"
        for m in rows
    )
    try:
        raw = await complete_text(provider, model, TITLE_SYS, text[:4000], max_tokens=256)
    except Exception as exc:  # noqa: BLE001
        return {"title": conv.title, "skipped": True, "reason": str(exc)[:80]}

    title = (raw or "").strip()
    title = re.sub(r"^(标题|题目)[:：]\s*", "", title)
    title = re.sub(r'^[「『"\'\s]+|[」』"\'\s。．.！!？?]+$', "", title)
    title = title.replace("\n", " ").strip()[:16].strip()
    if not title:
        # 模型没给出可用标题时，退回她第一句话的前 16 字
        first = next((m.content_md or "" for m in rows if m.role == "user"), "")
        title = (first.strip().replace("\n", " ")[:16] or conv.title)
        conv.title, conv.title_auto = title, True
        db.commit()
        return {"title": title, "skipped": True, "reason": "fallback"}

    conv.title = title
    conv.title_auto = True
    db.commit()
    return {"title": title, "skipped": False}
