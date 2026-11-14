"""首启 seed：单会话 + 内置 mock provider + 当前模型设置。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AppSetting, Conversation, LLMModel, LLMProvider

SETTING_KEY = "current"


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