"""LLM 适配层：OpenAI 兼容直连 + 内置 mock。

对外只暴露一个异步生成器 `stream_chat`，事件形状与 docs/21 §4.2 对齐：
    {"type": "reasoning", "delta": str}
    {"type": "text", "delta": str}
    {"type": "usage", "prompt_tokens": int, "completion_tokens": int}
    {"type": "error", "code": str, "message": str}
接 Pi 时只替换本文件实现，上层不动。
"""
from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncIterator

from datetime import datetime

import httpx

from ..config import settings
from ..models import Attachment, LLMModel, LLMProvider, Message

SYSTEM_PROMPT = """你是小满，一个陪着一个高一学生学习的伙伴。她叫小满，是名字不是"AI 助手"。

说话方式：
- 短。一条回复一般不超过 4 行；要展开时先给一句结论，再给细节。
- 像老师，不像客服。禁止"您好，请问有什么可以帮您"这类腔调。
- 不评判人，把错归到机制上："这里漏的是摩擦力"，不说"你又粗心"。
- 不确定就说不确定；库里没有的东西不要编。
- 中文回答。公式用行内 LaTeX（$...$）或代码块，不要用图片代替推导。

现在只做对话，不做题目解析、错题本、复习调度——那些功能还没上。
"""

THINKING_MAP = {"low": "low", "med": "medium", "high": "high"}


def _data_url(att: Attachment) -> str:
    with open(att.path, "rb") as fh:
        raw = base64.b64encode(fh.read()).decode()
    mime = att.mime or "image/jpeg"
    return f"data:{mime};base64,{raw}"


def today_line() -> str:
    return "\n\n今天是 " + datetime.now().strftime("%Y 年 %m 月 %d 日") + "。"


def build_openai_messages(
    history: list[Message],
    user_text: str,
    attachments: list[Attachment],
    memory_block: str = "",
    web_block: str = "",
    dynamic_prefix: str = "",
) -> list[dict]:
    """把历史 + 本轮拼成 OpenAI messages。历史只取文本，图片仅本轮带。"""
    # 关键：system 必须完全静态，否则每轮前缀都不同，DeepSeek 的自动前缀缓存永远命中不了
    # 静态前缀 + 很少变的记忆块（Open WebUI #20317 的做法）：记忆留 system，网页走工具
    msgs: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT + today_line() + (memory_block or "")}]
    cap = settings.message_char_cap
    for m in history[-settings.history_limit :]:
        body = (m.content_md or "")[:cap]
        if not body and not m.images:
            continue
        if m.role == "assistant":
            msgs.append({"role": "assistant", "content": body})
        else:
            if m.images:
                parts: list[dict] = [{"type": "text", "text": body or "（图片）"}]
                parts.append({"type": "text", "text": f"[本轮历史含 {len(m.images)} 张图片，已略]"})
                msgs.append({"role": "user", "content": parts})
            else:
                msgs.append({"role": "user", "content": body})

    ctx = (web_block or "").strip()  # 网页资料只作为本轮临时提示，不进历史
    lead = (ctx + "\n\n") if ctx else ""
    if attachments:
        parts = [{"type": "text", "text": lead + (user_text or "看看这个。")}]
        for att in attachments:
            parts.append({"type": "image_url", "image_url": {"url": _data_url(att)}})
        msgs.append({"role": "user", "content": parts})
    else:
        msgs.append({"role": "user", "content": lead + user_text})
    return msgs


async def _mock_stream(user_text: str, n_images: int, thinking: str) -> AsyncIterator[dict]:
    await asyncio.sleep(0.15)
    if thinking != "off":
        for piece in ["先看一下这个问题。", "需要结合上下文。", "答案是分步的。"]:
            await asyncio.sleep(0.12)
            yield {"type": "reasoning", "delta": piece}
    head = f"收到。你发了 {n_images} 张图。" if n_images else "收到。"
    body = (
        f"{head}\n\n这是**内置演示模型**的回显：\n\n"
        f"> {(user_text or '（无文字）')[:200]}\n\n"
        "公式测试：\n\n$$E=mc^2$$\n\n"
        "在下面点模型胶囊，添加一个真实端点（baseUrl + API Key），"
        "就能换成真的回答。"
    )
    for i in range(0, len(body), 12):
        await asyncio.sleep(0.03)
        yield {"type": "text", "delta": body[i : i + 12]}
    yield {"type": "usage", "prompt_tokens": 0, "completion_tokens": 0}


