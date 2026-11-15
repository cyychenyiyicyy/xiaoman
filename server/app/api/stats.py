"""本周（近 7 天）学习统计：消息量、学科分布、连续天数。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Conversation, Message

router = APIRouter(tags=["stats"])


@router.get("/stats/week")
def week_stats(db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
    rows = db.execute(
        select(Message.created_at, Conversation.subject)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(Message.created_at >= start)
    ).all()

    days = [(start + timedelta(days=i)).date().isoformat() for i in range(7)]
    by_day = {d: 0 for d in days}
    by_subject: dict[str, int] = {}
    for created, subject in rows:
        if created is None:
            continue
        d = created.astimezone(timezone.utc).date().isoformat()
        if d in by_day:
            by_day[d] += 1
        by_subject[subject or "全部"] = by_subject.get(subject or "全部", 0) + 1

    total = sum(by_day.values())
    active_days = sum(1 for v in by_day.values() if v > 0)

    # 连续天数（从今天往回数）
    streak = 0
    for d in reversed(days):
        if by_day[d] > 0:
            streak += 1
        else:
            break

    return {
        "days": [{"date": d, "count": by_day[d]} for d in days],
        "subjects": sorted(
            [{"subject": k, "count": v} for k, v in by_subject.items()], key=lambda x: -x["count"]
        ),
        "total": total,
        "active_days": active_days,
        "streak": streak,
    }