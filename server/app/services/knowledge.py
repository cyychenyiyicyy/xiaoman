"""知识点匹配与题目打标。

题库里的标签只指向 `kp.kind='point'`（章节节点不参与打标）。
匹配顺序：全名 → 别名 → 互相包含（长度相近优先）→ 都没有就新建一个 LLM 知识点。
"""
from __future__ import annotations

import hashlib
import re

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..models import Kp, QuestionKp

_PUNCT = re.compile(r"[\s\u3000（）()【】\[\]{}，,。.、；;：:“”\"'‘’·\-—_/\\|]+")


def norm(name: str) -> str:
    """匹配用归一：去空白与常见标点，统一小写。"""
    return _PUNCT.sub("", (name or "").strip()).lower()


def _grams(text: str) -> set[str]:
    s = norm(text)
    if len(s) <= 1:
        return {s} if s else set()
    return {s[i : i + 2] for i in range(len(s) - 1)}


def candidates(db: Session, subject: str, stem: str, limit: int = 36) -> list[str]:
    """按题干字面重叠，给模型一份同科候选知识点（避免它自造名字）。只用教材树里的点。"""
    if not subject or subject == "全部":
        return []
    rows = db.scalars(
        select(Kp).where(Kp.subject == subject, Kp.kind == "point", Kp.source != "llm")
    ).all()
    pool = _grams(stem or "")
    if not pool:
        return [k.name for k in rows[:limit]]
    scored = []
    for kp in rows:
        kg = _grams(kp.name)
        if not kg:
            continue
        hit = len(kg & pool) / len(kg)
        if hit >= 0.25:
            scored.append((hit, len(kp.name), kp.name))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [name for _, _, name in scored[:limit]]


def resolve(db: Session, subject: str, name: str, grade: str = "") -> Kp | None:
    """把模型给的知识点名字对到树上的一个点。

    优先级：教材树（source≠llm）> 之前由模型补建的点。
    先整名，再按「与 / 、 / 和 / 及」拆开；树上实在没有才新建，避免模型词盖住教材词。
    """
    n = norm(name)
    if not n:
        return None
    rows = None

    def pools() -> tuple[list[Kp], list[Kp]]:
        nonlocal rows
        if rows is None:
            rows = db.scalars(select(Kp).where(Kp.subject == subject, Kp.kind == "point")).all()
        tree = [k for k in rows if k.source != "llm"]
        llm = [k for k in rows if k.source == "llm"]
        return tree, llm

    tries = [n] + [p for p in (norm(x) for x in re.split(r"[、与和及/]", name or "")) if len(p) >= 3]

    def match(pool: list[Kp]) -> Kp | None:
        for cand in tries:
            for kp in pool:
                if kp.name_norm == cand:
                    return kp
        for cand in tries:
            for kp in pool:
                for alias in kp.aliases or []:
                    if isinstance(alias, str) and norm(alias) == cand:
                        return kp
        best: tuple[float, Kp] | None = None
        for cand in tries:
            for kp in pool:
                kn = kp.name_norm or ""
                if not kn:
                    continue
                if cand in kn or kn in cand:
                    score = min(len(cand), len(kn)) / max(len(cand), len(kn))
                    # 前缀命中放宽：「牛顿第二定律」→「牛顿第二定律的表述与物理意义」
                    if (kn.startswith(cand) or cand.startswith(kn)) and min(len(cand), len(kn)) >= 4:
                        score += 0.2
                    if score >= 0.45 and (best is None or score > best[0]):
                        best = (score, kp)
        return best[1] if best else None

    tree, llm = pools()
    hit = match(tree) or match(llm)
    if hit is not None:
        return hit

    # 新建：至少 3 个字、不是纯符号，避免把「略」「其他」这类词灌成知识点
    if len(n) < 3 or n in ("无", "其他", "略", "条件不足"):
        return None
    if subject not in ("语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理"):
        return None  # 「全部」这类虚拟学科不往树里灌点
    kid = "kp_llm_" + hashlib.sha1(f"{subject}|{n}".encode()).hexdigest()[:24]
    row = db.get(Kp, kid)
    if row is not None:
        return row
    row = Kp(
        id=kid,
        subject=subject,
        name=(name or "")[:200],
        name_norm=n[:200],
        kind="point",
        parent_id=None,
        grade=grade if grade in ("高一", "高二", "高三") else "",
        module="",
        chapter="",
        summary_md="",
        aliases=[],
        difficulty=0.0,
        kp_type="",
        source="llm",
        source_id="",
        q_count=0,
        sort=9999,
    )
    db.add(row)
    db.flush()
    return row


