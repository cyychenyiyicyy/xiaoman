"""把已有题目的知识点标签重新对一遍教材树（不重新问模型）。

用途：`services/knowledge.resolve` 改进后，把早期由模型自造的点换回树上的点，
再清掉没有任何题目引用的模型点。

用法（server/ 下）：
    python -m scripts.relink_kp            # 只看会改什么（dry-run）
    python -m scripts.relink_kp --apply    # 落库
"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import func, select, text

from app.db import SessionLocal
from app.models import Kp, Question, QuestionKp
from app.services import knowledge


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真的写库（默认只打印）")
    args = ap.parse_args()

    with SessionLocal() as db:
        rows = list(
            db.scalars(
                select(Question).where(
                    Question.ai_meta.isnot(None),
                    text("question.ai_meta ? 'solve'"),
                )
            ).all()
        )
        print(f"带模型解析记录的题：{len(rows)}")

        before_llm = int(
            db.scalar(
                select(func.count())
                .select_from(QuestionKp)
                .join(Kp, Kp.id == QuestionKp.kp_id)
                .where(Kp.source == "llm")
            )
            or 0
        )
        moved = 0
        for q in rows:
            items = ((q.ai_meta or {}).get("solve") or {}).get("knowledge") or []
            if not items:
                continue
            old = {k["id"]: k["name"] for k in knowledge.question_kps(db, q.id)}
            knowledge.tag_question(db, q, items)
            new = {k["id"]: k["name"] for k in knowledge.question_kps(db, q.id)}
            if set(new) != set(old):
                moved += 1
                print(f"  {q.id[:8]}  {list(old.values())} → {list(new.values())}")
        if args.apply:
            db.flush()
        else:
            db.rollback()

        if args.apply:
            # 清掉没有任何题目引用的模型点
            dead = db.execute(
                text(
                    "delete from kp where source='llm' and id not in (select kp_id from question_kp)"
                )
            ).rowcount
            db.commit()
        else:
            dead = int(
                db.scalar(
                    text(
                        "select count(*) from kp where source='llm' "
                        "and id not in (select kp_id from question_kp)"
                    )
                )
                or 0
            )

        after_llm = int(
            db.scalar(
                select(func.count())
                .select_from(QuestionKp)
                .join(Kp, Kp.id == QuestionKp.kp_id)
                .where(Kp.source == "llm")
            )
            or 0
        )

    print(f"改了 {moved} 道题的标签；模型点引用 {before_llm} → {after_llm}；清掉空模型点 {dead}")
    if not args.apply:
        print("（dry-run，加 --apply 落库）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
