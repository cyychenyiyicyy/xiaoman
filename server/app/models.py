"""MVP 数据表（6 张）。字段与 docs/21-MVP契约.md §3 一一对应。"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _id() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class LLMProvider(Base):
    __tablename__ = "llm_provider"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    base_url: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    api_style: Mapped[str] = mapped_column(String(20), nullable=False, default="openai")
    api_key: Mapped[str] = mapped_column(Text, nullable=False, default="")
    api_key_tail: Mapped[str] = mapped_column(String(8), nullable=False, default="")
    connected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="custom")
    catalog_id: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    models: Mapped[list["LLMModel"]] = relationship(
        back_populates="provider", cascade="all, delete-orphan", order_by="LLMModel.sort"
    )


class LLMModel(Base):
    __tablename__ = "llm_model"
    __table_args__ = (UniqueConstraint("provider_id", "model_key", name="uq_llm_model_provider_key"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    provider_id: Mapped[str] = mapped_column(
        ForeignKey("llm_provider.id", ondelete="CASCADE"), nullable=False, index=True
    )
    model_key: Mapped[str] = mapped_column(String(200), nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    context_len: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_len: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    supports_images: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    supports_thinking: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    supports_tools: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    meta_source: Mapped[str] = mapped_column(String(12), nullable=False, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    provider: Mapped[LLMProvider] = relationship(back_populates="models")


class Conversation(Base):
    __tablename__ = "conversation"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    subject: Mapped[str] = mapped_column(String(20), nullable=False, default="全部")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class Message(Base):
    __tablename__ = "message"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversation.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(12), nullable=False)  # user | assistant
    kind: Mapped[str] = mapped_column(String(12), nullable=False, default="text")
    content_md: Mapped[str] = mapped_column(Text, nullable=False, default="")
    reasoning_md: Mapped[str] = mapped_column(Text, nullable=False, default="")
    images: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    provider_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    model_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    thinking: Mapped[str] = mapped_column(String(8), nullable=False, default="off")
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="done")
    error: Mapped[str] = mapped_column(Text, nullable=False, default="")
    thinking_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sources: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    tools: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    remembered: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class Attachment(Base):
    __tablename__ = "attachment"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    filename: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    mime: Mapped[str] = mapped_column(String(120), nullable=False, default="application/octet-stream")
    bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    path: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class AppSetting(Base):
    __tablename__ = "app_setting"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)


class Memory(Base):
    """长期记忆：一句稳定的学习事实或偏好。对应 docs/07 §6 第 2/3 层的落地。"""

    __tablename__ = "memory"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(String(12), nullable=False, default="fact")  # fact | pref
    subject: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    source_message_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="active")  # active | archived
    use_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
