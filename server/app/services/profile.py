"""个人资料：agent 名字 + 用户基本信息（单用户，存在 app_setting 的 JSON 里）。

没有单独建表：这是单用户自托管项目，资料就是一条 key-value；
以后要多端同步，直接同步这条记录即可。
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import AppSetting

PROFILE_KEY = "profile"

DEFAULTS: dict = {
    "agent_name": "小满",
    "user_name": "",
    "gender": "",
    "grade": "高一",
    "completed": False,
}

GENDERS = {"", "female", "male", "other"}


def _clean_text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def get_profile(db: Session) -> dict:
    row = db.get(AppSetting, PROFILE_KEY)
    payload = dict(row.value) if row and isinstance(row.value, dict) else {}
    out = dict(DEFAULTS)
    for key in ("agent_name", "user_name", "grade"):
        if key in payload:
            out[key] = _clean_text(payload[key], 20)
    if payload.get("gender") in GENDERS:
        out["gender"] = payload["gender"]
    out["completed"] = bool(payload.get("completed")) and bool(out["user_name"] or out["agent_name"])
    if not out["agent_name"]:
        out["agent_name"] = DEFAULTS["agent_name"]
    return out


def set_profile(db: Session, patch: dict) -> dict:
    current = get_profile(db)
    for key in ("agent_name", "user_name", "grade"):
        if key in patch and patch[key] is not None:
            current[key] = _clean_text(patch[key], 20)
    if "gender" in patch and patch["gender"] in GENDERS:
        current["gender"] = patch["gender"]
    if not current["agent_name"]:
        current["agent_name"] = DEFAULTS["agent_name"]
    current["completed"] = bool(patch.get("completed", True))
    row = db.get(AppSetting, PROFILE_KEY)
    if row is None:
        row = AppSetting(key=PROFILE_KEY, value={})
        db.add(row)
    row.value = dict(current)
    db.commit()
    return get_profile(db)


def profile_block(profile: dict) -> str:
    """给 system prompt 用的一段稳定资料（放在最后，避免破坏前缀缓存）。"""
    agent = profile.get("agent_name") or "小满"
    user = profile.get("user_name") or ""
    gender = {"female": "女生", "male": "男生", "other": "不限定"}.get(profile.get("gender") or "", "")
    grade = profile.get("grade") or "高一"
    bits = [f"你的名字是{agent}。", f"你在陪{user or '她'}（{grade}{('，' + gender) if gender else ''}）学习。"]
    if user:
        bits.append(f"称呼她为{user}。")
    return "\n\n## 关于你们\n" + "\n".join(bits)
