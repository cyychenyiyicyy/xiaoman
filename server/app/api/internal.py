"""内部工具端点：只给 Pi 网关回打（共享 token 保护，不暴露给前端）。

网关里的 Pi customTools 调这里，实现仍是本项目的既有逻辑（记忆 / DeepSeek 搜索）。
"""
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import LLMProvider
from ..seed import get_search_cfg
from ..services import memory as memory_service
from ..services import search as search_service
from sqlalchemy import select

router = APIRouter(tags=["internal"])


def guard(x_internal_token: str = Header(default="")) -> None:
    if settings.internal_token and x_internal_token != settings.internal_token:
        raise HTTPException(401, "bad internal token")


def _web_sources(items: list[dict]) -> list[dict]:
    return [
        {
            "type": "web",
            "title": i.get("title", ""),
            "url": i.get("url", ""),
            "snippet": i.get("snippet", ""),
            "site": i.get("site", ""),
        }
        for i in items
        if i.get("url")
    ]


class SearchIn(BaseModel):
    query: str


class AddIn(BaseModel):
    text: str
    kind: str = "fact"
    subject: str = ""


class UpdateIn(BaseModel):
    id: str
    text: str | None = None
    kind: str | None = None
    subject: str | None = None


class IdIn(BaseModel):
    id: str


@router.post("/internal/tools/memory_search", dependencies=[Depends(guard)])
def tool_memory_search(payload: SearchIn, db: Session = Depends(get_db)):
    rows = memory_service.retrieve(db, payload.query)
    memory_service.touch(db, rows)
    db.commit()
    items = [{"id": r.id, "text": r.text, "kind": r.kind, "subject": r.subject} for r in rows]
    return {"items": items, "sources": [{"type": "memory", **i} for i in items]}


@router.post("/internal/tools/memory_add", dependencies=[Depends(guard)])
def tool_memory_add(payload: AddIn, db: Session = Depends(get_db)):
    row = memory_service.create(db, payload.text, payload.kind, payload.subject)
    item = {"id": row.id, "text": row.text, "kind": row.kind, "subject": row.subject}
    return {"item": item, "sources": [{"type": "memory", **item}]}


@router.post("/internal/tools/memory_update", dependencies=[Depends(guard)])
def tool_memory_update(payload: UpdateIn, db: Session = Depends(get_db)):
    row = memory_service.update(db, payload.id, payload.text, payload.kind, payload.subject)
    return {"ok": bool(row), "id": payload.id}


@router.post("/internal/tools/memory_delete", dependencies=[Depends(guard)])
def tool_memory_delete(payload: IdIn, db: Session = Depends(get_db)):
    ok = memory_service.archive(db, payload.id)
    return {"ok": ok, "id": payload.id}


@router.post("/internal/tools/web_search", dependencies=[Depends(guard)])
async def tool_web_search(payload: SearchIn, db: Session = Depends(get_db)):
    cfg = get_search_cfg(db)
    provider = cfg.get("provider") or "deepseek"
    key = (cfg.get("api_key") or "").strip()
    if provider == "deepseek" and not key:
        row = db.scalars(select(LLMProvider).where(LLMProvider.base_url.contains("deepseek.com"))).first()
        key = row.api_key if row else ""
    items = await search_service.search(provider, key, payload.query, int(cfg.get("max_results") or 5))
    return {"items": items, "sources": _web_sources(items)}

# ── 题库工具（给 Pi 用）────────────────────────────────

import uuid as _uuid  # noqa: E402
import hashlib as _hashlib  # noqa: E402
import re as _re  # noqa: E402


class QSearchIn(BaseModel):
    query: str = ""
    subject: str = ""
    limit: int = 8


class QAddIn(BaseModel):
    subject: str = "全部"
    stem: str
    options: list[str] = []
    answer: str = ""
    qtype: str = "short"


class QUpdateIn(BaseModel):
    id: str
    stem: str | None = None
    options: list[str] | None = None
    answer: str | None = None
    subject: str | None = None
    qtype: str | None = None


def _q_fp(stem: str) -> str:
    norm = _re.sub(r"\s+", "", stem or "")
    norm = _re.sub(r"[$\\{}_^]", "", norm)
    return _hashlib.sha1(norm[:48].encode()).hexdigest()


def _q_out(q) -> dict:
    return {
        "id": q.id,
        "subject": q.subject,
        "type": q.qtype,
        "stem": q.stem_md,
        "options": q.options or [],
        "answer": q.answer_md or "",
        "source_page": q.source_page,
        "created_at": q.created_at.isoformat() if q.created_at else None,
        "image": f"/api/v1/questions/{q.id}/image" if q.stem_preview_png else "",
    }


@router.post("/internal/tools/question_search", dependencies=[Depends(guard)])
def tool_question_search(payload: QSearchIn, db: Session = Depends(get_db)):
    from ..models import Question

    stmt = select(Question).order_by(Question.created_at.desc()).limit(max(1, min(payload.limit, 20)))
    if payload.subject:
        stmt = stmt.where(Question.subject == payload.subject)
    if payload.query:
        stmt = stmt.where(Question.stem_md.ilike(f"%{payload.query}%"))
    rows = db.scalars(stmt).all()
    items = [_q_out(q) for q in rows]
    return {"items": items, "count": len(items)}


@router.post("/internal/tools/question_add", dependencies=[Depends(guard)])
def tool_question_add(payload: QAddIn, db: Session = Depends(get_db)):
    from ..models import Question

    fp = _q_fp(payload.stem)
    existing = db.scalar(select(Question).where(Question.stem_fp == fp))
    if existing is not None:
        return {"item": _q_out(existing), "already": True}

    q = Question(
        id=_uuid.uuid4().hex,
        subject=(payload.subject or "全部")[:20],
        stem_md=payload.stem.strip(),
        answer_md=(payload.answer or "").strip(),
        qtype=(payload.qtype or "short")[:16],
        options=payload.options or [],
        source="chat",
        source_page=1,
        stem_fp=fp,
    )
    db.add(q)
    db.commit()
    db.refresh(q)
    return {"item": _q_out(q), "already": False}


@router.post("/internal/tools/question_update", dependencies=[Depends(guard)])
def tool_question_update(payload: QUpdateIn, db: Session = Depends(get_db)):
    from ..models import Question

    q = db.get(Question, payload.id)
    if q is None:
        return {"ok": False, "error": "题目不存在"}
    if payload.stem is not None:
        q.stem_md = payload.stem.strip()
        q.stem_fp = _q_fp(q.stem_md)
    if payload.options is not None:
        q.options = payload.options
    if payload.answer is not None:
        q.answer_md = payload.answer.strip()
    if payload.subject is not None:
        q.subject = payload.subject[:20]
    if payload.qtype is not None:
        q.qtype = payload.qtype[:16]
    db.commit()
    db.refresh(q)
    return {"ok": True, "item": _q_out(q)}
