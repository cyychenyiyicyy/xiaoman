"""当前模型 / 思考档位。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import LLMModel, LLMProvider
from ..schemas import MemoryCfgPatch, SearchCfgPatch, SettingsOut, SettingsPatch
from ..seed import (
    get_current,
    get_memory_cfg,
    get_search_cfg,
    public_search_cfg,
    set_current,
    set_memory_cfg,
    set_search_cfg,
)

router = APIRouter(tags=["settings"])

VALID_THINKING = {"off", "low", "med", "high"}


@router.get("/settings", response_model=SettingsOut)
def read_settings(db: Session = Depends(get_db)):
    provider, model, thinking = get_current(db)
    return SettingsOut(
        provider_id=provider.id if provider else None,
        model_id=model.id if model else None,
        thinking=thinking if thinking in VALID_THINKING else "off",
    )


@router.patch("/settings", response_model=SettingsOut)
def patch_settings(payload: SettingsPatch, db: Session = Depends(get_db)):
    if payload.thinking is not None and payload.thinking not in VALID_THINKING:
        raise HTTPException(400, "thinking 只能是 off/low/med/high")

    if payload.provider_id is not None:
        provider = db.get(LLMProvider, payload.provider_id)
        if provider is None:
            raise HTTPException(404, "provider 不存在")

    if payload.model_id is not None:
        model = db.get(LLMModel, payload.model_id)
        if model is None:
            raise HTTPException(404, "模型不存在")
        if payload.provider_id and model.provider_id != payload.provider_id:
            raise HTTPException(400, "模型不属于该 provider")

    value = set_current(db, payload.provider_id, payload.model_id, payload.thinking)
    provider, model, thinking = get_current(db)
    return SettingsOut(
        provider_id=provider.id if provider else None,
        model_id=model.id if model else None,
        thinking=thinking if thinking in VALID_THINKING else value.get("thinking", "off"),
    )

# ── 联网搜索设置 ───────────────────────────────────────
VALID_SEARCH = {"deepseek", "tavily", "bocha"}


@router.get("/settings/search")
def read_search(db: Session = Depends(get_db)):
    return public_search_cfg(get_search_cfg(db))


@router.patch("/settings/search")
def patch_search(payload: SearchCfgPatch, db: Session = Depends(get_db)):
    if payload.provider is not None and payload.provider not in VALID_SEARCH:
        raise HTTPException(400, "provider 只能是 deepseek / tavily / bocha")
    if payload.max_results is not None and not (1 <= payload.max_results <= 10):
        raise HTTPException(400, "max_results 范围 1–10")
    cfg = set_search_cfg(db, payload.model_dump(exclude_none=True))
    return public_search_cfg(cfg)


@router.post("/settings/search/test")
async def test_search(db: Session = Depends(get_db)):
    from ..services import search as search_service

    cfg = get_search_cfg(db)
    prov = cfg.get("provider") or "deepseek"
    key = cfg.get("api_key") or ""
    if not key and prov != "deepseek":
        raise HTTPException(400, "还没填 API Key")
    if prov == "deepseek":
        return {"ok": True, "latency_ms": 0, "count": 0,
                "error": None if key else "DeepSeek 原生搜索复用当前模型的 key"}
    return await search_service.test(prov, key)


@router.get("/settings/memory")
def read_memory_cfg(db: Session = Depends(get_db)):
    return get_memory_cfg(db)


@router.patch("/settings/memory")
def patch_memory_cfg(payload: MemoryCfgPatch, db: Session = Depends(get_db)):
    return set_memory_cfg(db, payload.model_dump(exclude_none=True))