def refresh_counts(db: Session, kp_ids) -> None:
    ids = {k for k in kp_ids if k}
    # 会话是 autoflush=False：先把待写入的 question_kp 刷下去，否则数出来永远是 0
    db.flush()
    for kid in ids:
        n = int(
            db.scalar(select(func.count()).select_from(QuestionKp).where(QuestionKp.kp_id == kid)) or 0
        )
        row = db.get(Kp, kid)
        if row is not None:
            row.q_count = n
    db.flush()


def tag_question(db: Session, question, items: list[dict], replace: bool = True) -> list[Kp]:
    """给题目打知识点标签。

    items: [{"name": "离子反应", "weight": 0.9, "primary": true}, …]
    返回最终挂上的知识点行（去重后）。
    """
    if not isinstance(items, list):
        return []
    picked: list[tuple[Kp, float, bool]] = []
    seen: set[str] = set()
    for it in items:
        if not isinstance(it, dict):
            continue
        name = str(it.get("name") or "").strip()
        kp = resolve(db, question.subject, name, question.grade or "")
        if kp is None or kp.id in seen:
            continue
        seen.add(kp.id)
        try:
            weight = float(it.get("weight") or 0.5)
        except (TypeError, ValueError):
            weight = 0.5
        weight = round(min(1.0, max(0.05, weight)), 3)
        primary = bool(it.get("primary"))
        picked.append((kp, weight, primary))

    # 主知识点最多一个：没标就取权重最高的
    if picked and not any(p for _, _, p in picked):
        top = max(range(len(picked)), key=lambda i: picked[i][1])
        kp, w, _ = picked[top]
        picked[top] = (kp, w, True)
    primaries = [i for i, (_, _, p) in enumerate(picked) if p]
    for i in primaries[1:]:
        kp, w, _ = picked[i]
        picked[i] = (kp, w, False)

    old_ids = []
    if replace:
        old_ids = [
            r for r in db.scalars(
                select(QuestionKp.kp_id).where(QuestionKp.question_id == question.id)
            ).all()
        ]
        db.execute(delete(QuestionKp).where(QuestionKp.question_id == question.id))
    for kp, weight, primary in picked:
        db.merge(QuestionKp(question_id=question.id, kp_id=kp.id, weight=weight, is_primary=primary))
    refresh_counts(db, set(old_ids) | {kp.id for kp, _, _ in picked})
    return [kp for kp, _, _ in picked]


def question_kps(db: Session, question_id: str) -> list[dict]:
    return kps_map(db, [question_id]).get(question_id, [])


def kps_map(db: Session, question_ids: list[str]) -> dict[str, list[dict]]:
    """一次查完一批题目的知识点（列表页用，避免 N+1）。"""
    ids = [q for q in question_ids if q]
    out: dict[str, list[dict]] = {q: [] for q in ids}
    if not ids:
        return out
    rows = db.execute(
        select(QuestionKp, Kp)
        .join(Kp, Kp.id == QuestionKp.kp_id)
        .where(QuestionKp.question_id.in_(ids))
        .order_by(QuestionKp.is_primary.desc(), QuestionKp.weight.desc())
    ).all()
    for qk, kp in rows:
        out.setdefault(qk.question_id, []).append(
            {
                "id": kp.id,
                "name": kp.name,
                "subject": kp.subject,
                "weight": round(float(qk.weight), 2),
                "primary": bool(qk.is_primary),
            }
        )
    return out


def set_question_kps(db: Session, question, kp_ids: list[str]) -> list[dict]:
    """按前端选的知识点 id 整组替换（第一个当主考点）。"""
    clean: list[str] = []
    for kid in kp_ids or []:
        kid = str(kid or "").strip()
        if kid and kid not in clean and db.get(Kp, kid) is not None:
            clean.append(kid)
    old = [
        r
        for r in db.scalars(select(QuestionKp.kp_id).where(QuestionKp.question_id == question.id)).all()
    ]
    db.execute(delete(QuestionKp).where(QuestionKp.question_id == question.id))
    for i, kid in enumerate(clean):
        db.merge(
            QuestionKp(
                question_id=question.id,
                kp_id=kid,
                weight=0.9 if i == 0 else 0.6,
                is_primary=i == 0,
            )
        )
    refresh_counts(db, set(old) | set(clean))
    return question_kps(db, question.id)
