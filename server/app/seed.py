"""首启 seed：单会话 + 内置 mock provider + 当前模型设置。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AppSetting, Conversation, LLMModel, LLMProvider

SETTING_KEY = "current"
SEARCH_KEY = "search"
MEMORY_KEY = "memory"


def ensure_seed(db: Session) -> None:
    conv = db.scalar(select(Conversation).limit(1))
    if conv is None:
        conv = Conversation(subject="全部")
        db.add(conv)
        db.flush()

    mock = db.scalar(select(LLMProvider).where(LLMProvider.kind == "mock"))
    if mock is None:
        mock = LLMProvider(
            name="内置演示",
            base_url="mock://",
            api_style="openai",
            api_key="",
            api_key_tail="",
            connected=True,
            kind="mock",
            sort=-100,
        )
        db.add(mock)
        db.flush()
        db.add(
            LLMModel(
                provider_id=mock.id,
                model_key="mock-fast",
                display_name="演示模型",
                context_len=128000,
                supports_images=True,
                supports_thinking=True,
                enabled=True,
                sort=0,
            )
        )
        db.flush()

    setting = db.get(AppSetting, SETTING_KEY)
    if setting is None:
        mock_model = db.scalar(select(LLMModel).where(LLMModel.provider_id == mock.id).limit(1))
        db.add(
            AppSetting(
                key=SETTING_KEY,
                value={
                    "provider_id": mock.id,
                    "model_id": mock_model.id if mock_model else None,
                    "thinking": "off",
                },
            )
        )
    db.commit()


def get_current(db: Session) -> tuple[LLMProvider | None, LLMModel | None, str]:
    """当前 provider / model / 思考档，带兜底：坏引用退回第一条可用。"""
    setting = db.get(AppSetting, SETTING_KEY)
    payload = dict(setting.value) if setting else {}
    provider = db.get(LLMProvider, payload["provider_id"]) if payload.get("provider_id") else None
    model = db.get(LLMModel, payload["model_id"]) if payload.get("model_id") else None
    thinking = payload.get("thinking") or "off"

    if provider is None or not provider.connected:
        provider = db.scalar(select(LLMProvider).order_by(LLMProvider.sort, LLMProvider.created_at).limit(1))
    if model is None and provider is not None:
        model = db.scalar(
            select(LLMModel).where(LLMModel.provider_id == provider.id, LLMModel.enabled).limit(1)
        )
    return provider, model, thinking


def set_current(db: Session, provider_id: str | None, model_id: str | None, thinking: str | None) -> dict:
    setting = db.get(AppSetting, SETTING_KEY)
    value = dict(setting.value) if setting else {}
    if provider_id is not None:
        value["provider_id"] = provider_id
    if model_id is not None:
        value["model_id"] = model_id
    if thinking is not None:
        value["thinking"] = thinking
    if setting is None:
        setting = AppSetting(key=SETTING_KEY, value=value)
        db.add(setting)
    else:
        setting.value = value
    db.commit()
    return value

# ── 联网搜索 / 记忆 设置 ────────────────────────────────
SEARCH_DEFAULTS = {
    "enabled": True,
    "provider": "deepseek",
    "api_key": "",
    "api_key_tail": "",
    "max_results": 5,
}


def _get_json(db: Session, key: str, defaults: dict) -> dict:
    row = db.get(AppSetting, key)
    value = dict(defaults)
    if row and isinstance(row.value, dict):
        value.update(row.value)
    return value


def _set_json(db: Session, key: str, patch: dict) -> dict:
    row = db.get(AppSetting, key)
    value = dict(row.value) if row and isinstance(row.value, dict) else {}
    value.update(patch)
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value
    db.commit()
    return value


def get_search_cfg(db: Session) -> dict:
    cfg = _get_json(db, SEARCH_KEY, SEARCH_DEFAULTS)
    cfg.pop("api_key_raw", None)
    return cfg


def public_search_cfg(cfg: dict) -> dict:
    return {
        "enabled": bool(cfg.get("enabled")),
        "provider": cfg.get("provider") or "deepseek",
        "api_key_tail": cfg.get("api_key_tail") or "",
        "max_results": int(cfg.get("max_results") or 5),
    }


def set_search_cfg(db: Session, patch: dict) -> dict:
    clean = {}
    for k in ("enabled", "provider", "max_results"):
        if k in patch and patch[k] is not None:
            clean[k] = patch[k]
    if patch.get("api_key"):
        key = str(patch["api_key"]).strip()
        clean["api_key"] = key
        clean["api_key_tail"] = key[-4:] if len(key) >= 8 else ""
    return _get_json(db, SEARCH_KEY, SEARCH_DEFAULTS) if not clean else _set_json(db, SEARCH_KEY, clean)


def get_memory_cfg(db: Session) -> dict:
    return _get_json(db, MEMORY_KEY, {"auto": True})


def set_memory_cfg(db: Session, patch: dict) -> dict:
    clean = {k: patch[k] for k in ("auto",) if k in patch and patch[k] is not None}
    return _set_json(db, MEMORY_KEY, clean) if clean else get_memory_cfg(db)
