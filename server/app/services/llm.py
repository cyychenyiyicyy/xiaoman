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


def build_openai_messages(
    history: list[Message],
    user_text: str,
    attachments: list[Attachment],
) -> list[dict]:
    """把历史 + 本轮拼成 OpenAI messages。历史只取文本，图片仅本轮带。"""
    msgs: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
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

    if attachments:
        parts = [{"type": "text", "text": user_text or "看看这个。"}]
        for att in attachments:
            parts.append({"type": "image_url", "image_url": {"url": _data_url(att)}})
        msgs.append({"role": "user", "content": parts})
    else:
        msgs.append({"role": "user", "content": user_text})
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
        "messages": build_openai_messages(history, user_text, attachments),
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if model.supports_thinking and thinking in THINKING_MAP:
        payload["reasoning_effort"] = THINKING_MAP[thinking]
    if model.context_len:
        payload["max_tokens"] = min(settings.default_max_tokens, max(512, model.context_len // 8))

    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0)) as client:
            # 有些 provider 不认 reasoning_effort，会直接 400。降级重试一次（去掉该参数）。
            payloads = [payload]
            if "reasoning_effort" in payload:
                payloads.append({k: v for k, v in payload.items() if k != "reasoning_effort"})
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
                        yield {
                            "type": "usage",
                            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                            "completion_tokens": int(usage.get("completion_tokens") or 0),
                        }
                    for choice in chunk.get("choices") or []:
                        delta = choice.get("delta") or {}
                        reason = delta.get("reasoning_content") or delta.get("reasoning")
                        if reason:
                            yield {"type": "reasoning", "delta": reason}
                        content = delta.get("content")
                        if content:
                            yield {"type": "text", "delta": content}
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
