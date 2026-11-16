"""技能注册表：读取 agent/skills.json（网关和 API 共用同一份）。"""
from __future__ import annotations

import json
from pathlib import Path

SKILLS_FILE = Path(__file__).resolve().parents[3] / "agent" / "skills.json"


def _load() -> list[dict]:
    try:
        data = json.loads(SKILLS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = data.get("skills") if isinstance(data, dict) else data
    return [s for s in (items or []) if isinstance(s, dict) and s.get("id")]


def public_list() -> list[dict]:
    """给前端的元数据：不带 prompt（提示词不下发）。"""
    return [
        {
            "id": s["id"],
            "name": s.get("name") or s["id"],
            "icon": s.get("icon") or "sparkles",
            "desc": s.get("desc") or "",
            "tools": s.get("tools") or [],
        }
        for s in _load()
    ]


def get(skill_id: str) -> dict | None:
    for s in _load():
        if s.get("id") == skill_id:
            return s
    return None
