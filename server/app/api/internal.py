"""内部工具端点：只给 Pi 网关回打（共享 token 保护，不暴露给前端）。

网关里的 Pi customTools 调这里，实现仍是本项目的既有逻辑（记忆 / DeepSeek 搜索）。
"""
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import LLMProvider
from ..seed import get_search_cfg
from ..services import memory as memory_service
from ..services import search as search_service
from sqlalchemy import select

router = APIRouter(tags=["internal"])


def guard(x_internal_token: str = Header(default="")) -> None:
    if settings.internal_token and x_internal_token != settings.internal_token:
        raise HTTPException(401, "bad internal token")


def _web_sources(items: list[dict]) -> list[dict]:
    return [
        {
            "type": "web",
            "title": i.get("title", ""),
            "url": i.get("url", ""),
            "snippet": i.get("snippet", ""),
            "site": i.get("site", ""),
        }
        for i in items
        if i.get("url")
    ]


class SearchIn(BaseModel):
    query: str


class AddIn(BaseModel):
    text: str
    kind: str = "fact"
    subject: str = ""


class UpdateIn(BaseModel):
    id: str
    text: str | None = None
    kind: str | None = None
    subject: str | None = None


class IdIn(BaseModel):
    id: str


@router.post("/internal/tools/memory_search", dependencies=[Depends(guard)])
def tool_memory_search(payload: SearchIn, db: Session = Depends(get_db)):
    rows = memory_service.retrieve(db, payload.query)
    memory_service.touch(db, rows)
    db.commit()
    items = [{"id": r.id, "text": r.text, "kind": r.kind, "subject": r.subject} for r in rows]
    return {"items": items, "sources": [{"type": "memory", **i} for i in items]}


@router.post("/internal/tools/memory_add", dependencies=[Depends(guard)])
def tool_memory_add(payload: AddIn, db: Session = Depends(get_db)):
    row = memory_service.create(db, payload.text, payload.kind, payload.subject)
    item = {"id": row.id, "text": row.text, "kind": row.kind, "subject": row.subject}
    return {"item": item, "sources": [{"type": "memory", **item}]}


@router.post("/internal/tools/memory_update", dependencies=[Depends(guard)])
def tool_memory_update(payload: UpdateIn, db: Session = Depends(get_db)):
    row = memory_service.update(db, payload.id, payload.text, payload.kind, payload.subject)
    return {"ok": bool(row), "id": payload.id}


@router.post("/internal/tools/memory_delete", dependencies=[Depends(guard)])
def tool_memory_delete(payload: IdIn, db: Session = Depends(get_db)):
    ok = memory_service.archive(db, payload.id)
    return {"ok": ok, "id": payload.id}


@router.post("/internal/tools/web_search", dependencies=[Depends(guard)])
async def tool_web_search(payload: SearchIn, db: Session = Depends(get_db)):
    cfg = get_search_cfg(db)
    provider = cfg.get("provider") or "deepseek"
    key = (cfg.get("api_key") or "").strip()
    if provider == "deepseek" and not key:
        row = db.scalars(select(LLMProvider).where(LLMProvider.base_url.contains("deepseek.com"))).first()
        key = row.api_key if row else ""
    items = await search_service.search(provider, key, payload.query, int(cfg.get("max_results") or 5))
    return {"items": items, "sources": _web_sources(items)}

# ── 题库工具（给 Pi 用）────────────────────────────────

import uuid as _uuid  # noqa: E402
import hashlib as _hashlib  # noqa: E402
import re as _re  # noqa: E402


class QSearchIn(BaseModel):
    query: str = ""
    subject: str = ""
    status: str = ""
    limit: int = 8


class QAddIn(BaseModel):
    subject: str = "全部"
    stem: str
    options: list[str] = []
    answer: str = ""
    qtype: str = "short"


class QUpdateIn(BaseModel):
    id: str
    stem: str | None = None
    options: list[str] | None = None
    answer: str | None = None
    subject: str | None = None
    qtype: str | None = None


def _q_fp(stem: str) -> str:
    norm = _re.sub(r"\s+", "", stem or "")
    norm = _re.sub(r"[$\\{}_^]", "", norm)
    return _hashlib.sha1(norm[:48].encode()).hexdigest()


def _q_out(q) -> dict:
    return {
        "id": q.id,
        "subject": q.subject,
        "type": q.qtype,
        "stem": q.stem_md,
        "options": q.options or [],
        "answer": q.answer_md or "",
        "status": q.status or "learning",
        "error_type": q.error_type or "",
        "next_due_at": q.next_due_at.isoformat() if q.next_due_at else None,
        "source_page": q.source_page,
        "created_at": q.created_at.isoformat() if q.created_at else None,
        "image": f"/api/v1/questions/{q.id}/image" if q.stem_preview_png else "",
    }


@router.post("/internal/tools/question_search", dependencies=[Depends(guard)])
def tool_question_search(payload: QSearchIn, db: Session = Depends(get_db)):
    from ..models import Question

    stmt = select(Question).order_by(Question.created_at.desc()).limit(max(1, min(payload.limit, 20)))
    if payload.subject:
        stmt = stmt.where(Question.subject == payload.subject)
    if payload.query:
        stmt = stmt.where(Question.stem_md.ilike(f"%{payload.query}%"))
    if payload.status == "due":
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        stmt = stmt.where(
            Question.status != "mastered",
            Question.next_due_at.isnot(None),
            Question.next_due_at <= now,
        )
    elif payload.status in ("weak", "learning", "mastered"):
        stmt = stmt.where(Question.status == payload.status)
    rows = db.scalars(stmt).all()
    items = [_q_out(q) for q in rows]
    return {"items": items, "count": len(items)}


@router.post("/internal/tools/question_add", dependencies=[Depends(guard)])
def tool_question_add(payload: QAddIn, background: BackgroundTasks, db: Session = Depends(get_db)):
    from ..models import Question
    from ..services import solve as solve_service

    fp = _q_fp(payload.stem)
    existing = db.scalar(select(Question).where(Question.stem_fp == fp))
    if existing is not None:
        filled = False
        if (payload.answer or "").strip() and not (existing.answer_md or "").strip():
            existing.answer_md = payload.answer.strip()
            filled = True
        if payload.options and not (existing.options or []):
            existing.options = payload.options
            filled = True
        # 答案有了但解析没有：后台补解析与知识点（不覆盖已有答案）
        need_solve = not (existing.solution_md or "").strip()
        if need_solve:
            existing.solve_status = "queued"
            existing.solve_error = ""
        db.commit()
        db.refresh(existing)
        if need_solve:
            background.add_task(solve_service.solve_many, [existing.id], False)
        return {
            "item": _q_out(existing),
            "already": True,
            "filled_answer": filled,
            "hint": "题库已有这道题" + ("，答案刚补上" if filled else "") + "；解析会在后台补齐",
        }

    q = Question(
        id=_uuid.uuid4().hex,
        subject=(payload.subject or "全部")[:20],
        stem_md=payload.stem.strip(),
        answer_md=(payload.answer or "").strip(),
        qtype=(payload.qtype or "short")[:16],
        options=payload.options or [],
        source="chat",
        source_page=1,
        stem_fp=fp,
        solve_status="queued",
    )
    db.add(q)
    db.commit()
    db.refresh(q)
    background.add_task(solve_service.solve_many, [q.id], False)
    return {"item": _q_out(q), "already": False}


@router.post("/internal/tools/question_update", dependencies=[Depends(guard)])
def tool_question_update(payload: QUpdateIn, db: Session = Depends(get_db)):
    from ..models import Question

    q = db.get(Question, payload.id)
    if q is None:
        return {"ok": False, "error": "题目不存在"}
    if payload.stem is not None:
        q.stem_md = payload.stem.strip()
        q.stem_fp = _q_fp(q.stem_md)
    if payload.options is not None:
        q.options = payload.options
    if payload.answer is not None:
        q.answer_md = payload.answer.strip()
    if payload.subject is not None:
        q.subject = payload.subject[:20]
    if payload.qtype is not None:
        q.qtype = payload.qtype[:16]
    db.commit()
    db.refresh(q)
    return {"ok": True, "item": _q_out(q)}

class QuizIn(BaseModel):
    conversation_id: str
    message_id: str = ""
    subject: str = "全部"
    stem: str
    options: list[str] = []
    answer: str = ""
    explanation: str = ""
    kps: list[str] = []
    question_id: str = ""


@router.post("/internal/tools/quiz_create", dependencies=[Depends(guard)])
def tool_quiz_create(payload: QuizIn, db: Session = Depends(get_db)):
    """Pi 工具：给用户出一道检测题。卡片会挂到这一轮 assistant 消息上。"""
    from ..models import Conversation
    from ..services import quiz as quiz_service

    conv = db.get(Conversation, payload.conversation_id)
    if conv is None:
        return {"ok": False, "error": "对话不存在"}
    try:
        quiz = quiz_service.create_quiz(
            db,
            conv.id,
            subject=payload.subject or conv.subject,
            stem=payload.stem,
            options=payload.options,
            answer=payload.answer,
            explanation=payload.explanation,
            kp_names=payload.kps,
            question_id=payload.question_id or None,
            message_id=payload.message_id or None,
            source="agent",
        )
        db.commit()
        return {
            "ok": True,
            "quiz_id": quiz.id,
            "hint": "检测卡已经发给她了，等她作答；这轮不要先报答案",
        }
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        return {"ok": False, "error": str(exc)[:200]}


# ── 技能产物（讲解网页 / PDF）──────────────────────────

class ArtifactIn(BaseModel):
    conversation_id: str
    message_id: str = ""
    subject: str = "全部"
    title: str = ""
    markdown: str
    kps: list[str] = []


def _make_artifact(kind: str, payload: ArtifactIn, db: Session) -> dict:
    from ..models import Conversation
    from ..services import artifacts as artifact_service
    from ..services import knowledge

    conv = db.get(Conversation, payload.conversation_id)
    if conv is None:
        return {"ok": False, "error": "对话不存在"}
    if not (payload.markdown or "").strip():
        return {"ok": False, "error": "正文为空"}
    kp_ids = []
    for name in (payload.kps or [])[:4]:
        kp = knowledge.resolve(db, payload.subject or conv.subject or "全部", name, "")
        if kp is not None and kp.id not in kp_ids:
            kp_ids.append(kp.id)
    try:
        art = artifact_service.save_artifact(
            db,
            conversation_id=conv.id,
            message_id=payload.message_id or None,
            kind=kind,
            title=payload.title or "知识点讲解",
            markdown=payload.markdown,
            subject=payload.subject or conv.subject or "",
            kp_ids=kp_ids,
        )
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        return {"ok": False, "error": str(exc)[:240]}
    return {
        "ok": True,
        "artifact": artifact_service.payload(art),
        "hint": "产物已生成，告诉她打开就好；不要粘贴全文",
    }


@router.post("/internal/tools/make_webpage", dependencies=[Depends(guard)])
def tool_make_webpage(payload: ArtifactIn, db: Session = Depends(get_db)):
    return _make_artifact("html", payload, db)


@router.post("/internal/tools/make_pdf", dependencies=[Depends(guard)])
def tool_make_pdf(payload: ArtifactIn, db: Session = Depends(get_db)):
    return _make_artifact("pdf", payload, db)


@router.post("/internal/tools/make_card", dependencies=[Depends(guard)])
def tool_make_card(payload: ArtifactIn, db: Session = Depends(get_db)):
    return _make_artifact("png", payload, db)


class FlashcardsIn(BaseModel):
    conversation_id: str
    message_id: str = ""
    subject: str = "全部"
    title: str = ""
    cards: list[dict] = []
    kps: list[str] = []


@router.post("/internal/tools/make_flashcards", dependencies=[Depends(guard)])
def tool_make_flashcards(payload: FlashcardsIn, db: Session = Depends(get_db)):
    from ..models import Conversation
    from ..services import artifacts as artifact_service
    from ..services import cards

    conv = db.get(Conversation, payload.conversation_id)
    if conv is None:
        return {"ok": False, "error": "对话不存在"}
    if not payload.cards:
        return {"ok": False, "error": "没有卡片"}
    doc = cards.build_flashcards_document(payload.title or "记忆闪卡", payload.cards, payload.subject or "")
    try:
        art = artifact_service.save_artifact(
            db,
            conversation_id=conv.id,
            message_id=payload.message_id or None,
            kind="flashcards",
            title=payload.title or "记忆闪卡",
            subject=payload.subject or conv.subject or "",
            kp_ids=[],
            document=doc,
        )
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        return {"ok": False, "error": str(exc)[:240]}
    return {
        "ok": True,
        "artifact": artifact_service.payload(art),
        "hint": "闪卡已生成，告诉她点开就能翻面",
    }
