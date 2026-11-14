"""目录接口：内置平台 / 平台模型清单 / 单个模型元数据。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import LLMProvider
from ..services import catalog

router = APIRouter(tags=["catalog"])


@router.get("/catalog")
def list_catalog(db: Session = Depends(get_db)):
    providers = db.scalars(select(LLMProvider).where(LLMProvider.catalog_id != "")).all()
    by_catalog = {
        p.catalog_id: {"id": p.id, "connected": bool(p.connected and p.api_key)} for p in providers
    }
    return {"sources": catalog.sources(by_catalog)}


@router.get("/catalog/models")
def catalog_models(catalog_id: str):
    models = catalog.models_of(catalog_id)
    if not models:
        raise HTTPException(404, f"目录里没有 {catalog_id} 的模型")
    return {"models": models}


@router.get("/catalog/lookup")
def catalog_lookup(catalog_id: str, model_key: str):
    meta = catalog.lookup(catalog_id, model_key)
    if meta is None:
        raise HTTPException(404, "models.dev 未收录该模型")
    return meta