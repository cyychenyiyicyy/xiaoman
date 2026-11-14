"""长期记忆：检索（回合前注入）+ 抽取（回合后写入）。

设计依据 docs/22 §2：
- 存 PG 的 memory 表，不上向量库（单用户、几百条，2-gram 交集足够）
- 写入走「回合后抽取」，不给模型开 memory_save 工具（DeepSeek 原生搜索一轮不能再声明别的工具）
- 读取把命中的 id 记到该条回复上，让「根据记忆生成」是可核查的事实
"""
from __future__ import annotations

import json
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import LLMModel, LLMProvider, Memory
from .llm import complete_text

MAX_PER_TURN = 2
MAX_INJECT = 8
DEDUPE_JACCARD = 0.7

_SPACE = re.compile(r"\s+")


_SELF = str.maketrans({"我": "她"})


def _norm(text: str) -> str:
    """记忆里的主语是「她」，用户的问法是「我」，归一后才能对上。"""
    return (text or "").translate(_SELF)


def bigrams(text: str) -> set[str]:
    t = _SPACE.sub("", _norm(text))
    if not t:
        return set()
    if len(t) < 2:
        return {t}
    return {t[i : i + 2] for i in range(len(t) - 1)}


def jaccard(a: str, b: str) -> float:
    A, B = bigrams(a), bigrams(b)
    if not A or not B:
        return 0.0
    return len(A & B) / len(A | B)


def retrieve(db: Session, user_text: str, limit: int = MAX_INJECT) -> list[Memory]:
    """与本轮文本有 2-gram 交集的优先，再用最近 2 条补位。"""
    rows = list(
        db.scalars(
            select(Memory).where(Memory.status == "active").order_by(Memory.created_at.desc()).limit(400)
        ).all()
    )
    if not rows:
        return []
    q = bigrams(user_text)
    scored: list[tuple[float, Memory]] = []
    for r in rows:
        hit = len(q & bigrams(r.text))
        scored.append((hit, r))
    # 只认真正相关的：至少 2 个 2-gram 命中。无关时一条都不注入（否则每条回复都自称「根据记忆」）
    # 打分：交集 / 较短一侧的 bigram 数；放宽到 1 个交集也算（短问句本来就没几个 bigram）
    qn = bigrams(user_text)
    ranked = []
    for r in rows:
        rn = bigrams(r.text)
        if not qn or not rn:
            continue
        inter = len(qn & rn)
        if inter <= 0:
            continue
        score = inter / min(len(qn), len(rn))
        if score < 0.1:
            continue
        ranked.append((score, r))
    matched = [r for _, r in sorted(ranked, key=lambda x: -x[0])]

    # 工具是按需调用：模型明确来查时，就算词面对不上，也给最近几条兜底（空手而归更差）
    if not matched:
        matched = rows[:5]
    out: list[Memory] = []
    seen: set[str] = set()
    for r in matched:
        if r.id in seen:
            continue
        seen.add(r.id)
        out.append(r)
        if len(out) >= limit:
            break
    return out


def prompt_block(memories: list[Memory]) -> str:
    if not memories:
        return ""
    lines = "\n".join(f"- {m.text}" for m in memories)
    return (
        "\n\n【你记得的关于用户的事｜长期记忆，来自之前的对话】\n"
        f"{lines}\n"
        "（这些是你已经知道的事实，可以直接当作已知来回答；不要说\"我不知道\"，也不要再问她。）\n"
    )


def touch(db: Session, memories: list[Memory]) -> None:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    for m in memories:
        m.use_count = (m.use_count or 0) + 1
        m.last_used_at = now


def sources_payload(memories: list[Memory]) -> list[dict]:
    return [
        {"type": "memory", "id": m.id, "text": m.text, "kind": m.kind, "subject": m.subject}
        for m in memories
    ]


def _clean(text: str) -> str:
    t = _SPACE.sub(" ", (text or "").strip())
    return t[:60]


_EXTRACT_SYS = """你判断这段对话里有没有「值得十年后还记住」的事，并抽取出来。

最高优先级：用户明确要求记住的（「记住…」「记一下…」「别忘了…」「你记着…」）
→ 必须抽出来，一条不漏，kind 用 pref，subject 留空。

值得记（rare）：
- 稳定的学习事实：明确的薄弱点、错因模式、已经掌握到什么程度。
- 稳定的偏好：表达/学习方式偏好、每天可用时间、目标院校或考试时间。

绝不记（常见错误，必须避免）：
- 闲聊、情绪、一次性的问题或答案。
- 模型自己说的话、题目内容、知识点本身。
- 从「今天新闻」这类提问里推断出的任何「事实」。
- 空泛到没有信息量的句子。

要求：一条 ≤ 40 字，主语用「她」，不要引号，不要编。**大多数对话应该返回空数组**。
只输出 JSON：{"memory":[{"text":"…","kind":"fact"或"pref","subject":"学科或空串"}]}"""


async def extract(
    provider: LLMProvider,
    model: LLMModel,
    user_text: str,
    answer: str,
    existing: list[Memory] | None = None,
) -> list[dict]:
    """回合后抽取。任何异常都返回空列表——宁可漏，不可脏。"""
    if not (user_text or "").strip() or not (answer or "").strip():
        return []
    # 前置过滤：太短、纯提问、纯寒暄的消息不抽
    u = (user_text or "").strip()
    explicit = any(k in u for k in ("记住", "记一下", "别忘了", "记着", "记住我"))
    if len(u) < 10 and not explicit:
        return []
    if len(answer or "") < 30:
        return []
    if not explicit and not any(
        k in u for k in ("我", "我的", "怕", "总是", "不会", "习惯", "喜欢", "每天", "目标")
    ):
        return []
    user = f"用户说：{user_text[:800]}\n\n小满回答：{answer[:2000]}"
    try:
        raw = await complete_text(provider, model, _EXTRACT_SYS, user, max_tokens=400)
    except Exception:  # noqa: BLE001
        return []
    data = _parse_json(raw)
    items = data.get("memory") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []

    pool = existing or []
    out: list[dict] = []
    for it in items[:4]:
        if not isinstance(it, dict):
            continue
        text = _clean(it.get("text") or "")
        if len(text) < 4:
            continue
        if any(bad in text for bad in ("无法", "不确定", "小满自己")):
            continue
        if any(jaccard(text, m.text) > DEDUPE_JACCARD for m in pool):
            continue
        if any(jaccard(text, o["text"]) > DEDUPE_JACCARD for o in out):
            continue
        kind = "pref" if it.get("kind") == "pref" else "fact"
        subject = str(it.get("subject") or "")[:20]
        out.append({"text": text, "kind": kind, "subject": subject})
        if len(out) >= MAX_PER_TURN:
            break
    return out


def _parse_json(raw: str) -> dict:
    t = (raw or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        return 
    try:
        return json.loads(t[start : end + 1])
    except json.JSONDecodeError:
        return 


def save(db: Session, items: list[dict], source_message_id: str | None) -> list[dict]:
    """写入并返回给前端展示的载荷。"""
    saved = []
    for it in items:
        row = Memory(
            text=it["text"],
            kind=it.get("kind", "fact"),
            subject=it.get("subject", ""),
            source_message_id=source_message_id,
        )
        db.add(row)
        saved.append(row)
    db.commit()
    for row in saved:
        db.refresh(row)
    return [{"id": r.id, "text": r.text, "kind": r.kind, "subject": r.subject} for r in saved]