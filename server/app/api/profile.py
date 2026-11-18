"""个人资料（首次引导 / 设置里修改）。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas import ProfilePatch
from ..services.profile import get_profile, set_profile

router = APIRouter(tags=["profile"])


@router.get("/profile")
def read_profile(db: Session = Depends(get_db)):
    return get_profile(db)


@router.patch("/profile")
def patch_profile(payload: ProfilePatch, db: Session = Depends(get_db)):
    return set_profile(db, payload.model_dump(exclude_none=True))
