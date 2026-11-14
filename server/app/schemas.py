"""请求/响应模型。字段名与 docs/21-MVP契约.md 严格一致。"""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    base_url: str = ""
    api_key: str = ""
    api_style: str = "openai"
    catalog_id: str = ""


class ProviderPatch(BaseModel):
    name: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    api_style: str | None = None
    connected: bool | None = None


class ProviderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    base_url: str
    api_style: str
    api_key_tail: str
    connected: bool
    kind: str
    catalog_id: str = ""
    model_count: int = 0


class ModelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    provider_id: str
    model_key: str
    display_name: str
    context_len: int
    output_len: int = 0
    supports_images: bool
    supports_thinking: bool
    supports_tools: bool = False
    meta_source: str = ""
    enabled: bool


class ModelPatch(BaseModel):
    display_name: str | None = None
    context_len: int | None = None
    output_len: int | None = None
    supports_images: bool | None = None
    supports_thinking: bool | None = None
    supports_tools: bool | None = None
    enabled: bool | None = None


class SettingsOut(BaseModel):
    provider_id: str | None = None
    model_id: str | None = None
    thinking: str = "off"


class SettingsPatch(BaseModel):
    provider_id: str | None = None
    model_id: str | None = None
    thinking: str | None = None


class UploadOut(BaseModel):
    id: str
    url: str
    mime: str
    bytes: int


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    role: str
    kind: str
    content_md: str
    reasoning_md: str
    images: list = Field(default_factory=list)
    provider_id: str | None = None
    model_key: str | None = None
    thinking: str
    thinking_ms: int = 0
    status: str
    error: str
    created_at: datetime


class ChatIn(BaseModel):
    text: str = ""
    image_ids: list[str] = Field(default_factory=list)




class MemoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    text: str
    kind: str
    subject: str = ""
    status: str
    use_count: int = 0
    last_used_at: datetime | None = None
    created_at: datetime


class MemoryPatch(BaseModel):
    text: str | None = None
    status: str | None = None


class SearchCfgPatch(BaseModel):
    enabled: bool | None = None
    provider: str | None = None
    api_key: str | None = None
    max_results: int | None = None


class MemoryCfgPatch(BaseModel):
    auto: bool | None = None
