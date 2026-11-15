"""导入知识点树（高中九科）。

数据来源（网上公开数据集，非自造）：
    https://github.com/mmlong818/k12-knowledge-points
    《K12 知识点数据集》—— 从国家中小学智慧教育平台的教材正文抽取，
    高中 8,661 个知识点 + 同科关系边（prerequisite / leads-to / related）。
    许可证 PolyForm Noncommercial 1.0.0（个人学习使用允许，禁止商用）。

本脚本做四件事：
1. 下载（或复用缓存）`split/高中/<科目>.json`；
2. 同名知识点去重合并（按 subject + name_norm）；
3. 写 `kp`：教材章节节点（kind=chapter）+ 知识点（kind=point）；
4. 写 `kp_edge`：只保留两端都在库里的边（同学科由触发器再兜一层）。

幂等：以源 id 为主键 upsert，重复跑不会长数据。

用法（在 server/ 下）：
    python -m scripts.import_kp                 # 全部九科
    python -m scripts.import_kp --subjects 化学 物理
    python -m scripts.import_kp --offline       # 只用 data/kp-raw 缓存
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

import httpx
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

SERVER_DIR = Path(__file__).resolve().parent.parent
ROOT = SERVER_DIR.parent
CACHE = ROOT / "data" / "kp-raw"

RAW = "https://raw.githubusercontent.com/mmlong818/k12-knowledge-points/main/split/高中/{subject}.json"

# 数据集里的科目名 → 小满九科的名字
SUBJECT_MAP = {
    "语文": "语文",
    "数学": "数学",
    "英语": "英语",
    "物理": "物理",
    "化学": "化学",
    "生物": "生物",
    "思政": "政治",
    "历史": "历史",
    "地理": "地理",
}

REL_TYPES = {"prerequisite", "leads-to", "related"}

_PUNCT = re.compile(r"[\s\u3000（）()【】\[\]{}，,。.、；;：:“”\"'‘’·\-—_/\\|]+")


def norm(name: str) -> str:
    """匹配用归一：去空白与常见标点，统一小写。"""
    return _PUNCT.sub("", (name or "").strip()).lower()


def parse_jsonish(v, default):
    if isinstance(v, (list, dict)):
        return v
    if not v:
        return default
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return default


def grade_of(kp: dict) -> str:
    """年级：教材写了就用；高中按模块推（必修→高一，选择性必修→高二，选修→高三）。"""
    for g in kp.get("grades") or []:
        g = str(g or "").strip()
        if g in ("高一", "高二", "高三"):
            return g
    vols = [str((t or {}).get("volume") or "") + str((t or {}).get("textbook_title") or "")
            for t in (kp.get("textbooks") or [])]
    blob = " ".join(vols)
    if "选择性必修" in blob:
        return "高二"
    if "必修" in blob:
        return "高一"
    if "选修" in blob:
        return "高三"
    return ""


def module_of(kp: dict) -> str:
    for t in kp.get("textbooks") or []:
        vol = str((t or {}).get("volume") or "").strip()
        if vol:
            return vol[:80]
    return ""


def chapter_of(kp: dict) -> str:
    for t in kp.get("textbooks") or []:
        path = (t or {}).get("chapter_path") or []
        if path:
            return str(path[0])[:200]
    return ""


def chapter_id(subject: str, module: str, chapter: str) -> str:
    raw = f"{subject}|{module}|{chapter}"
    return "ch_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:28]


def load_raw(subject: str, offline: bool) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / f"高中-{subject}.json"
    if not dest.exists() or dest.stat().st_size < 1000:
        if offline:
            raise SystemExit(f"缺缓存：{dest}（去掉 --offline 再跑一次）")
        url = RAW.format(subject=subject)
        print(f"  下载 {url}")
        last = None
        for attempt in range(4):
            try:
                with httpx.stream("GET", url, timeout=180.0, follow_redirects=True) as r:
                    r.raise_for_status()
                    with dest.open("wb") as fh:
                        for chunk in r.iter_bytes(65536):
                            fh.write(chunk)
                break
            except (httpx.HTTPError, OSError) as exc:  # 网络抖动重试
                last = exc
                print(f"    第 {attempt + 1} 次失败：{type(exc).__name__}，重试…")
                time.sleep(1.5 * (attempt + 1))
        else:
            raise SystemExit(f"下载失败：{subject}（{last}）")
    return json.loads(dest.read_text(encoding="utf-8"))


def build(subject_name: str, raw: dict) -> tuple[list[dict], list[dict], dict]:
    """源文件 → (kp rows, edge rows, stats)。"""
    subject = SUBJECT_MAP[subject_name]
    kps = raw.get("knowledge_points") or []
    rels = raw.get("relations") or []

    # ① 同名去重：同一科目的 canonical_name 归一后只留一条，别名合并
    kept: dict[str, dict] = {}
    alias_of: dict[str, str] = {}
    dropped = 0
    for src in kps:
        name = str(src.get("canonical_name") or src.get("title") or "").strip()
        if not name:
            dropped += 1
            continue
        key = norm(name)
        if not key:
            dropped += 1
            continue
        old_id = str(src.get("id") or "")
        if key in kept:
            target = kept[key]
            target["aliases"] = sorted(set(target["aliases"]) | {name})
            for a in parse_jsonish(src.get("aliases"), []):
                if isinstance(a, str) and a.strip():
                    target["aliases"].append(a.strip())
            if old_id:
                alias_of[old_id] = target["id"]
            dropped += 1
            continue

        ann = parse_jsonish(src.get("annotations"), {})
        diff = 0.0
        try:
            diff = float(((ann.get("difficulty") or {}).get("value")) or 0.0)
        except (TypeError, ValueError):
            diff = 0.0
        kp_type = str(((ann.get("knowledgeType") or {}).get("value")) or "")[:20]

        row = {
            "id": old_id or ("kp_" + hashlib.sha1(f"{subject}|{name}".encode()).hexdigest()[:28]),
            "subject": subject,
            "name": name[:200],
            "name_norm": key[:200],
            "kind": "point",
            "parent_id": None,
            "grade": grade_of(src),
            "module": module_of(src),
            "chapter": chapter_of(src),
            "summary_md": str(src.get("summary") or "")[:2000],
            "aliases": sorted({a for a in parse_jsonish(src.get("aliases"), []) if isinstance(a, str) and a.strip()}),
            "difficulty": round(min(1.0, max(0.0, diff)), 3),
            "kp_type": kp_type,
            "source": "k12-kp",
            "source_id": old_id,
            "q_count": 0,
            "sort": len(kept),
        }
        kept[key] = row

    # ② 章节节点：树骨架，parent_id 指向它（前端按 module → chapter → point 展示）
    chapters: dict[str, dict] = {}
    for row in kept.values():
        if not row["chapter"] and not row["module"]:
            continue
        cid = chapter_id(row["subject"], row["module"], row["chapter"])
        if cid not in chapters:
            chapters[cid] = {
                "id": cid,
                "subject": row["subject"],
                "name": (row["chapter"] or row["module"])[:200],
                "name_norm": norm(row["chapter"] or row["module"])[:200],
                "kind": "chapter",
                "parent_id": None,
                "grade": row["grade"],
                "module": row["module"],
                "chapter": row["chapter"],
                "summary_md": "",
                "aliases": [],
                "difficulty": 0.0,
                "kp_type": "",
                "source": "k12-kp",
                "source_id": "",
                "q_count": 0,
                "sort": 0,
            }
        row["parent_id"] = cid

    # ③ 关系边：源 id 可能被去重合并，重映射
    edges = []
    seen = set()
    for rel in rels:
        f = str(rel.get("from_kp_id") or "")
        t = str(rel.get("to_kp_id") or "")
        f = alias_of.get(f, f)
        t = alias_of.get(t, t)
        if not f or not t or f == t:
            continue
        rt = str(rel.get("relation_type") or "prerequisite")
        if rt not in REL_TYPES:
            rt = "related"
        triple = (f, t, rt)
        if triple in seen:
            continue
        seen.add(triple)
        edges.append(
            {
                "id": str(rel.get("id") or ("e_" + hashlib.sha1("|".join(triple).encode()).hexdigest()[:28]))[:40],
                "from_kp_id": f[:40],
                "to_kp_id": t[:40],
                "type": rt[:16],
                "subject": subject,  # 触发器会再核一遍两端学科
                "source": "k12-kp",
            }
        )

    stats = {
        "subject": subject,
        "source_points": len(kps),
        "points": len(kept),
        "chapters": len(chapters),
        "edges": len(edges),
        "merged": dropped,
    }
    return list(chapters.values()) + list(kept.values()), edges, stats


def upsert(db, model, rows: list[dict], conflict_cols: list[str], skip=("created_at",)) -> int:
    if not rows:
        return 0
    stmt = pg_insert(model).values(rows)
    update_cols = {
        c.name: stmt.excluded[c.name]
        for c in model.__table__.columns
        if c.name not in conflict_cols and c.name not in skip
    }
    stmt = stmt.on_conflict_do_update(index_elements=conflict_cols, set_=update_cols)
    db.execute(stmt)
    return len(rows)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subjects", nargs="*", default=list(SUBJECT_MAP))
    ap.add_argument("--offline", action="store_true", help="只用本地缓存")
    args = ap.parse_args()

    from app.db import SessionLocal
    from app.models import Kp, KpEdge

    unknown = [s for s in args.subjects if s not in SUBJECT_MAP]
    if unknown:
        print(f"未知科目：{unknown}（可选：{list(SUBJECT_MAP)}）")
        return 1

    totals = {"points": 0, "chapters": 0, "edges": 0, "merged": 0, "source_points": 0}
    with SessionLocal() as db:
        # 不做删除：id 稳定（源 uuid / 章节 hash），upsert 保住已有的 question_kp 标签。
        all_points: dict[str, dict] = {}
        for s in args.subjects:
            print(f"[{s}] 读取…")
            raw = load_raw(s, args.offline)
            rows, edges, st = build(s, raw)
            points = [r for r in rows if r["kind"] == "point"]
            chapters = [r for r in rows if r["kind"] == "chapter"]
            for r in points:
                all_points[r["id"]] = r
            upsert(db, Kp, chapters, ["id"], skip=("created_at", "q_count"))
            upsert(db, Kp, points, ["id"], skip=("created_at", "q_count"))
            valid_edges = [e for e in edges if e["from_kp_id"] in all_points and e["to_kp_id"] in all_points]
            upsert(db, KpEdge, valid_edges, ["from_kp_id", "to_kp_id", "type"])
            for k in ("points", "chapters", "edges", "merged", "source_points"):
                totals[k] += st[k]
            print(
                f"  源 {st['source_points']} 条 → 知识点 {st['points']}、章节 {st['chapters']}、"
                f"边 {len(valid_edges)}（合并同名 {st['merged']}）"
            )
            db.commit()

        # 自检：树与边的完整性
        def count(model, *where):
            stmt = select(func.count()).select_from(model)
            for w in where:
                stmt = stmt.where(w)
            return int(db.scalar(stmt) or 0)

        n_kp = count(Kp)
        n_ch = count(Kp, Kp.kind == "chapter")
        n_pt = count(Kp, Kp.kind == "point")
        n_edge = count(KpEdge)
        orphan = int(
            db.scalar(
                select(func.count())
                .select_from(KpEdge)
                .where(~KpEdge.from_kp_id.in_(select(Kp.id)) | ~KpEdge.to_kp_id.in_(select(Kp.id)))
            )
            or 0
        )
        cross = int(
            db.scalar(
                text(
                    """
                    SELECT count(*) FROM kp_edge e
                    JOIN kp a ON a.id = e.from_kp_id JOIN kp b ON b.id = e.to_kp_id
                    WHERE a.subject <> b.subject
                    """
                )
            )
            or 0
        )

    print("\n库内合计：")
    print(f"  知识点 {n_pt}｜章节 {n_ch}｜关系边 {n_edge}")
    print(f"  本次导入：知识点 {totals['points']}｜章节 {totals['chapters']}｜边 {totals['edges']}（合并同名 {totals['merged']}）")
    print(f"  悬空边 {orphan}｜跨学科边 {cross}")

    ok = n_pt > 0 and n_ch > 0 and orphan == 0 and cross == 0
    print("结果：" + ("OK" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
