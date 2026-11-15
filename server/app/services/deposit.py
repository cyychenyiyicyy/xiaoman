"""自动沉淀：回答结束后，抽 0–2 条「她不会的题 / 没懂的点」。

参考 Mem0 的做法：回答完成之后再抽取，和已有数据去重，不打断用户；
写进去的东西都落 `deposit` 表，前端可以一键撤销。

触发点：`chat._relay_gateway` 在一条 assistant 消息落库后异步调用 `after_turn`。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import threading
import re
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import Conversation, Deposit, KpEvidence, Message, Question
from ..seed import get_current
from . import knowledge
from .llm import complete_text

log = logging.getLogger(__name__)

DEPOSIT_SYS = """你是一个学习档案整理员。输入是「她问的一句 + 小满的回答」，你要判断这一轮里有没有值得记住的
「她不会的题」或「她没懂的知识点」。只输出 JSON，不要解释。

输入 JSON：
{"subject":"化学","user":"…","assistant":"…","attached":[{"id":"…","stem":"…"}]}

输出 JSON：
{
  "items": [
    {
      "kind": "question",
      "ref_id": "附件的题目 id，没有就空串",
      "stem": "题干（含选项也可以）",
      "options": ["A. …", "B. …"],
      "answer": "答案（你知道就写，不确定就空）",
      "solution": "解析（一句话，不确定就空）",
      "error_type": "概念|计算|审题|步骤|粗心|",
      "kps": ["教材里的知识点名"],
      "difficulty": 1,
      "mastery": "wrong|unsure|ok"
    },
    {"kind": "knowledge", "kp": "知识点名", "note": "她卡在哪（一句话）"}
  ],
  "summary": "一句"
}