async def stream_chat(
    provider: LLMProvider,
    model: LLMModel,
    history: list[Message],
    user_text: str,
    attachments: list[Attachment],
    thinking: str,
    memory_block: str = "",
    web_block: str = "",
    native_search: bool = False,
) -> AsyncIterator[dict]:
    """统一入口。provider.kind == 'mock' 走内置回显。"""
    if provider.kind == "mock" or provider.base_url.startswith("mock://"):
        async for ev in _mock_stream(user_text, len(attachments), thinking):
            yield ev
        return

    base = provider.base_url.rstrip("/")
    url = f"{base}/chat/completions"
    payload: dict = {
        "model": model.model_key,
        "messages": build_openai_messages(history, user_text, attachments, memory_block, web_block),
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if model.supports_thinking and thinking in THINKING_MAP:
        payload["reasoning_effort"] = THINKING_MAP[thinking]
    if model.context_len:
        payload["max_tokens"] = min(settings.default_max_tokens, max(512, model.context_len // 8))
    if native_search:
        # DeepSeek 服务端工具：声明后由模型自己决定何时搜。注意同一请求不能再声明别的工具。
        payload["tools"] = [{"type": "deepseek_web_search"}]
        if model.supports_thinking and thinking != "off":
            payload["thinking"] = {"type": "enabled"}

    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0)) as client:
            # 有些 provider 不认 reasoning_effort，会直接 400。降级重试一次（去掉该参数）。
            payloads = [payload]
            if "reasoning_effort" in payload or "thinking" in payload:
                payloads.append(
                    {k: v for k, v in payload.items() if k not in ("reasoning_effort", "thinking")}
                )
            resp = None
            for attempt, body in enumerate(payloads):
                req = client.build_request("POST", url, headers=headers, json=body)
                resp = await client.send(req, stream=True)
                if resp.status_code == 400 and attempt + 1 < len(payloads):
                    await resp.aread()
                    await resp.aclose()
                    continue
                break
            assert resp is not None
            try:
                if resp.status_code >= 400:
                    raw = (await resp.aread()).decode(errors="replace")[:800]
                    yield {"type": "error", "code": f"http_{resp.status_code}", "message": raw}
                    return
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    usage = chunk.get("usage")
                    if usage:
                        details = usage.get("prompt_tokens_details") or {}
                        hit = usage.get("prompt_cache_hit_tokens")
                        if hit is None:
                            hit = details.get("cached_tokens")
                        miss = usage.get("prompt_cache_miss_tokens")
                        prompt_tokens = int(usage.get("prompt_tokens") or 0)
                        hit_i = int(hit or 0)
                        if miss is None:
                            miss_i = max(0, prompt_tokens - hit_i)
                        else:
                            miss_i = int(miss)
                        yield {
                            "type": "usage",
                            "prompt_tokens": prompt_tokens,
                            "completion_tokens": int(usage.get("completion_tokens") or 0),
                            "cache_hit": hit_i,
                            "cache_miss": miss_i,
                        }
                    for choice in chunk.get("choices") or []:
                        ste = choice.get("server_tool_event")
                        if isinstance(ste, dict):
                            ev_type = ste.get("type")
                            call = ste.get("call") or {}
                            kind = (call.get("kind") or "search")
                            if ev_type == "call_started":
                                action = call.get("action") or {}
                                yield {
                                    "type": "tool",
                                    "name": "web_search",
                                    "state": "start",
                                    "queries": action.get("queries") or ([action.get("url")] if action.get("url") else []),
                                    "kind": kind,
                                }
                            elif ev_type == "step_reasoning_done":
                                yield {"type": "step_end", "kind": "reasoning"}
                            elif ev_type == "call_completed":
                                yield {"type": "tool", "name": "web_search", "state": "end", "kind": kind}
                                for src in _norm_web(call.get("sources") or []):
                                    yield {"type": "source", "item": src}
                        delta = choice.get("delta") or {}
                        reason = delta.get("reasoning_content") or delta.get("reasoning")
                        if reason:
                            yield {"type": "reasoning", "delta": reason}
                        content = delta.get("content")
                        if content:
                            yield {"type": "text", "delta": content}
                        # 兜底：有些实现只在最后一个 chunk 给完整 server_tool_calls
                        for step in delta.get("server_tool_calls") or []:
                            for call in step.get("calls") or []:
                                for src in _norm_web(call.get("sources") or []):
                                    yield {"type": "source", "item": src}
            finally:
                await resp.aclose()
    except httpx.HTTPError as exc:
        yield {"type": "error", "code": "network", "message": str(exc)[:500]}


async def fetch_models(provider: LLMProvider) -> list[dict]:
    """拉 provider 的 /models。mock 返回固定一条。"""
    if provider.kind == "mock" or provider.base_url.startswith("mock://"):
        return [{"id": "mock-fast", "context_length": 128000, "images": True, "thinking": True}]
    base = provider.base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {provider.api_key}"} if provider.api_key else {}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{base}/models", headers=headers)
        resp.raise_for_status()
        data = resp.json()
    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        key = it.get("id") or it.get("name")
        if not key:
            continue
        out.append(
            {
                "id": key,
                "context_length": int(it.get("context_length") or it.get("max_context_length") or 0),
            }
        )
    return out


