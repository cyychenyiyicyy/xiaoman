"""学科空间（docs/11）：九个学科各一条连续对话 + 「全部」概览。

关系轴单一（同一个人格、同一份记忆），内容轴分科。
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import AppSetting, Conversation, Message

SUBJECTS = ["全部", "语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理"]
DEFAULT_SUBJECT = "全部"
KEY = "current_subject"


def current_subject(db: Session) -> str:
    row = db.get(AppSetting, KEY)
    if row and isinstance(row.value, dict) and row.value.get("subject") in SUBJECTS:
        return row.value["subject"]
    return DEFAULT_SUBJECT


def switch(db: Session, subject: str) -> str:
    if subject not in SUBJECTS:
        raise ValueError("unknown subject")
    row = db.get(AppSetting, KEY)
    if row is None:
        db.add(AppSetting(key=KEY, value={"subject": subject}))
    else:
        row.value = {**(row.value or {}), "subject": subject}
    db.commit()
    return subject


def conversation_for(db: Session, subject: str) -> Conversation:
    """每个学科一条长期对话；不存在就建。"""
    conv = db.scalar(select(Conversation).where(Conversation.subject == subject).limit(1))
    if conv is None:
        conv = Conversation(subject=subject)
        db.add(conv)
        db.commit()
        db.refresh(conv)
    return conv


def current_conversation(db: Session) -> Conversation:
    return conversation_for(db, current_subject(db))


def overview(db: Session) -> dict:
    counts = dict(
        db.execute(
            select(Conversation.subject, func.count(Message.id))
            .join(Message, Message.conversation_id == Conversation.id, isouter=True)
            .group_by(Conversation.subject)
        ).all()
    )
    items = [
        {"subject": s, "count": int(counts.get(s) or 0)} for s in SUBJECTS
    ]
    return {"current": current_subject(db), "items": items}