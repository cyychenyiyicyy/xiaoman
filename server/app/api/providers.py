"""Provider / 模型 / 目录同步。"""
import time

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import LLMModel, LLMProvider
from ..schemas import ModelOut, ModelPatch, ProviderIn, ProviderOut, ProviderPatch
from ..seed import get_current, set_current
from ..services.llm import fetch_models

router = APIRouter(tags=["providers"])

VISION_HINTS = ("vl", "vision", "omni", "4o", "multimodal", "image")
THINK_HINTS = ("reason", "thinking", "r1", "o1", "o3", "o4", "pro")


def _out(db: Session, p: LLMProvider) -> ProviderOut:
    count = db.scalar(select(func.count()).select_from(LLMModel).where(LLMModel.provider_id == p.id))
    return ProviderOut(
        id=p.id,
        name=p.name,
        base_url=p.base_url,
        api_style=p.api_style,
        api_key_tail=p.api_key_tail,
        connected=p.connected,
        kind=p.kind,
        model_count=int(count or 0),
    )


@router.get("/providers", response_model=list[ProviderOut])
def list_providers(db: Session = Depends(get_db)):
    rows = db.scalars(
        select(LLMProvider).order_by(LLMProvider.sort, LLMProvider.created_at)
    ).all()
    return [_out(db, p) for p in rows]


@router.post("/providers", response_model=ProviderOut, status_code=201)
def create_provider(payload: ProviderIn, db: Session = Depends(get_db)):
    base = payload.base_url.strip().rstrip("/")
    if payload.api_style == "openai" and not base.startswith(("http://", "https://", "mock://")):
        raise HTTPException(400, "base_url 必须以 http(s):// 开头")
    provider = LLMProvider(
        name=payload.name.strip(),
        base_url=base,
        api_style=payload.api_style,
        api_key=payload.api_key.strip(),
        api_key_tail=payload.api_key.strip()[-4:] if len(payload.api_key.strip()) >= 8 else "",
        connected=False,
        kind="custom",
        sort=0,
    )
    db.add(provider)
    db.commit()
    db.refresh(provider)
    return _out(db, provider)


def _get(db: Session, pid: str) -> LLMProvider:
    provider = db.get(LLMProvider, pid)
    if provider is None:
        raise HTTPException(404, "provider 不存在")
    return provider


@router.patch("/providers/{pid}", response_model=ProviderOut)
def patch_provider(pid: str, payload: ProviderPatch, db: Session = Depends(get_db)):
    provider = _get(db, pid)
    if payload.name is not None:
        provider.name = payload.name.strip() or provider.name
    if payload.base_url is not None:
        provider.base_url = payload.base_url.strip().rstrip("/")
    if payload.api_style is not None:
        provider.api_style = payload.api_style
    if payload.connected is not None:
        provider.connected = payload.connected
    if payload.api_key is not None:
        key = payload.api_key.strip()
        provider.api_key = key
        provider.api_key_tail = key[-4:] if len(key) >= 8 else ""
        provider.connected = False
    db.commit()
    db.refresh(provider)
    return _out(db, provider)


@router.delete("/providers/{pid}", status_code=204)
def delete_provider(pid: str, db: Session = Depends(get_db)):
    provider = _get(db, pid)
    if provider.kind == "mock":
        raise HTTPException(400, "内置演示 provider 不能删除")
    db.delete(provider)
    db.commit()
    _repair_current(db)
    return None


def _repair_current(db: Session) -> None:
    provider, model, _ = get_current(db)
    set_current(
        db,
        provider.id if provider else None,
        model.id if model else None,
        None,
    )


@router.post("/providers/{pid}/test")
async def test_provider(pid: str, db: Session = Depends(get_db)):
    provider = _get(db, pid)
    started = time.perf_counter()
    try:
        models = await fetch_models(provider)
    except Exception as exc:  # noqa: BLE001 - 要把任意网络错误原样报给界面
        provider.connected = False
        db.commit()
        return {
            "ok": False,
            "models_count": 0,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "error": str(exc)[:300],
        }
    provider.connected = True
    db.commit()
    return {
        "ok": True,
        "models_count": len(models),
        "latency_ms": int((time.perf_counter() - started) * 1000),
        "error": None,
    }


@router.post("/providers/{pid}/sync-models")
async def sync_models(pid: str, db: Session = Depends(get_db)):
    provider = _get(db, pid)
    try:
        items = await fetch_models(provider)
    except Exception as exc:  # noqa: BLE001
        provider.connected = False
        db.commit()
        raise HTTPException(502, f"拉取模型失败：{str(exc)[:200]}") from exc

    provider.connected = True
    existing = {
        m.model_key: m
        for m in db.scalars(select(LLMModel).where(LLMModel.provider_id == provider.id)).all()
    }
    added = 0
    for idx, item in enumerate(items):
        key = item["id"]
        row = existing.get(key)
        guess_vision = any(h in key.lower() for h in VISION_HINTS)
        guess_think = any(h in key.lower() for h in THINK_HINTS)
        if row is None:
            db.add(
                LLMModel(
                    provider_id=provider.id,
                    model_key=key,
                    display_name=key,
                    context_len=int(item.get("context_length") or 0),
                    supports_images=bool(item.get("images") or guess_vision),
                    supports_thinking=bool(item.get("thinking") or guess_think),
                    enabled=True,
                    sort=idx,
                )
            )
            added += 1
        else:
            if item.get("context_length") and not row.context_len:
                row.context_len = int(item["context_length"])
            row.sort = idx
    db.commit()
    total = db.scalar(select(func.count()).select_from(LLMModel).where(LLMModel.provider_id == provider.id))
    _repair_current(db)
    return {"added": added, "total": int(total or 0)}


@router.get("/models", response_model=list[ModelOut])
def list_models(provider_id: str | None = None, db: Session = Depends(get_db)):
    stmt = select(LLMModel).order_by(LLMModel.provider_id, LLMModel.sort)
    if provider_id:
        stmt = stmt.where(LLMModel.provider_id == provider_id)
    return db.scalars(stmt).all()


@router.patch("/models/{mid}", response_model=ModelOut)
def patch_model(mid: str, payload: ModelPatch, db: Session = Depends(get_db)):
    row = db.get(LLMModel, mid)
    if row is None:
        raise HTTPException(404, "模型不存在")
    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row