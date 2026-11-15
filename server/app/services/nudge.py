"""主动消息：每天最多一条。

不做「提醒」，做判断：今天有没有到期的题、最近有没有反复问的薄弱点。
有就发一条，没有就不吭声。落在最近一个对话里，会话列表预览会把它顶上来。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import AppSetting, Conversation, Kp, KpEvidence, Message, Question

SETTING_KEY = "nudge"
CN_TZ = timezone(timedelta(hours=8))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _today() -> str:
    return datetime.now(CN_TZ).strftime("%Y-%m-%d")


def _text(due: int, weak: list[dict]) -> str:
    name = weak[0]["name"] if weak else ""
    if due and name:
        return f"今天有 {due} 道题该复习了。前几天你问过「{name}」，先来一道？"
    if due:
        return f"今天有 {due} 道题该复习了。"
    if name:
        return f"前几天你问过「{name}」，还记得吗？我出一道题看看。"
    return ""


def maybe_nudge(db: Session) -> dict:
    now = _now()
    today = _today()
    setting = db.get(AppSetting, SETTING_KEY)
    value = dict(setting.value) if setting is not None and isinstance(setting.value, dict) else {}
    if value.get("date") == today:
        return {"created": False, "reason": "done"}

    due = int(
        db.scalar(
            select(func.count())
            .select_from(Question)
            .where(
                Question.status != "mastered",
                Question.next_due_at.isnot(None),
                Question.next_due_at <= now,
            )
        )
        or 0
    )

    since = now - timedelta(days=3)
    rows = db.execute(
        select(KpEvidence.kp_id, func.count())
        .where(KpEvidence.created_at >= since)
        .where(KpEvidence.kind.in_(["asked", "deposit", "quiz_wrong"]))
        .group_by(KpEvidence.kp_id)
        .order_by(func.count().desc())
        .limit(3)
    ).all()
    weak: list[dict] = []
    for kp_id, count in rows:
        kp = db.get(Kp, kp_id)
        if kp is not None:
            weak.append({"id": kp.id, "name": kp.name, "subject": kp.subject, "count": int(count)})

    if due == 0 and not weak:
        return {"created": False, "reason": "empty"}

    conv = db.scalar(select(Conversation).order_by(Conversation.updated_at.desc()).limit(1))
    if conv is None:
        conv = Conversation(subject="全部", title="今天")
        db.add(conv)
        db.flush()

    text = _text(due, weak)
    parts = [
        {
            "type": "nudge",
            "due": due,
            "weak": weak,
            "actions": [
                {"act": "nudge-quiz", "label": "出一道检测", "kp": weak[0]["id"] if weak else ""},
                {"act": "bank-due", "label": "去题库复习"},
            ],
        }
    ]
    msg = Message(
        conversation_id=conv.id,
        role="assistant",
        kind="nudge",
        content_md=text,
        parts=parts,
        status="done",
    )
    db.add(msg)
    conv.updated_at = now
    if setting is None:
        setting = AppSetting(key=SETTING_KEY, value={})
        db.add(setting)
    value["date"] = today
    value["last_at"] = now.isoformat()
    setting.value = value
    db.commit()
    db.refresh(msg)
    return {
        "created": True,
        "conversation_id": conv.id,
        "message_id": msg.id,
        "text": text,
        "due": due,
        "weak": weak,
    }
