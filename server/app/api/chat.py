"""会话 / 消息 / 聊天流（SSE）。

v3：回合前注入记忆（命中的 id 记进 sources，让「根据记忆生成」可核查）；
回合中转发工具事件；回合后抽取新记忆并推 `memory` 事件。
"""
import asyncio
import json

import time
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import httpx

from ..config import settings
from ..db import SessionLocal, get_db
from ..models import Attachment, Conversation, Message, Memory
from ..schemas import ChatIn
from ..seed import get_current, get_memory_cfg, get_search_cfg
from ..services import compact as compact_service
from ..services import memory as memory_service
from ..services import spaces
from ..services import search as search_service
from ..services.llm import (
    MEMORY_ADD_TOOL,
    MEMORY_DELETE_TOOL,
    MEMORY_TOOL,
    MEMORY_UPDATE_TOOL,
    WEB_TOOL,
    build_openai_messages,
    stream_chat,
    stream_with_tools,
)

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
        "thinking_ms": m.thinking_ms or 0,
        "cache_hit_tokens": m.cache_hit_tokens or 0,
        "cache_miss_tokens": m.cache_miss_tokens or 0,
        "sources": m.sources or [],
        "tools": m.tools or [],
        "remembered": m.remembered or [],
        "parts": m.parts or [],
        "status": m.status,
        "error": m.error,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _conversation(db: Session) -> Conversation:
    return spaces.current_conversation(db)


@router.get("/subjects")
def subjects(db: Session = Depends(get_db)):
    return spaces.overview(db)


@router.patch("/subject")
def switch_subject(payload: dict, db: Session = Depends(get_db)):
    name = (payload or {}).get("subject") or ""
    try:
        cur = spaces.switch(db, name)
    except ValueError as exc:
        raise HTTPException(400, "未知学科") from exc
    conv = spaces.conversation_for(db, cur)
    count = db.scalar(
        select(func.count()).select_from(Message).where(Message.conversation_id == conv.id)
    )
    return {"current": cur, "conversation_id": conv.id, "message_count": int(count or 0)}


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


@router.get("/stats/cache")
def cache_stats(limit: int = 20, db: Session = Depends(get_db)):
    rows = list(
        db.scalars(
            select(Message)
            .where(Message.role == "assistant", Message.status == "done")
            .order_by(Message.created_at.desc())
            .limit(max(1, min(limit, 200)))
        ).all()
    )
    hit = sum(r.cache_hit_tokens or 0 for r in rows)
    miss = sum(r.cache_miss_tokens or 0 for r in rows)
    total = hit + miss
    return {
        "requests": len(rows),
        "hit_tokens": hit,
        "miss_tokens": miss,
        "hit_rate": round(hit / total, 4) if total else 0.0,
        "recent": [
            {
                "at": r.created_at.isoformat() if r.created_at else None,
                "hit": r.cache_hit_tokens or 0,
                "miss": r.cache_miss_tokens or 0,
            }
            for r in rows[:10]
        ],
    }


@router.get("/overview/today")
def overview_today(db: Session = Depends(get_db)):
    """「今天」空间：各科最近聊到哪 + 消息数（不是聊天，是首页概览）。"""
    items = []
    total = 0
    for name in spaces.SUBJECTS:
        if name == "全部":
            continue
        conv = db.scalar(select(Conversation).where(Conversation.subject == name).limit(1))
        if conv is None:
            continue
        count = db.scalar(
            select(func.count()).select_from(Message).where(Message.conversation_id == conv.id)
        ) or 0
        total += int(count)
        last = db.scalar(
            select(Message)
            .where(Message.conversation_id == conv.id)
            .order_by(Message.seq.desc())
            .limit(1)
        )
        text = (last.content_md if last else "") or ""
        items.append(
            {
                "subject": name,
                "count": int(count),
                "last_text": " ".join(text.split())[:80],
                "last_at": last.created_at.isoformat() if last and last.created_at else None,
                "last_role": last.role if last else None,
            }
        )
    items.sort(key=lambda x: (x["last_at"] is None, x["last_at"] or ""), reverse=True)
    return {"total": total, "items": items}


@router.get("/messages")
def list_messages(before: str | None = None, limit: int = 50, db: Session = Depends(get_db)):
    conv = _conversation(db)
    limit = max(1, min(limit, 200))
    stmt = (
        select(Message)
        .where(Message.conversation_id == conv.id)
        .order_by(Message.seq.desc())
    )
    if before:
        anchor = db.get(Message, before)
        if anchor is not None:
            stmt = stmt.where(Message.seq < anchor.seq)
    rows = list(db.scalars(stmt.limit(limit + 1)).all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [_msg_out(m) for m in reversed(rows)]
    next_before = items[0]["id"] if (has_more and items) else None
    return {"items": items, "next_before": next_before}


def _est_tokens(text: str) -> int:
    """粗估 token：中文约 1 字 1 token，英文约 4 字符 1 token。"""
    t = text or ""
    if not t:
        return 0
    # DeepSeek 中文约 0.6–0.7 token/字，英文约 0.25 token/字符
    cjk = sum(1 for ch in t if "\u4e00" <= ch <= "\u9fff")
    return int(cjk * 0.68 + (len(t) - cjk) / 4) + 4


def _web_block(sources: list[dict]) -> str:
    if not sources:
        return ""
    lines = []
    for i, s in enumerate(sources[:6], 1):
        lines.append(f"[{i}] {s.get('title','')} — {s.get('site','')}\n{s.get('snippet','')}")
    return "\n\n本轮联网检索到的资料（用得上就引用，按编号标出来源）：\n" + "\n".join(lines) + "\n"


async def _relay_gateway(
    db: Session,
    conv: Conversation,
    user_msg: Message,
    assistant: Message,
    text: str,
    thinking: str,
    subject: str,
) -> AsyncIterator[str]:
    """PI_GATEWAY 开着时：流由 Pi 产出，消息仍落我们的库。"""
    gateway = settings.pi_gateway.rstrip("/")
    yield _sse(
        {
            "type": "meta",
            "user_message_id": user_msg.id,
            "assistant_message_id": assistant.id,
            "provider_id": user_msg.provider_id,
            "model_key": user_msg.model_key,
            "thinking": thinking,
        }
    )
    text_parts: list[str] = []
    reason_parts: list[str] = []
    error = None
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0)) as client:
            async with client.stream(
                "POST",
                f"{gateway}/agent/chat",
                json={"subject": subject, "text": text, "thinking": thinking},
            ) as resp:
                if resp.status_code >= 400:
                    raw = (await resp.aread()).decode(errors="replace")[:400]
                    error = {"code": f"gateway_{resp.status_code}", "message": raw}
                    yield _sse({"type": "error", **error})
                else:
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        try:
                            ev = json.loads(line[5:].strip())
                        except json.JSONDecodeError:
                            continue
                        kind = ev.get("type")
                        if kind == "text":
                            text_parts.append(ev.get("delta", ""))
                            yield _sse({"type": "text", "delta": ev.get("delta", "")})
                        elif kind == "reasoning":
                            reason_parts.append(ev.get("delta", ""))
                            yield _sse({"type": "reasoning", "delta": ev.get("delta", "")})
                        elif kind in ("tool", "source"):
                            yield _sse(ev)
                        elif kind == "error":
                            error = {"code": ev.get("code", "pi"), "message": ev.get("message", "")}
                            yield _sse({"type": "error", **error})
                        elif kind == "done":
                            break
    except Exception as exc:  # noqa: BLE001
        error = {"code": "gateway", "message": str(exc)[:300]}
        yield _sse({"type": "error", **error})

    with SessionLocal() as s2:
        row = s2.get(Message, assistant.id)
        if row is not None:
            row.content_md = "".join(text_parts)
            row.reasoning_md = "".join(reason_parts)
            row.status = "error" if error else "done"
            row.error = error["message"] if error else ""
            row.thinking_ms = int((time.monotonic() - t0) * 1000) if reason_parts else 0
            row.parts = (
                ([{"type": "reasoning", "text": "".join(reason_parts), "ms": row.thinking_ms}] if reason_parts else [])
                + [{"type": "text", "text": "".join(text_parts)}]
            )
            s2.commit()
    if error is None:
        yield _sse({"type": "done", "message_id": assistant.id, "usage": {}, "thinking_ms": 0,
                    "sources": [], "tools": [], "parts": []})


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

    # ── 回合前：记忆检索 +（非原生）联网检索 ─────────────────
    # 记忆放 system（只放与本轮相关的；多数轮次为空 → 前缀不变）
    # 记忆由 memory_search 工具按需取（不注入 system），system 保持完全静态
    memory_sources: list[dict] = []

    search_cfg = get_search_cfg(db)
    web_sources: list[dict] = []
    search_on = bool(search_cfg.get("enabled") and text)
    # 搜索统一走我们自己的 web_search 工具（DeepSeek 用它的 Search API，5 元/千次），
    # 这样记忆工具和搜索可以同轮，不受「服务端工具不能混用」的限制。
    search_provider = search_cfg.get("provider") or "deepseek"
    search_key = (search_cfg.get("api_key") or "").strip()
    if search_provider == "deepseek" and not search_key:
        search_key = provider.api_key  # DeepSeek 搜索复用模型 provider 的 key
    web_hint = "\n\n本轮已开启联网搜索工具（web_search）：涉及新闻、价格、赛事、最新数据这类时效问题时直接调用它，不要回答「我无法联网」。\n" if search_on else ""

    # 历史：append-only；超过预算时由 compact 把最旧一段压成摘要，只保留最近的原文
    summary_block, hist_rows = compact_service.history(db, conv)
    history = hist_rows

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
        sources=web_sources,
        tools=["web_search"] if web_sources else [],
    )
    db.add(assistant)
    conv.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user_msg)
    db.refresh(assistant)

    # 快照：流式期间请求级 Session 会关掉，不能再用 ORM 实例
    provider_snap = SimpleNamespace(
        id=provider.id, base_url=provider.base_url, api_key=provider.api_key, kind=provider.kind
    )
    model_snap = SimpleNamespace(
        model_key=model.model_key,
        supports_thinking=model.supports_thinking,
        context_len=model.context_len,
    )
    if settings.pi_gateway:
        return StreamingResponse(
            _relay_gateway(db, conv, user_msg, assistant, text, thinking, conv.subject),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    provider_id, model_ref, assistant_id = provider.id, model.model_key, assistant.id
    user_id = user_msg.id
    conv_id = conv.id
    atts = attachments
    hist = [
        SimpleNamespace(role=m.role, content_md=m.content_md, images=m.images or []) for m in history
    ]
    initial_sources = list(web_sources)
    auto_memory = bool(get_memory_cfg(db).get("auto", True))

    async def event_stream() -> AsyncIterator[str]:
        text_parts: list[str] = []
        reason_parts: list[str] = []
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "cache_hit": 0, "cache_miss": 0}
        error: dict | None = None
        cancelled = False
        t_think_start: float | None = None
        t_think_end: float | None = None
        think_ms = 0
        sources: list[dict] = list(initial_sources)
        tools: list[str] = ["web_search"] if web_sources else []
        remembered: list[dict] = []
        parts: list[dict] = []
        cur_reason: dict | None = None
        cur_text: dict | None = None
        reason_t0: float | None = None
        seen_urls = {s.get("url") for s in sources if s.get("url")}

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
        if web_sources:
            yield _sse({"type": "tool", "name": "web_search", "state": "end", "count": len(web_sources)})

        async def _exec_tool(name: str, args: dict):
            """服务端执行函数工具（记忆检索 / 增改删 / 联网）。"""
            args = args or {}
            query = args.get("query") or text
            if name == "memory_add":
                with SessionLocal() as s2:
                    row = memory_service.create(
                        s2, args.get("text", ""), args.get("kind", "fact"),
                        args.get("subject", ""), assistant_id,
                    )
                    item = {"id": row.id, "text": row.text, "kind": row.kind, "subject": row.subject}
                remembered.append(item)
                return [item]
            if name in ("memory_update", "memory_delete"):
                with SessionLocal() as s2:
                    if name == "memory_update":
                        row = memory_service.update(
                            s2, args.get("id", ""), args.get("text"),
                            args.get("kind"), args.get("subject"),
                        )
                        return [{"ok": bool(row), "id": args.get("id", "")}]
                    ok = memory_service.archive(s2, args.get("id", ""))
                    return [{"ok": ok, "id": args.get("id", "")}]
            if name == "memory_search":
                with SessionLocal() as s2:
                    rows = memory_service.retrieve(s2, query)
                    memory_service.touch(s2, rows)
                    s2.commit()
                    out = [
                        {"id": r.id, "text": r.text, "kind": r.kind, "subject": r.subject}
                        for r in rows
                    ]
                for item in out:
                    if not any(x.get("id") == item["id"] for x in sources):
                        sources.append({"type": "memory", **item})
                return out
            if name == "web_search":
                items = await search_service.search(
                    search_provider,
                    search_key,
                    query,
                    int(search_cfg.get("max_results") or 5),
                )
                for item in items:
                    if item.get("url") and item["url"] not in seen_urls:
                        seen_urls.add(item["url"])
                        sources.append(item)
                return items
            return []

        fn_tools: list[dict] = [MEMORY_TOOL, MEMORY_ADD_TOOL, MEMORY_UPDATE_TOOL, MEMORY_DELETE_TOOL]
        if search_on:
            fn_tools.append(WEB_TOOL)

        try:
            if getattr(provider_snap, "kind", "") == "mock" or (provider_snap.base_url or "").startswith("mock://"):
                stream = stream_chat(
                    provider_snap, model_snap, hist, text, atts, thinking,
                    memory_block=memory_block, web_block=web_hint,
                    native_search=False, summary_block=summary_block,
                )
            else:
                base_msgs = build_openai_messages(hist, text, atts, "", web_hint, summary_block=summary_block)
                stream = stream_with_tools(
                    provider_snap, model_snap, base_msgs, thinking, fn_tools, _exec_tool,
                )
            async for ev in stream:
                kind = ev.get("type")
                if kind == "text":
                    if t_think_start is not None and t_think_end is None:
                        t_think_end = time.monotonic()
                    if cur_text is None:
                        cur_text = {"type": "text", "text": ""}
                        parts.append(cur_text)
                        yield _sse({"type": "part", "kind": "text"})
                    cur_text["text"] += ev["delta"]
                    text_parts.append(ev["delta"])
                    yield _sse({"type": "text", "delta": ev["delta"]})
                elif kind == "reasoning":
                    if t_think_start is None:
                        t_think_start = time.monotonic()
                    fresh = cur_reason is None
                    if fresh:
                        cur_reason = {"type": "reasoning", "text": "", "ms": 0}
                        reason_t0 = time.monotonic()
                        parts.append(cur_reason)
                        yield _sse({"type": "part", "kind": "reasoning"})
                    cur_reason["text"] += ev["delta"]
                    reason_parts.append(ev["delta"])
                    yield _sse({"type": "reasoning", "delta": ev["delta"]})
                elif kind == "step_end":
                    if cur_reason is not None:
                        if reason_t0 is not None:
                            cur_reason["ms"] = int((time.monotonic() - reason_t0) * 1000)
                        cur_reason = None
                        reason_t0 = None
                        yield _sse({"type": "part_end", "kind": "reasoning"})
                elif kind == "usage":
                    usage = {
                        "prompt_tokens": int(ev.get("prompt_tokens") or 0),
                        "completion_tokens": int(ev.get("completion_tokens") or 0),
                        "cache_hit": int(ev.get("cache_hit") or 0),
                        "cache_miss": int(ev.get("cache_miss") or 0),
                    }
                elif kind == "tool":
                    tname = ev.get("name") or "web_search"
                    if ev.get("state") == "start":
                        cur_reason = None
                        tools.append(tname)
                        parts.append(
                            {
                                "type": "tool",
                                "name": tname,
                                "queries": ev.get("queries") or [],
                                "kind": ev.get("kind") or "search",
                                "count": 0,
                            }
                        )
                        yield _sse({"type": "part", "kind": "tool", "index": len(parts) - 1,
                                    "queries": ev.get("queries") or []})
                    elif ev.get("state") == "end":
                        for p in reversed(parts):
                            if p.get("type") == "tool" and p.get("count", 0) == 0:
                                p["count"] = 1
                                break
                        yield _sse({"type": "part_update", "kind": "tool"})
                    yield _sse({"type": "tool", **{k: v for k, v in ev.items() if k != "type"}})
                elif kind == "source":
                    item = ev.get("item") or {}
                    url = item.get("url")
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        sources.append(item)
                        yield _sse({"type": "source", "item": item})
                elif kind == "error":
                    error = {"code": ev.get("code", "error"), "message": ev.get("message", "")}
                    yield _sse({"type": "error", **error})
                    break
        except asyncio.CancelledError:
            cancelled = True
            raise
        except Exception as exc:  # noqa: BLE001 - 任何异常都要让界面看见，而不是静默断流
            error = {"code": "internal", "message": str(exc)[:400]}
            yield _sse({"type": "error", **error})
        finally:
            if t_think_start is not None:
                think_ms = int(((t_think_end or time.monotonic()) - t_think_start) * 1000)
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
                    row.thinking_ms = think_ms
                    row.sources = sources
                    row.tools = tools
                    row.parts = parts
                    row.prompt_tokens = usage["prompt_tokens"]
                    row.completion_tokens = usage["completion_tokens"]
                    row.cache_hit_tokens = usage.get("cache_hit", 0)
                    row.cache_miss_tokens = usage.get("cache_miss", 0)
                    current = s.get(Conversation, conv_id)
                    if current is not None:
                        current.updated_at = datetime.now(timezone.utc)
                    s.commit()

        if error is None:
            yield _sse(
                {
                    "type": "done",
                    "message_id": assistant_id,
                    "usage": usage,
                    "thinking_ms": think_ms,
                    "sources": sources,
                    "tools": tools,
                    "parts": parts,
                }
            )

            # ── 回合后：抽取记忆（不阻塞正文，done 之后再发）────
            if auto_memory and text and "".join(text_parts).strip():
                existing = list(
                    db.scalars(select(Memory).where(Memory.status == "active").limit(400)).all()
                )
                try:
                    items = await memory_service.extract(
                        provider_snap, model_snap, text, "".join(text_parts), existing
                    )
                except Exception:  # noqa: BLE001
                    items = []
                if items:
                    with SessionLocal() as s:
                        saved = memory_service.save(s, items, assistant_id)
                        row = s.get(Message, assistant_id)
                        if row is not None:
                            row.remembered = saved
                            s.commit()
                    yield _sse({"type": "memory", "items": saved})

            # 上下文压缩：超过预算才跑，失败不影响对话
            try:
                with SessionLocal() as s3:
                    conv_row = s3.get(Conversation, conv_id)
                    info = await compact_service.maybe_compact(
                        s3, conv_row, provider_snap, model_snap
                    ) if conv_row is not None else None
                if info:
                    yield _sse({"type": "compacted", **info})
            except Exception:  # noqa: BLE001
                pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )