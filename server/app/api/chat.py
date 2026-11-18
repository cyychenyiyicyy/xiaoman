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
from ..models import Artifact, Attachment, Conversation, Message, Memory
from ..schemas import ChatIn
from ..seed import get_current, get_memory_cfg, get_search_cfg
from ..services import artifacts as artifact_service
from ..services import compact as compact_service
from ..services import deposit as deposit_service
from ..services import memory as memory_service
from ..services import quiz as quiz_service
from ..services import spaces
from ..services import search as search_service
from ..services.profile import get_profile
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
        "questions": m.questions or [],
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
        "deposits": m.deposits or [],
        "skill": m.skill or "",
        "artifact_id": m.artifact_id or "",
        "status": m.status,
        "error": m.error,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _conversation(db: Session, conversation_id: str | None = None, subject: str | None = None) -> Conversation:
    """有 conversation_id 就取那条；否则按学科取最近一条（没有就新建）。"""
    if conversation_id:
        conv = db.get(Conversation, conversation_id)
        if conv is not None:
            return conv
    return spaces.latest_conversation(db, subject, create=True)


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
def get_conversation(conversation_id: str | None = None, db: Session = Depends(get_db)):
    if conversation_id:
        conv = db.get(Conversation, conversation_id)
    else:
        conv = spaces.latest_conversation(db, None, create=False)
    if conv is None:
        return {"id": "", "subject": "全部", "message_count": 0}
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
def list_messages(
    before: str | None = None,
    limit: int = 50,
    conversation_id: str | None = None,
    db: Session = Depends(get_db),
):
    if conversation_id:
        conv = db.get(Conversation, conversation_id)
    else:
        conv = spaces.latest_conversation(db, None, create=False)
    if conv is None:
        return {"total": 0, "items": []}
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
    image_paths: list[str] | None = None,
    question_sources: list[dict] | None = None,
    artifact_context: str = "",
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
            "conversation_id": conv.id,
        }
    )
    for _qs in question_sources or []:
        yield _sse({"type": "source", "item": _qs})

    text_parts: list[str] = []
    reason_parts: list[str] = []
    sources: list[dict] = list(question_sources or [])
    tools: list[str] = []
    usage: dict = {}
    remembered: list[dict] = []
    parts: list[dict] = []
    cur_reason: dict | None = None
    cur_text: dict | None = None
    error = None
    got_done = False
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0)) as client:
            async with client.stream(
                "POST",
                f"{gateway}/agent/chat",
                json={
                    "subject": subject,
                    "text": text,
                    "thinking": thinking,
                    "images": image_paths or [],
                    "conversation_id": conv.id,
                    "assistant_message_id": assistant.id,
                    "skill": user_msg.skill or "",
                    "artifact_id": user_msg.artifact_id or "",
                    "artifact_context": artifact_context,
                    "profile": get_profile(db),
                },
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
                            if cur_text is None:
                                cur_text = {"type": "text", "text": ""}
                                parts.append(cur_text)
                                yield _sse({"type": "part", "kind": "text"})
                            cur_text["text"] += ev.get("delta", "")
                            text_parts.append(ev.get("delta", ""))
                            yield _sse({"type": "text", "delta": ev.get("delta", "")})
                        elif kind == "reasoning":
                            if cur_reason is None:
                                cur_reason = {"type": "reasoning", "text": "", "ms": 0}
                                parts.append(cur_reason)
                                yield _sse({"type": "part", "kind": "reasoning"})
                            cur_reason["text"] += ev.get("delta", "")
                            reason_parts.append(ev.get("delta", ""))
                            yield _sse({"type": "reasoning", "delta": ev.get("delta", "")})
                        elif kind == "tool":
                            if ev.get("state") == "start":
                                cur_reason = None
                                tools.append(ev.get("name") or "tool")
                                parts.append(
                                    {
                                        "type": "tool",
                                        "name": ev.get("name") or "tool",
                                        "queries": ev.get("queries") or [],
                                        "count": 0,
                                    }
                                )
                                yield _sse({"type": "part", "kind": "tool",
                                            "queries": ev.get("queries") or []})
                            else:
                                for p2 in reversed(parts):
                                    if p2.get("type") == "tool" and p2.get("count", 0) == 0:
                                        p2["count"] = max(1, int(ev.get("count") or 1))
                                        break
                            yield _sse({"type": "tool", **{k: v for k, v in ev.items() if k != "type"}})
                        elif kind == "source":
                            item = ev.get("item") or {}
                            key = item.get("url") or item.get("id")
                            if key and not any((x.get("url") or x.get("id")) == key for x in sources):
                                sources.append(item)
                            yield _sse({"type": "source", "item": item})
                        elif kind == "memory":
                            for it in ev.get("items") or []:
                                remembered.append(it)
                            yield _sse({"type": "memory", "items": ev.get("items") or []})
                        elif kind == "error":
                            error = {"code": ev.get("code", "pi"), "message": ev.get("message", "")}
                            yield _sse({"type": "error", **error})
                        elif kind == "done":
                            got_done = True
                            if isinstance(ev.get("usage"), dict):
                                usage = ev["usage"]
                            for it in ev.get("remembered") or []:
                                if not any(x.get("id") == it.get("id") for x in remembered):
                                    remembered.append(it)
                            if ev.get("sources"):
                                for item in ev["sources"]:
                                    key = item.get("url") or item.get("id")
                                    if key and not any((x.get("url") or x.get("id")) == key for x in sources):
                                        sources.append(item)
                            break
    except Exception as exc:  # noqa: BLE001
        error = {"code": "gateway", "message": str(exc)[:300]}
        yield _sse({"type": "error", **error})

    # 网关流被重启/断开时，可能没有 done；不能把它当正常完成存成空消息
    if error is None and not got_done:
        error = {"code": "stream_closed", "message": "这一轮连接中断了，重新发一条继续"}
        yield _sse({"type": "error", **error})

    think_ms = int((time.monotonic() - t0) * 1000) if reason_parts else 0
    if cur_reason is not None and not cur_reason.get("ms"):
        cur_reason["ms"] = think_ms
    with SessionLocal() as s2:
        row = s2.get(Message, assistant.id)
        if row is not None:
            row.content_md = "".join(text_parts)
            row.reasoning_md = "".join(reason_parts)
            row.status = "error" if error else "done"
            row.error = error["message"] if error else ""
            row.thinking_ms = think_ms
            row.parts = parts
            row.sources = sources
            row.tools = tools
            row.remembered = remembered
            if usage:
                row.prompt_tokens = int(usage.get("prompt_tokens") or 0)
                row.completion_tokens = int(usage.get("completion_tokens") or 0)
                row.cache_hit_tokens = int(usage.get("cache_hit") or 0)
                row.cache_miss_tokens = int(usage.get("cache_miss") or 0)
            try:
                parts = quiz_service.append_quiz_parts(s2, row)
                row.parts = parts
                parts = artifact_service.append_artifact_parts(s2, row)
                row.parts = parts
            except Exception:  # noqa: BLE001
                pass
            s2.commit()
        conv2 = s2.get(Conversation, conv.id)
        if conv2 is not None:
            conv2.updated_at = datetime.now(timezone.utc)
            s2.commit()

    # 回合后：自动沉淀（独立任务，不挡流；失败也不影响这次回答）
    if error is None and text_parts:
        try:
            deposit_service.spawn_after_turn(
                conv.id,
                assistant.id,
                user_msg.content_md or "",
                "".join(text_parts),
                [{"id": q.get("id", ""), "stem": q.get("stem") or q.get("title", ""), "subject": q.get("subject", "")} for q in (question_sources or [])],
            )
        except Exception:  # noqa: BLE001
            pass

    if error is None:
        yield _sse(
            {
                "type": "done",
                "message_id": assistant.id,
                "usage": usage or {},
                "thinking_ms": think_ms,
                "sources": sources,
                "tools": tools,
                "remembered": remembered,
                "parts": parts,
            }
        )


@router.post("/chat")
async def chat(payload: ChatIn, db: Session = Depends(get_db)):
    text = (payload.text or "").strip()
    if not text and not payload.image_ids:
        raise HTTPException(400, "消息不能为空")

    provider, model, thinking = get_current(db)
    if provider is None or model is None:
        raise HTTPException(409, "还没有可用的模型，先添加一个 provider")

    conv = _conversation(db, payload.conversation_id, payload.subject or spaces.current_subject(db))

    from ..models import Question

    question_refs: list[dict] = []
    question_block = ""
    for qid in (payload.question_ids or [])[:10]:
        q = db.get(Question, qid)
        if q is None:
            continue
        question_refs.append(
            {
                "id": q.id,
                "number": "",
                "type": q.qtype,
                "stem": q.stem_md,
                "options": q.options or [],
                "answer": q.answer_md or "",
                "subject": q.subject,
                "image": q.stem_preview_png or "",
            }
        )

    if question_refs:
        lines = []
        for i, qr in enumerate(question_refs, 1):
            lines.append(f"[题 {i}] {qr['stem']}")
            for op in qr["options"]:
                lines.append(f"  {op}")
        question_block = (
            "\n\n本轮她附上了这些题目（已经结构化，直接用，不要重述题面）：\n" + "\n".join(lines) + "\n"
        )

    if not (conv.title or "").strip() and text:
        conv.title = text[:30]
        db.commit()

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

    art = db.get(Artifact, payload.artifact_id) if payload.artifact_id else None
    if art is not None and art.conversation_id != conv.id:
        art = None
    artifact_context = ""
    if art is not None:
        artifact_context = (
            f"标题：{art.title}\n类型：{art.kind}\n技能：{art.skill or ''}\n原稿：\n"
            f"{(art.source_md or '')[:8000]}"
        )
    effective_skill = (payload.skill or (art.skill if art is not None else "") or "")[:32]

    user_msg = Message(
        conversation_id=conv.id,
        role="user",
        kind="image" if image_refs else "text",
        content_md=text,
        images=image_refs,
        questions=question_refs,
        provider_id=provider.id,
        model_key=model.model_key,
        thinking=thinking,
        status="done",
        skill=effective_skill,
        artifact_id=(art.id if art is not None else None),
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
        skill=effective_skill,
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
    return StreamingResponse(
        _relay_gateway(
            db, conv, user_msg, assistant,
            (question_block + text) if question_block else text,
            thinking, conv.subject,
            image_paths=[a.path for a in attachments]
            + [qr["image"] for qr in question_refs if qr.get("image")],
            question_sources=[
                {
                    "type": "question",
                    "id": qr["id"],
                    "title": qr["stem"],
                    "subject": qr.get("subject", ""),
                    "answer": qr.get("answer", ""),
                }
                for qr in question_refs
            ],
            artifact_context=artifact_context,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
