"""记忆：列表 / 修改 / 删除 / 统计。"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Memory
from ..schemas import MemoryOut, MemoryPatch

router = APIRouter(tags=["memories"])


@router.get("/memories")
def list_memories(
    limit: int = Query(50, ge=1, le=200),
    before: str | None = None,
    status: str = "active",
    db: Session = Depends(get_db),
):
    stmt = select(Memory).order_by(Memory.created_at.desc())
    if status != "all":
        stmt = stmt.where(Memory.status == status)
    if before:
        anchor = db.get(Memory, before)
        if anchor is not None:
            stmt = stmt.where(Memory.created_at < anchor.created_at)
    rows = list(db.scalars(stmt.limit(limit + 1)).all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [MemoryOut.model_validate(r).model_dump() for r in rows],
        "next": rows[-1].id if has_more and rows else None,
    }


@router.get("/memories/stats")
def memory_stats(db: Session = Depends(get_db)):
    total = db.scalar(select(func.count()).select_from(Memory))
    active = db.scalar(select(func.count()).select_from(Memory).where(Memory.status == "active"))
    used = db.scalar(
        select(func.count())
        .select_from(Memory)
        .where(Memory.last_used_at.is_not(None), Memory.status == "active")
    )
    return {"total": int(total or 0), "active": int(active or 0), "used": int(used or 0)}


@router.patch("/memories/{mid}", response_model=MemoryOut)
def patch_memory(mid: str, payload: MemoryPatch, db: Session = Depends(get_db)):
    row = db.get(Memory, mid)
    if row is None:
        raise HTTPException(404, "记忆不存在")
    if payload.text is not None:
        text = payload.text.strip()[:120]
        if not text:
            raise HTTPException(400, "内容不能为空")
        row.text = text
    if payload.status is not None:
        if payload.status not in ("active", "archived"):
            raise HTTPException(400, "status 只能是 active / archived")
        row.status = payload.status
    db.commit()
    db.refresh(row)
    return row


@router.delete("/memories/{mid}", status_code=204)
def delete_memory(mid: str, db: Session = Depends(get_db)):
    row = db.get(Memory, mid)
    if row is None:
        raise HTTPException(404, "记忆不存在")
    db.delete(row)
    db.commit()
    return None