"""出题检测：她给用户出一道题，用户答完立即判分并留下掌握度证据。

三个入口共用这张表：
1. Pi 工具 `quiz_create`（对话里「教完再考一道」）；
2. 主动消息「出一道检测」（按薄弱知识点现生成）；
3. 题库里重做（用原题，不重新生成）。

判分先做确定性的选择题/短答；开放题留给下一轮对话讲。
到期时间先用一个「临时阶梯」（错→4 小时，对→3 天，连对两次→7 天），
M2 接 `py-fsrs` 后换掉，接口不变。
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import Conversation, Kp, KpEvidence, Message, Question, Quiz
from ..seed import get_current
from . import knowledge
from .llm import complete_text

QUIZ_SYS = """你是高中老师，给一个知识点出一道**单项选择题**。只输出 JSON，不要解释。

输入：{"subject":"化学","kp":"离子反应发生的条件","grade":"高一","difficulty":0.55}

输出：
{"stem":"题干（可以带 $...$ 公式）","options":["A. …","B. …","C. …","D. …"],"answer":"B","explanation":"一句解析，点关键步骤"}

硬规则：
- 只考这一个知识点，不要串别的；难度对齐输入；
- 四个选项，只有一个正确；答案只写字母；
- 题干完整、能独立作答；不要出现「如图」这种没有图的引用；
- 解析≤80 字。"""


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


def payload(quiz: Quiz) -> dict:
    answered = quiz.status == "answered"
    return {
        "id": quiz.id,
        "conversation_id": quiz.conversation_id,
        "subject": quiz.subject,
        "stem_md": quiz.stem_md,
        "options": quiz.options or [],
        "status": quiz.status,
        "chosen": quiz.chosen or "",
        "correct": quiz.correct,
        "question_id": quiz.question_id or "",
        "kp_ids": quiz.kp_ids or [],
        "kp_names": quiz.kp_names or [],
        "answer": quiz.answer if answered else "",
        "explanation": quiz.explanation if answered else "",
        "source": quiz.source,
    }


def create_quiz(
    db: Session,
    conversation_id: str,
    *,
    subject: str,
    stem: str,
    options: list | None = None,
    answer: str = "",
    explanation: str = "",
    kp_names: list[str] | None = None,
    question_id: str | None = None,
    message_id: str | None = None,
    source: str = "agent",
) -> Quiz:
    stem = (stem or "").strip()
    if not stem:
        raise ValueError("题干不能为空")
    kp_ids: list[str] = []
    names: list[str] = []
    for name in (kp_names or [])[:4]:
        kp = knowledge.resolve(db, subject or "全部", name, "")
        if kp is not None and kp.id not in kp_ids:
            kp_ids.append(kp.id)
            names.append(kp.name)
    if question_id and not kp_ids:
        q = db.get(Question, question_id)
        if q is not None:
            for item in knowledge.question_kps(db, q.id):
                kp_ids.append(item["id"])
                names.append(item["name"])
    quiz = Quiz(
        id=uuid.uuid4().hex,
        conversation_id=conversation_id,
        message_id=message_id,
        question_id=question_id,
        subject=(subject or "全部")[:20],
        stem_md=stem[:12000],
        options=[str(o).strip() for o in (options or []) if str(o).strip()][:6],
        answer=(answer or "").strip()[:4000],
        explanation=(explanation or "").strip()[:4000],
        kp_ids=kp_ids[:4],
        kp_names=names[:4],
        status="pending",
        source=source,
    )
    db.add(quiz)
    db.flush()
    return quiz


def _letter(text: str) -> str:
    m = re.search(r"[A-F]", (text or "").upper())
    return m.group(0) if m else ""


def grade(quiz: Quiz, chosen: str) -> bool:
    chosen = (chosen or "").strip()
    if not chosen:
        return False
    if quiz.options:
        want = _letter(quiz.answer) or quiz.answer.strip()
        got = _letter(chosen) or chosen.strip()
        if _letter(quiz.answer):
            return got.upper()[:1] == want.upper()[:1] if got else False
        return chosen.lower() == want.lower()
    a = re.sub(r"\s+", "", quiz.answer or "").lower()
    b = re.sub(r"\s+", "", chosen).lower()
    return bool(a) and (a == b or (len(b) >= 4 and b in a))


def _bump_question(db: Session, q: Question, correct: bool) -> None:
    now = _now()
    q.asked_count = int(q.asked_count or 0) + 1
    q.last_asked_at = now
    if correct:
        q.streak = int(q.streak or 0) + 1
        q.status = "mastered" if q.streak >= 2 else "learning"
        q.next_due_at = now + timedelta(days=7 if q.streak >= 2 else 3)
    else:
        q.streak = 0
        q.status = "weak"
        q.next_due_at = now + timedelta(hours=4)


def _sync_message_part(db: Session, quiz: Quiz) -> None:
    if not quiz.message_id:
        return
    msg = db.get(Message, quiz.message_id)
    if msg is None:
        return
    parts = [dict(p) for p in (msg.parts or [])]
    for p in parts:
        if p.get("type") == "quiz" and (p.get("quiz") or {}).get("id") == quiz.id:
            p["quiz"] = payload(quiz)
    msg.parts = parts


def answer_quiz(db: Session, quiz_id: str, chosen: str) -> dict | None:
    quiz = db.get(Quiz, quiz_id)
    if quiz is None:
        return None
    if quiz.status != "pending":
        return {"quiz": payload(quiz), "correct": quiz.correct, "answer": quiz.answer,
                "explanation": quiz.explanation, "already": True}

    correct = grade(quiz, chosen)
    quiz.status = "answered"
    quiz.chosen = (chosen or "").strip()[:200]
    quiz.correct = correct
    quiz.answered_at = _now()

    for kp_id in quiz.kp_ids or []:
        db.add(
            KpEvidence(
                id=uuid.uuid4().hex,
                kp_id=kp_id,
                kind="quiz_right" if correct else "quiz_wrong",
                weight=0.6 if correct else 1.0,
                source=quiz.id,
                created_at=_now(),
            )
        )
    if quiz.question_id:
        q = db.get(Question, quiz.question_id)
        if q is not None:
            _bump_question(db, q, correct)
            if not correct and not (q.error_type or "").strip():
                q.error_type = "概念"
    _sync_message_part(db, quiz)
    db.commit()
    db.refresh(quiz)
    return {"quiz": payload(quiz), "correct": correct, "answer": quiz.answer,
            "explanation": quiz.explanation}


def send_quiz_message(db: Session, conv: Conversation, quiz: Quiz, text: str) -> Message:
    """把一道待答的题作为一条消息发进对话（主动检测 / 题库重做走这里）。"""
    text = (text or "来，做一道。").strip()
    msg = Message(
        conversation_id=conv.id,
        role="assistant",
        kind="quiz",
        content_md=text,
        parts=[
            {"type": "text", "text": text},
            {"type": "quiz", "quiz": payload(quiz)},
        ],
        status="done",
    )
    db.add(msg)
    db.flush()
    quiz.message_id = msg.id
    conv.updated_at = _now()
    db.commit()
    db.refresh(msg)
    return msg


def auto_from_question(db: Session, conversation_id: str, question_id: str) -> Message | None:
    q = db.get(Question, question_id)
    if q is None:
        return None
    conv = db.get(Conversation, conversation_id)
    if conv is None:
        return None
    if not (q.answer_md or "").strip():
        raise ValueError("这道题还没有答案，先补解析再重做")
    quiz = create_quiz(
        db,
        conv.id,
        subject=q.subject,
        stem=q.stem_md,
        options=q.options or [],
        answer=q.answer_md,
        explanation=q.solution_md or "",
        question_id=q.id,
        source="question",
    )
    return send_quiz_message(db, conv, quiz, "重做一道：")


def auto_from_kp(db: Session, conversation_id: str, kp_id: str) -> Message | None:
    kp = db.get(Kp, kp_id)
    conv = db.get(Conversation, conversation_id)
    if kp is None or conv is None:
        return None
    with SessionLocal() as s2:
        provider, model, _ = get_current(s2)
        if provider is None or model is None or provider.kind == "mock":
            raise ValueError("没有可用模型，先连一个 provider")
        provider = SimpleNamespace(base_url=provider.base_url, api_key=provider.api_key)
        model = SimpleNamespace(model_key=model.model_key)
    data = _parse_json(
        __import__("asyncio").run(
            complete_text(
                provider,
                model,
                QUIZ_SYS,
                json.dumps(
                    {
                        "subject": kp.subject,
                        "kp": kp.name,
                        "grade": kp.grade or "",
                        "difficulty": round(float(kp.difficulty or 0.5), 2),
                    },
                    ensure_ascii=False,
                ),
                max_tokens=1200,
            )
        )
    )
    if not data.get("stem"):
        raise ValueError("出题失败，再试一次")
    quiz = create_quiz(
        db,
        conv.id,
        subject=kp.subject,
        stem=str(data.get("stem")),
        options=data.get("options") or [],
        answer=str(data.get("answer") or ""),
        explanation=str(data.get("explanation") or ""),
        kp_names=[kp.name],
        source="kp",
    )
    return send_quiz_message(db, conv, quiz, "考考你：" + kp.name)


def auto_due(db: Session, conversation_id: str, subject: str = "") -> Message | None:
    """从到期题里挑一道重做（主动消息 / 题库「待复习」用）。"""
    now = _now()
    stmt = select(Question).where(
        Question.status != "mastered",
        Question.next_due_at.isnot(None),
        Question.next_due_at <= now,
        Question.answer_md != "",
    )
    if subject and subject != "全部":
        stmt = stmt.where(Question.subject == subject)
    q = db.scalar(stmt.order_by(Question.next_due_at).limit(1))
    if q is None:
        return None
    return auto_from_question(db, conversation_id, q.id)


def append_quiz_parts(db: Session, message: Message) -> list[dict]:
    """一轮结束后，把这轮工具建的 quiz 追加进 assistant 的 parts。"""
    parts = [dict(p) for p in (message.parts or [])]
    has = {p.get("quiz", {}).get("id") for p in parts if p.get("type") == "quiz"}
    rows = db.scalars(select(Quiz).where(Quiz.message_id == message.id).order_by(Quiz.created_at)).all()
    for quiz in rows:
        if quiz.id not in has:
            parts.append({"type": "quiz", "quiz": payload(quiz)})
    message.parts = parts
    return parts
