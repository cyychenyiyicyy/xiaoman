"""当前模型 / 思考档位。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import LLMModel, LLMProvider
from ..schemas import SettingsOut, SettingsPatch
from ..seed import get_current, set_current

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