def _norm_web(items: list) -> list[dict]:
    """把 DeepSeek 的 sources 归一成界面要的形状。"""
    out = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        url = (it.get("url") or "").strip()
        if not url:
            continue
        out.append(
            {
                "type": "web",
                "title": (it.get("title") or url)[:200],
                "url": url,
                "snippet": (it.get("snippet") or "")[:400],
                "site": (it.get("site_name") or "")[:80],
            }
        )
    return out


async def complete_text(
    provider: LLMProvider,
    model: LLMModel,
    system: str,
    user: str,
    max_tokens: int = 400,
) -> str:
    """非流式一次性调用，用于回合后的记忆抽取。"""
    base = provider.base_url.rstrip("/")
    url = f"{base}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    payload = {
        "model": model.model_key,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
        "max_tokens": max_tokens,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=15.0)) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        return ""
    return ((choices[0].get("message") or {}).get("content") or "").strip()


# ── 函数工具循环（on-demand retrieval：记忆/联网不再自动注入，改为模型自己调）──
MEMORY_TOOL = {
    "type": "function",
    "function": {
        "name": "memory_search",
        "description": "检索你长期记住的关于她的事（学习薄弱点、偏好、习惯、目标）。问到她的情况、或需要个性化建议时先调这个。",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "检索关键词，用她的原话即可"}},
            "required": ["query"],
        },
    },
}

WEB_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "联网搜索。涉及新闻、价格、赛事、最新数据这类时效问题时调用。",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "搜索词"}},
            "required": ["query"],
        },
    },
}


