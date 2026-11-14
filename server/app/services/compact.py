"""上下文压缩：递归摘要 + 保留最近（对齐 Claude Code / MemGPT / Open WebUI 的做法）。

- 完整 transcript 永远留在 message 表（不做物理删除）；
- 超过 token 预算时，把最旧的一段压缩成「此前对话摘要」，只保留最近一部分原文；
- 摘要存 conversation.summary_md，边界存 summary_until；
- 摘要只在压缩发生时变化 → 缓存前缀平时稳定。
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Conversation, Message
from .llm import complete_text

KEEP_RATIO = 0.35  # 保留最近 35%（Open WebUI 把保留比例夹在 10–50%）
MIN_MESSAGES_TO_KEEP = 6

SUMMARY_SYS = """你在为一个长期对话做「压缩」。把旧内容写成一段可继续工作的摘要。

必须保留：
1) 已经聊过的主题与结论（按学科/知识点分组）；
2) 她明确说过的稳定事实、偏好、目标、薄弱点；
3) 未完成、待跟进的事。

必须丢掉：寒暄、重复、模型自己的思考过程、完整题面。
输出中文条目，第三人称「她」，≤ 500 字。若已有旧摘要，把它和新内容合并成一份，不要写「之前提到」这类相对时间。"""


def est_tokens(text: str) -> int:
    t = text or ""
    if not t:
        return 0
    cjk = sum(1 for ch in t if "\u4e00" <= ch <= "\u9fff")
    return int(cjk * 0.68 + (len(t) - cjk) / 4) + 4


def _rows(db: Session, conv: Conversation, after: int | None = None) -> list[Message]:
    stmt = (
        select(Message)
        .where(
            Message.conversation_id == conv.id,
            Message.status == "done",
            Message.role.in_(("user", "assistant")),
        )
        .order_by(Message.seq.asc())
    )
    if after is not None:
        stmt = stmt.where(Message.seq > after)
    return list(db.scalars(stmt).all())


def history(db: Session, conv: Conversation) -> tuple[str, list[Message]]:
    """返回（此前摘要, 未被压缩的消息）。"""
    summary = (conv.summary_md or "").strip()
    rows = _rows(db, conv, conv.summary_until_seq)
    return summary, rows


async def maybe_compact(
    db: Session, conv: Conversation, provider, model
) -> dict | None:
    """超预算就压缩最旧的一段。失败不抛错（压缩失败不影响正常对话）。"""
    budget = int(getattr(settings, "history_token_budget", 110000))
    _, rows = history(db, conv)
    total = sum(est_tokens(m.content_md) for m in rows)
    if total <= budget or len(rows) <= MIN_MESSAGES_TO_KEEP:
        return None

    target = max(1, total - int(budget * KEEP_RATIO))
    chunk: list[Message] = []
    acc = 0
    for m in rows:
        chunk.append(m)
        acc += est_tokens(m.content_md)
        if acc >= target:
            break
    if len(rows) - len(chunk) < MIN_MESSAGES_TO_KEEP:
        chunk = chunk[: max(0, len(rows) - MIN_MESSAGES_TO_KEEP)]
    if not chunk:
        return None

    old = (conv.summary_md or "").strip()
    body = "\n".join(f"{'她' if m.role == 'user' else '小满'}：{(m.content_md or '')[:800]}" for m in chunk)
    user = (f"【旧摘要】\n{old}\n\n【新增对话】\n{body}" if old else f"【对话】\n{body}")

    try:
        summary = (await complete_text(provider, model, SUMMARY_SYS, user, max_tokens=900)).strip()
    except Exception:  # noqa: BLE001
        return None
    if not summary:
        return None

    conv.summary_md = summary[:4000]
    conv.summary_until = chunk[-1].created_at
    conv.summary_until_seq = int(chunk[-1].seq)
    conv.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {
        "summarized": len(chunk),
        "kept": len(rows) - len(chunk),
        "summary_len": len(conv.summary_md),
    }