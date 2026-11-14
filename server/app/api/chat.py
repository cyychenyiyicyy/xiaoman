"""会话 / 消息 / 聊天流（SSE）。"""
import asyncio
import json
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal, get_db
from ..models import Attachment, Conversation, Message
from ..schemas import ChatIn
from ..seed import get_current
from ..services.llm import stream_chat

router = APIRouter(tags=["chat"])


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _msg_out(m: Message) -> dict:
    return {
        "id": m.id,
        "role": m.role,
        "kind": m.kind,
        "content_md": m.content_md,
        "reasoning_md": m.reasoning_md,
        "images": m.images or [],
        "provider_id": m.provider_id,
        "model_key": m.model_key,
        "thinking": m.thinking,
        "status": m.status,
        "error": m.error,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _conversation(db: Session) -> Conversation:
    conv = db.scalar(select(Conversation).limit(1))
    if conv is None:
        conv = Conversation(subject="全部")
        db.add(conv)
        db.commit()
        db.refresh(conv)
    return conv


@router.get("/conversation")
def get_conversation(db: Session = Depends(get_db)):
    conv = _conversation(db)
    count = db.scalar(
        select(func.count()).select_from(Message).where(Message.conversation_id == conv.id)
    )
    return {
        "id": conv.id,
        "subject": conv.subject,
        "message_count": int(count or 0),
        "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
    }


@router.get("/messages")
def list_messages(before: str | None = None, limit: int = 50, db: Session = Depends(get_db)):
    conv = _conversation(db)
    limit = max(1, min(limit, 200))
    stmt = (
        select(Message)
        .where(Message.conversation_id == conv.id)
        .order_by(Message.created_at.desc(), Message.id.desc())
    )
    if before:
        anchor = db.get(Message, before)
        if anchor is not None:
            stmt = stmt.where(Message.created_at < anchor.created_at)
    rows = list(db.scalars(stmt.limit(limit + 1)).all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [_msg_out(m) for m in reversed(rows)]
    next_before = items[0]["id"] if (has_more and items) else None
    return {"items": items, "next_before": next_before}


@router.post("/chat")
async def chat(payload: ChatIn, db: Session = Depends(get_db)):
    text = (payload.text or "").strip()
    if not text and not payload.image_ids:
        raise HTTPException(400, "消息不能为空")

    provider, model, thinking = get_current(db)
    if provider is None or model is None:
        raise HTTPException(409, "还没有可用的模型，先添加一个 provider")

    conv = _conversation(db)

    attachments: list[Attachment] = []
    image_refs: list[dict] = []
    for aid in payload.image_ids[:8]:
        att = db.get(Attachment, aid)
        if att is not None:
            attachments.append(att)
            image_refs.append({"id": att.id, "url": f"/api/v1/attachments/{att.id}", "mime": att.mime})

    history = list(
        db.scalars(
            select(Message)
            .where(
                Message.conversation_id == conv.id,
                Message.status == "done",
                Message.role.in_(("user", "assistant")),
            )
            .order_by(Message.created_at.desc())
            .limit(settings.history_limit)
        ).all()
    )[::-1]

    user_msg = Message(
        conversation_id=conv.id,
        role="user",
        kind="image" if image_refs else "text",
        content_md=text,
        images=image_refs,
        provider_id=provider.id,
        model_key=model.model_key,
        thinking=thinking,
        status="done",
    )
    db.add(user_msg)
    db.flush()

    assistant = Message(
        conversation_id=conv.id,
        role="assistant",
        kind="text",
        content_md="",
        provider_id=provider.id,
        model_key=model.model_key,
        thinking=thinking,
        status="streaming",
    )
    db.add(assistant)
    conv.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user_msg)
    db.refresh(assistant)

    # 快照：流式期间请求级 Session 会关掉，不能再用 ORM 实例
    from types import SimpleNamespace

    provider_snap = SimpleNamespace(
        id=provider.id, base_url=provider.base_url, api_key=provider.api_key, kind=provider.kind
    )
    model_snap = SimpleNamespace(
        model_key=model.model_key,
        supports_thinking=model.supports_thinking,
        context_len=model.context_len,
    )

    provider_id, model_ref, assistant_id = provider.id, model.model_key, assistant.id
    user_id = user_msg.id
    conv_id = conv.id
    atts = attachments
    hist = [
        SimpleNamespace(role=m.role, content_md=m.content_md, images=m.images or []) for m in history
    ]

    async def event_stream() -> AsyncIterator[str]:
        text_parts: list[str] = []
        reason_parts: list[str] = []
        usage = {"prompt_tokens": 0, "completion_tokens": 0}
        error: dict | None = None
        cancelled = False

        yield _sse(
            {
                "type": "meta",
                "user_message_id": user_id,
                "assistant_message_id": assistant_id,
                "provider_id": provider_id,
                "model_key": model_ref,
                "thinking": thinking,
            }
        )

        try:
            async for ev in stream_chat(
                provider_snap,
                model_snap,
                hist,
                text,
                atts,
                thinking,
            ):
                kind = ev.get("type")
                if kind == "text":
                    text_parts.append(ev["delta"])
                    yield _sse({"type": "text", "delta": ev["delta"]})
                elif kind == "reasoning":
                    reason_parts.append(ev["delta"])
                    yield _sse({"type": "reasoning", "delta": ev["delta"]})
                elif kind == "usage":
                    usage = {
                        "prompt_tokens": int(ev.get("prompt_tokens") or 0),
                        "completion_tokens": int(ev.get("completion_tokens") or 0),
                    }
                elif kind == "error":
                    error = {"code": ev.get("code", "error"), "message": ev.get("message", "")}
                    yield _sse({"type": "error", **error})
                    break
        except asyncio.CancelledError:
            # 客户端断开（刷新/关页）：不能把半截回复记成 done，否则历史里会留一条残句
            cancelled = True
            raise
        except Exception as exc:  # noqa: BLE001 - 任何异常都要让界面看见，而不是静默断流
            error = {"code": "internal", "message": str(exc)[:400]}
            yield _sse({"type": "error", **error})
        finally:
            with SessionLocal() as s:
                row = s.get(Message, assistant_id)
                if row is not None:
                    row.content_md = "".join(text_parts)
                    row.reasoning_md = "".join(reason_parts)
                    if error:
                        row.status, row.error = "error", error["message"]
                    elif cancelled:
                        row.status, row.error = "error", "连接中断（客户端断开）"
                    else:
                        row.status = "done" if text_parts else "empty"
                    row.prompt_tokens = usage["prompt_tokens"]
                    row.completion_tokens = usage["completion_tokens"]
                    current = s.get(Conversation, conv_id)
                    if current is not None:
                        current.updated_at = datetime.now(timezone.utc)
                    s.commit()

        if error is None:
            yield _sse({"type": "done", "message_id": assistant_id, "usage": usage})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )