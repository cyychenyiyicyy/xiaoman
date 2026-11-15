"""知识点：树 / 搜索 / 关系。

数据来自 scripts/import_kp.py（K12 知识点数据集的高中九科），这里只读不改。
`kind=chapter` 是教材章节骨架，`kind=point` 才能给题目打标签。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Kp, KpEdge, QuestionKp

router = APIRouter(tags=["kp"])


def _out(kp: Kp) -> dict:
    return {
        "id": kp.id,
        "subject": kp.subject,
        "name": kp.name,
        "kind": kp.kind,
        "parent_id": kp.parent_id,
        "grade": kp.grade or "",
        "module": kp.module or "",
        "chapter": kp.chapter or "",
        "difficulty": round(float(kp.difficulty or 0), 2),
        "q_count": int(kp.q_count or 0),
        "source": kp.source,
    }


@router.get("/kp/tree")
def kp_tree(
    subject: str = "",
    q: str = "",
    kind: str = "",
    limit: int = 500,
    db: Session = Depends(get_db),
):
    """扁平返回（parent_id 建树）。前端按 module → chapter → point 排即可。"""
    where = []
    if subject:
        where.append(Kp.subject == subject)
    if kind:
        where.append(Kp.kind == kind)
    if q:
        kw = f"%{q.strip()}%"
        where.append(or_(Kp.name.ilike(kw), cast(Kp.aliases, String).ilike(kw)))
    stmt = (
        select(Kp)
        .where(*where)
        .order_by(Kp.subject, Kp.module, Kp.chapter, Kp.kind, Kp.sort, Kp.name)
        .limit(max(1, min(limit, 1000)))
    )
    rows = list(db.scalars(stmt).all())
    total = int(db.scalar(select(func.count()).select_from(Kp).where(*where)) or 0)
    return {"items": [_out(k) for k in rows], "total": total}


@router.get("/kp/search")
def kp_search(
    q: str = Query("", min_length=0),
    subject: str = "",
    limit: int = 24,
    db: Session = Depends(get_db),
):
    """编辑器里的知识点搜索：先名称包含，再别名包含。"""
    kw = (q or "").strip()
    stmt = select(Kp).where(Kp.kind == "point")
    if subject:
        stmt = stmt.where(Kp.subject == subject)
    if kw:
        like = f"%{kw}%"
        stmt = stmt.where(or_(Kp.name.ilike(like), cast(Kp.aliases, String).ilike(like)))
    stmt = stmt.order_by(Kp.q_count.desc(), func.length(Kp.name), Kp.name).limit(
        max(1, min(limit, 60))
    )
    return {"items": [_out(k) for k in db.scalars(stmt).all()]}


@router.get("/kp/stats")
def kp_stats(db: Session = Depends(get_db)):
    """每个学科有多少知识点 / 章节 / 已打标签的题。"""
    rows = db.execute(
        select(
            Kp.subject,
            func.count().filter(Kp.kind == "point").label("points"),
            func.count().filter(Kp.kind == "chapter").label("chapters"),
        )
        .group_by(Kp.subject)
        .order_by(Kp.subject)
    ).all()
    tagged = dict(
        db.execute(
            select(Kp.subject, func.count(func.distinct(QuestionKp.question_id)))
            .join(QuestionKp, QuestionKp.kp_id == Kp.id)
            .group_by(Kp.subject)
        ).all()
    )
    return {
        "items": [
            {
                "subject": r.subject,
                "points": int(r.points or 0),
                "chapters": int(r.chapters or 0),
                "tagged_questions": int(tagged.get(r.subject) or 0),
            }
            for r in rows
        ]
    }


def _edge_rows(db: Session, kid: str, direction: str) -> list[dict]:
    if direction == "out":
        stmt = (
            select(KpEdge, Kp)
            .join(Kp, Kp.id == KpEdge.to_kp_id)
            .where(KpEdge.from_kp_id == kid)
        )
    else:
        stmt = (
            select(KpEdge, Kp)
            .join(Kp, Kp.id == KpEdge.from_kp_id)
            .where(KpEdge.to_kp_id == kid)
        )
    return [
        {"id": kp.id, "name": kp.name, "type": e.type, "weight": 1.0}
        for e, kp in db.execute(stmt.order_by(KpEdge.type)).all()
    ]


@router.get("/kp/{kid}")
def kp_detail(kid: str, db: Session = Depends(get_db)):
    kp = db.get(Kp, kid)
    if kp is None:
        raise HTTPException(404, "知识点不存在")
    children = list(db.scalars(select(Kp).where(Kp.parent_id == kid).order_by(Kp.sort, Kp.name)).all())
    q_count = int(
        db.scalar(select(func.count()).select_from(QuestionKp).where(QuestionKp.kp_id == kid)) or 0
    )
    return {
        **_out(kp),
        "summary_md": kp.summary_md or "",
        "aliases": kp.aliases or [],
        "kp_type": kp.kp_type or "",
        "question_count": q_count,
        "children": [_out(c) for c in children],
        "prereq": _edge_rows(db, kid, "in"),
        "next": _edge_rows(db, kid, "out"),
    }


@router.get("/kp/{kid}/neighbors")
def kp_neighbors(kid: str, db: Session = Depends(get_db)):
    """先修 / 后继 / 相关——知识点串联（M3）直接用这张图。"""
    if db.get(Kp, kid) is None:
        raise HTTPException(404, "知识点不存在")
    return {
        "id": kid,
        "prereq": _edge_rows(db, kid, "in"),
        "next": _edge_rows(db, kid, "out"),
        "related": [r for r in _edge_rows(db, kid, "out") if r["type"] == "related"]
        + [r for r in _edge_rows(db, kid, "in") if r["type"] == "related"],
    }