async def stream_with_tools(
    provider: LLMProvider,
    model: LLMModel,
    messages: list[dict],
    thinking: str,
    tools: list[dict],
    executor,
    server_tools: list[dict] | None = None,
) -> AsyncIterator[dict]:
    """OpenAI 函数工具循环（最多 3 轮）。与 native 服务端工具互斥。"""
    base = provider.base_url.rstrip("/")
    url = f"{base}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"

    msgs = list(messages)
    for _round in range(3):
        payload: dict = {
            "model": model.model_key,
            "messages": msgs,
            "stream": True,
            "stream_options": {"include_usage": True},
            "tools": list(tools) + list(server_tools or []),
        }
        if model.supports_thinking and thinking in THINKING_MAP:
            payload["reasoning_effort"] = THINKING_MAP[thinking]
        if model.context_len:
            payload["max_tokens"] = min(settings.default_max_tokens, max(512, model.context_len // 8))

        calls: dict[int, dict] = {}
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=15.0)) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as resp:
                    if resp.status_code >= 400:
                        raw = (await resp.aread()).decode(errors="replace")[:800]
                        yield {"type": "error", "code": f"http_{resp.status_code}", "message": raw}
                        return
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        usage = chunk.get("usage")
                        if usage:
                            details = usage.get("prompt_tokens_details") or {}
                            hit = usage.get("prompt_cache_hit_tokens")
                            if hit is None:
                                hit = details.get("cached_tokens")
                            miss = usage.get("prompt_cache_miss_tokens")
                            pt = int(usage.get("prompt_tokens") or 0)
                            hi = int(hit or 0)
                            yield {
                                "type": "usage",
                                "prompt_tokens": pt,
                                "completion_tokens": int(usage.get("completion_tokens") or 0),
                                "cache_hit": hi,
                                "cache_miss": int(miss) if miss is not None else max(0, pt - hi),
                            }
                        for choice in chunk.get("choices") or []:
                            ste = choice.get("server_tool_event")
                            if isinstance(ste, dict):
                                st = ste.get("type")
                                call = ste.get("call") or {}
                                if st == "step_reasoning_done":
                                    yield {"type": "step_end", "kind": "reasoning"}
                                elif st == "call_started":
                                    action = call.get("action") or {}
                                    yield {
                                        "type": "tool",
                                        "name": "web_search",
                                        "state": "start",
                                        "queries": action.get("queries") or ([action.get("url")] if action.get("url") else []),
                                        "kind": "search",
                                    }
                                elif st == "call_completed":
                                    yield {"type": "tool", "name": "web_search", "state": "end", "kind": "search"}
                                    for src in _norm_web(call.get("sources") or []):
                                        yield {"type": "source", "item": src}
                            delta = choice.get("delta") or {}
                            reason = delta.get("reasoning_content") or delta.get("reasoning")
                            if reason:
                                yield {"type": "reasoning", "delta": reason}
                            content = delta.get("content")
                            if content:
                                yield {"type": "text", "delta": content}
                            for tc in delta.get("tool_calls") or []:
                                idx = int(tc.get("index") or 0)
                                slot = calls.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                                if tc.get("id"):
                                    slot["id"] = tc["id"]
                                fn = tc.get("function") or {}
                                if fn.get("name"):
                                    slot["name"] += fn["name"]
                                if fn.get("arguments"):
                                    slot["arguments"] += fn["arguments"]
        except httpx.HTTPError as exc:
            yield {"type": "error", "code": "network", "message": str(exc)[:400]}
            return

        if not calls:
            return

        normalized = []
        for idx in sorted(calls):
            c = calls[idx]
            normalized.append(
                {
                    "id": c["id"] or f"call_{idx}",
                    "type": "function",
                    "function": {"name": c["name"], "arguments": c["arguments"] or "{}"},
                }
            )
        msgs.append({"role": "assistant", "content": "", "tool_calls": normalized})
        for call in normalized:
            name = call["function"]["name"]
            try:
                args = json.loads(call["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            yield {"type": "tool", "name": name, "state": "start", "queries": [args.get("query", "")]}
            try:
                result = await executor(name, args)
                payload_str = json.dumps(result, ensure_ascii=False)
            except Exception as exc:  # noqa: BLE001
                payload_str = json.dumps({"error": str(exc)[:200]}, ensure_ascii=False)
            count = len(result) if isinstance(result, list) else 1
            yield {"type": "tool", "name": name, "state": "end", "count": count}
            msgs.append({"role": "tool", "tool_call_id": call["id"], "content": payload_str})


MEMORY_ADD_TOOL = {
    "type": "function",
    "function": {
        "name": "memory_add",
        "description": "记住一件关于用户的事。用户明确说「记住…」，或出现稳定的学习事实/偏好时调用。text 一条不超过 40 字。",
        "parameters": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "一句话，主语用「她」，不要引号"},
                "kind": {"type": "string", "enum": ["fact", "pref"], "description": "fact=学习事实，pref=偏好/画像"},
                "subject": {"type": "string", "description": "学科，可空"},
            },
            "required": ["text"],
        },
    },
}

MEMORY_UPDATE_TOOL = {
    "type": "function",
    "function": {
        "name": "memory_update",
        "description": "修正一条已有记忆（用户说他记错了、或要补充细节时用）。先用 memory_search 找到 id。",
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "text": {"type": "string"},
                "kind": {"type": "string", "enum": ["fact", "pref"]},
                "subject": {"type": "string"},
            },
            "required": ["id"],
        },
    },
}

MEMORY_DELETE_TOOL = {
    "type": "function",
    "function": {
        "name": "memory_delete",
        "description": "删掉一条记忆（归档，可恢复）。用户明确说「忘掉这条」时用。先用 memory_search 找到 id。",
        "parameters": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
    },
}