硬规则：
- 最多 2 条；闲聊、问候、纯操作、你已经答完且她没表现出困难 → items 为空数组；
- 只有「她问一道题怎么做 / 她说自己错了 / 她说不懂」才抽 question；
- 只有「她问概念、说没听懂、要求换个讲法」才抽 knowledge；
- 题目题干必须完整可用；不确定的字段留空，不要编；
- kps 用教材常见叫法，最多 3 个；mastery 只有 wrong/unsure/ok 三个值。"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_json(raw: str) -> dict:
    t = (raw or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(t[start : end + 1])
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _fp(stem: str) -> str:
    norm = re.sub(r"\s+", "", stem or "")
    norm = re.sub(r"[$\\{}_^]", "", norm)
    return hashlib.sha1(norm[:48].encode()).hexdigest()


def _short(text: str, n: int = 3000) -> str:
    return (text or "").strip()[:n]


async def extract(subject: str, user_text: str, assistant_text: str, attached: list[dict]) -> dict:
    """调一次模型，拿结构化沉淀。没有可用模型就返回空。"""
    with SessionLocal() as db:
        provider, model, _ = get_current(db)
        if provider is None or model is None or provider.kind == "mock":
            return {}
        provider = SimpleNamespace(base_url=provider.base_url, api_key=provider.api_key, kind=provider.kind)
        model = SimpleNamespace(model_key=model.model_key)
    payload = {
        "subject": subject,
        "user": _short(user_text),
        "assistant": _short(assistant_text),
        "attached": [
            {"id": q.get("id", ""), "stem": _short(q.get("stem", ""), 800)}
            for q in (attached or [])[:4]
        ],
    }
    raw = await complete_text(
        provider, model, DEPOSIT_SYS, json.dumps(payload, ensure_ascii=False), max_tokens=1400
    )
    return _parse_json(raw)


def _bar_item(dep: Deposit, names: list[str]) -> dict:
    return {
        "id": dep.id,
        "kind": dep.kind,
        "questions": len(dep.question_ids or []),
        "kps": names[:3],
        "status": dep.status,
        "at": dep.created_at.isoformat() if dep.created_at else "",
    }


def _apply(db: Session, conv: Conversation, msg: Message, subject: str, data: dict) -> Deposit | None:
    items = data.get("items") or []
    if not isinstance(items, list) or not items:
        return None

    now = _now()
    dep = Deposit(
        id=uuid.uuid4().hex,
        conversation_id=conv.id,
        message_id=msg.id,
        kind="question",
        status="active",
        question_ids=[],
        kp_ids=[],
        meta={"items": [], "summary": str(data.get("summary") or "")[:200]},
        created_at=now,
    )
    db.add(dep)

    qids: list[str] = []
    kp_ids: list[str] = []
    kp_names: list[str] = []
    details: list[dict] = []
    kinds: set[str] = set()

    for it in items[:2]:
        if not isinstance(it, dict):
            continue
        kind = str(it.get("kind") or "").strip()
        if kind == "question":
            stem = str(it.get("stem") or "").strip()
            if not stem:
                continue
            mastery = str(it.get("mastery") or "").strip()
            ref_id = str(it.get("ref_id") or "").strip()
            q = db.get(Question, ref_id) if ref_id else None
            if q is None:
                q = db.scalar(select(Question).where(Question.stem_fp == _fp(stem)))
            created = False
            if q is None:
                options = [str(o).strip() for o in (it.get("options") or []) if str(o).strip()]
                q = Question(
                    id=uuid.uuid4().hex,
                    subject=subject or "全部",
                    stem_md=stem[:12000],
                    answer_md=str(it.get("answer") or "").strip()[:4000],
                    solution_md=str(it.get("solution") or "").strip()[:8000],
                    qtype="choice" if options else "short",
                    options=options,
                    grade="",
                    difficulty=max(0, min(5, int(it.get("difficulty") or 0))),
                    status="weak" if mastery == "wrong" else "learning",
                    error_type=str(it.get("error_type") or "").strip()[:16],
                    next_due_at=now + (timedelta(hours=4) if mastery == "wrong" else timedelta(days=1)),
                    asked_count=1,
                    last_asked_at=now,
                    streak=0,
                    source="chat",
                    stem_fp=_fp(stem),
                    solve_status="",
                )
                db.add(q)
                db.flush()
                created = True
            else:
                prev = {'status': q.status, 'error_type': q.error_type, 'next_due_at': q.next_due_at.isoformat() if q.next_due_at else None, 'asked_count': int(q.asked_count or 0)}
                q.asked_count = int(q.asked_count or 0) + 1
                q.last_asked_at = now
                if not (q.answer_md or "").strip() and str(it.get("answer") or "").strip():
                    q.answer_md = str(it.get("answer")).strip()[:4000]
                if not (q.solution_md or "").strip() and str(it.get("solution") or "").strip():
                    q.solution_md = str(it.get("solution")).strip()[:8000]
                if mastery == "wrong":
                    q.status = "weak"
                    q.next_due_at = now + timedelta(hours=4)
                    if not (q.error_type or "").strip() and str(it.get("error_type") or "").strip():
                        q.error_type = str(it.get("error_type")).strip()[:16]

            names = [str(n).strip() for n in (it.get("kps") or []) if str(n).strip()][:3]
            if names and (created or not knowledge.question_kps(db, q.id)):
                knowledge.tag_question(
                    db,
                    q,
                    [
                        {"name": n, "weight": 0.9 if i == 0 else 0.5, "primary": i == 0}
                        for i, n in enumerate(names)
                    ],
                )
            for name in names:
                kp = knowledge.resolve(db, q.subject, name, q.grade or "")
                if kp is not None and kp.id not in kp_ids:
                    kp_ids.append(kp.id)
                    kp_names.append(kp.name)
                    db.add(
                        KpEvidence(
                            id=uuid.uuid4().hex,
                            kp_id=kp.id,
                            kind="deposit",
                            weight=0.9 if mastery == "wrong" else 0.4,
                            source=dep.id,
                            created_at=now,
                        )
                    )
            qids.append(q.id)
            kinds.add("question")
            details.append(
                {"kind": "question", "id": q.id, "title": stem[:48], "created": created,
                 "status": q.status, "error_type": q.error_type,
                 "prev": None if created else prev}
            )
        elif kind == "knowledge":
            name = str(it.get("kp") or it.get("name") or "").strip()
            if not name:
                continue
            kp = knowledge.resolve(db, subject or "全部", name, "")
            if kp is None:
                continue
            if kp.id not in kp_ids:
                kp_ids.append(kp.id)
                kp_names.append(kp.name)
            db.add(
                KpEvidence(
                    id=uuid.uuid4().hex,
                    kp_id=kp.id,
                    kind="asked",
                    weight=0.4,
                    source=dep.id,
                    created_at=now,
                )
            )
            kinds.add("knowledge")
            details.append({"kind": "knowledge", "id": kp.id, "title": kp.name})

    if not details:
        db.rollback()
        return None

    dep.kind = "mixed" if len(kinds) > 1 else (kinds.pop() if kinds else "question")
    dep.question_ids = qids
    dep.kp_ids = kp_ids
    dep.meta = dict(dep.meta or {}, items=details)
    db.flush()

    bars = list(msg.deposits or [])
    bars.append(_bar_item(dep, kp_names))
    msg.deposits = bars[-5:]
    db.commit()
    return dep


async def after_turn(
    conversation_id: str,
    message_id: str,
    user_text: str,
    assistant_text: str,
    attached: list[dict] | None = None,
) -> None:
    """一条 assistant 消息落库后调用（后台任务）。自己开 session，异常不影响对话。"""
    user_text = (user_text or "").strip()
    assistant_text = (assistant_text or "").strip()
    if len(user_text) < 6 or len(assistant_text) < 20:
        return
    # 纯问候/操作类不抽
    if re.fullmatch(r"(你好|在吗|谢谢|好的|嗯+|ok|OK|收到)[。！!？?]*", user_text):
        return

    subject = "全部"
    with SessionLocal() as db:
        msg = db.get(Message, message_id)
        conv = db.get(Conversation, conversation_id)
        if msg is None or conv is None or msg.status != "done":
            return
        subject = (conv.subject or "全部").strip()
    if subject == "全部" and attached:
        subject = str(attached[0].get("subject") or "全部")
    if subject == "全部":
        return  # 没有学科就不落库，避免把点挂到「全部」

    try:
        data = await extract(subject, user_text, assistant_text, attached or [])
    except Exception:  # noqa: BLE001
        return
    items = data.get("items") or []
    # 强信号：她带着一道题说「不会/讲讲」，附件题一定要收（模型漏了也要补）
    if attached and re.search(r"不会|不懂|没懂|做错|错了|怎么做|讲讲|讲解", user_text):
        q0 = attached[0]
        has_q = any(isinstance(it, dict) and it.get("kind") == "question"
                    and it.get("ref_id") == q0.get("id") for it in items)
        if not has_q:
            items.insert(0, {
                "kind": "question", "ref_id": q0.get("id", ""), "stem": q0.get("stem") or q0.get("title", ""),
                "options": [], "answer": "", "solution": "", "error_type": "",
                "kps": [], "mastery": "wrong",
            })
            data = {"items": items, "summary": data.get("summary") or "她带着一道题说不会"}
    if not items:
        return

    with SessionLocal() as db:
        msg = db.get(Message, message_id)
        conv = db.get(Conversation, conversation_id)
        if msg is None or conv is None or msg.status != "done":
            return
        try:
            _apply(db, conv, msg, subject, data)
        except Exception as exc:  # noqa: BLE001
            log.warning("deposit apply failed: %s", repr(exc)[:200])
            db.rollback()


def undo(db: Session, deposit_id: str) -> dict | None:
    """撤销一次沉淀：删掉这次新收的题、删掉证据、更新消息上的提示条。"""
    dep = db.get(Deposit, deposit_id)
    if dep is None or dep.status != "active":
        return None
    dep.status = "undone"
    db.execute(
        KpEvidence.__table__.delete().where(KpEvidence.source == dep.id)
    )
    for it in (dep.meta or {}).get("items", []):
        q = db.get(Question, it.get("id") or "")
        if q is None:
            continue
        if it.get("created"):
            db.delete(q)
        elif it.get("prev"):
            prev = it["prev"]
            q.status = prev.get("status") or "learning"
            q.error_type = prev.get("error_type") or ""
            q.asked_count = int(prev.get("asked_count") or 0)
            nd = prev.get("next_due_at")
            q.next_due_at = datetime.fromisoformat(nd) if nd else None
    msg = db.get(Message, dep.message_id)
    bars = []
    if msg is not None:
        bars = [dict(b) for b in (msg.deposits or [])]
        for b in bars:
            if b.get("id") == dep.id:
                b["status"] = "undone"
        msg.deposits = bars
    db.commit()
    return {"ok": True, "deposits": bars}



def spawn_after_turn(*args) -> None:
    """在独立线程里跑沉淀：不依赖请求的事件循环，流结束也不会被取消。"""

    def _run():
        try:
            asyncio.run(after_turn(*args))
        except Exception:  # noqa: BLE001
            log.exception("deposit task failed")

    threading.Thread(target=_run, name="xm-deposit", daemon=True).start()
