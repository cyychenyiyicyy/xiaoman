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