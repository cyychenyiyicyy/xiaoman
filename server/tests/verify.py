"""小满 MVP · 自动验收。

用法：
    python -m tests.verify                    # 跑全部（未实现的项记 SKIP）
    python -m tests.verify --only schema,api
    python -m tests.verify --selftest         # 注入一个假失败，必须 exit 1
    python -m tests.verify --destructive      # 额外跑迁移 down/up 三跑（会重建 verify 库）

纪律（docs/05 §4.3 / AGENTS.md §4）：
1. 开跑前先删旧报告 —— 否则崩在半路会留着上一次的结论；
2. 结尾 sys.exit(1 if failures else 0)；
3. --selftest 必须能让它变红，否则这脚本就是摆设。
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent.parent
REPORT = SERVER_DIR / "reports" / "verify.json"

EXPECTED_TABLES = {
    "alembic_version",
    "llm_provider",
    "llm_model",
    "conversation",
    "message",
    "attachment",
    "app_setting",
    "kp",
    "kp_edge",
    "question_kp",
}

EXPECTED_COLUMNS = {
    "llm_provider": {"id", "name", "base_url", "api_style", "api_key", "api_key_tail", "connected", "kind", "sort"},
    "llm_model": {"id", "provider_id", "model_key", "display_name", "context_len", "supports_images", "supports_thinking", "enabled"},
    "message": {"id", "conversation_id", "role", "kind", "content_md", "reasoning_md", "images", "status", "created_at"},
    "question": {"id", "subject", "stem_md", "answer_md", "solution_md", "grade", "difficulty", "solve_status", "solve_error", "solved_at", "ai_meta"},
    "kp": {"id", "subject", "name", "name_norm", "kind", "parent_id", "grade", "q_count"},
    "kp_edge": {"id", "from_kp_id", "to_kp_id", "type", "subject"},
    "question_kp": {"question_id", "kp_id", "weight", "is_primary"},
}


@dataclass
class Result:
    name: str
    status: str  # PASS | FAIL | SKIP
    detail: str = ""
    ms: int = 0


@dataclass
class Run:
    results: list[Result] = field(default_factory=list)

    def add(self, name: str, status: str, detail: str = "", ms: int = 0) -> None:
        self.results.append(Result(name, status, detail, ms))

    @property
    def failures(self) -> list[Result]:
        return [r for r in self.results if r.status == "FAIL"]

    @property
    def skips(self) -> list[Result]:
        return [r for r in self.results if r.status == "SKIP"]


def check_schema(run: Run) -> None:
    from sqlalchemy import inspect

    from app.db import engine

    started = time.perf_counter()
    tables = set(inspect(engine).get_table_names())
    missing = EXPECTED_TABLES - tables
    run.add(
        "schema.tables",
        "FAIL" if missing else "PASS",
        f"缺表: {sorted(missing)}" if missing else f"{len(tables)} 张表齐",
        int((time.perf_counter() - started) * 1000),
    )

    for table, required in EXPECTED_COLUMNS.items():
        if table not in tables:
            run.add(f"schema.{table}.columns", "FAIL", "表不存在")
            continue
        cols = {c["name"] for c in inspect(engine).get_columns(table)}
        lack = required - cols
        run.add(
            f"schema.{table}.columns",
            "FAIL" if lack else "PASS",
            f"缺列: {sorted(lack)}" if lack else f"{len(cols)} 列",
        )


def check_migration(run: Run, destructive: bool) -> None:
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    from sqlalchemy import text

    from app.db import engine

    cfg = Config(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    head = ScriptDirectory.from_config(cfg).get_current_head()

    with engine.connect() as conn:
        current = conn.execute(text("select version_num from alembic_version")).scalar()
    run.add(
        "migration.head",
        "PASS" if current == head else "FAIL",
        f"current={current} head={head}",
    )

    if not destructive:
        run.add("migration.roundtrip", "SKIP", "加 --destructive 才跑 down/up 三跑")
        return

    # 用独立库跑，不碰开发库
    admin = engine.url.set(database="postgres")
    verify_db = "xiaoman_verify"
    from sqlalchemy import create_engine

    admin_engine = create_engine(admin, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {verify_db}"))
        conn.execute(text(f"CREATE DATABASE {verify_db}"))
    admin_engine.dispose()

    env_db = create_engine(engine.url.set(database=verify_db))
    started = time.perf_counter()
    ok, detail = True, ""
    for step in ("upgrade head", "downgrade base", "upgrade head"):
        proc = subprocess.run(
            [sys.executable, "-m", "alembic"] + step.split(),
            cwd=SERVER_DIR,
            capture_output=True,
            text=True,
            env={**__import__("os").environ, "DATABASE_URL": str(env_db.url)},
        )
        if proc.returncode != 0:
            ok = False
            detail = f"{step} 失败: {(proc.stderr or proc.stdout)[-400:]}"
            break
    env_db.dispose()
    run.add(
        "migration.roundtrip",
        "PASS" if ok else "FAIL",
        detail or "upgrade→downgrade→upgrade 三次通过",
        int((time.perf_counter() - started) * 1000),
    )


def check_api(run: Run) -> None:
    from fastapi.testclient import TestClient

    from app.main import app

    started = time.perf_counter()
    try:
        with TestClient(app) as client:
            health = client.get("/health")
            run.add(
                "api.health",
                "PASS" if health.status_code == 200 and health.json().get("db") == "ok" else "FAIL",
                health.text[:200],
            )

            providers = client.get("/api/v1/providers").json()
            has_mock = any(p.get("kind") == "mock" for p in providers)
            run.add("api.providers", "PASS" if has_mock else "FAIL", f"{len(providers)} 个 provider")

            setting = client.get("/api/v1/settings").json()
            run.add(
                "api.settings",
                "PASS" if setting.get("model_id") else "FAIL",
                json.dumps(setting, ensure_ascii=False),
            )

            events: list[str] = []
            with client.stream(
                "POST", "/api/v1/chat", json={"text": "验收自检", "image_ids": []}
            ) as resp:
                for line in resp.iter_lines():
                    if line.startswith("data:"):
                        payload = json.loads(line[5:].strip())
                        events.append(payload.get("type", "?"))
                        if payload.get("type") in ("done", "error"):
                            break
            ok = "meta" in events and "text" in events and "done" in events
            run.add("api.chat_sse", "PASS" if ok else "FAIL", "事件序列: " + "→".join(events[:8]))

            msgs = client.get("/api/v1/messages").json()
            run.add(
                "api.persist",
                "PASS" if len(msgs.get("items", [])) >= 2 else "FAIL",
                f"{len(msgs.get('items', []))} 条消息",
            )

            tree = client.get("/api/v1/kp/tree?limit=3").json()
            run.add(
                "api.kp_tree",
                "PASS" if isinstance(tree.get("items"), list) else "FAIL",
                f"{len(tree.get('items') or [])} 条 / total {tree.get('total')}",
            )
            search = client.get("/api/v1/kp/search?q=%E5%8A%9B").json()
            run.add(
                "api.kp_search",
                "PASS" if isinstance(search.get("items"), list) else "FAIL",
                f"{len(search.get('items') or [])} 条",
            )
            graph = client.get("/api/v1/kp/graph?subject=%E5%8C%96%E5%AD%A6").json()
            ok_graph = (
                isinstance(graph.get("nodes"), list)
                and isinstance(graph.get("edges"), list)
                and isinstance(graph.get("modules"), list)
            )
            run.add(
                "api.kp_graph",
                "PASS" if ok_graph else "FAIL",
                f"{len(graph.get('nodes') or [])} 点 / {len(graph.get('edges') or [])} 边 / "
                f"{len(graph.get('modules') or [])} 模块",
            )
            qs = client.get("/api/v1/questions?difficulty=3&limit=3").json()
            run.add(
                "api.questions_filter",
                "PASS" if isinstance(qs.get("items"), list) else "FAIL",
                f"{len(qs.get('items') or [])} 条",
            )
    except Exception as exc:  # noqa: BLE001
        run.add("api", "FAIL", f"{type(exc).__name__}: {exc}"[:400])
    run.results[-1].ms = run.results[-1].ms or int((time.perf_counter() - started) * 1000)


def check_catalog(run: Run) -> None:
    """models.dev 目录：内置平台清单 / 元数据命中 / 未收录必须 404。"""
    from app.services import catalog

    started = time.perf_counter()
    try:
        src = catalog.sources({})
        run.add(
            "catalog.presets",
            "PASS" if len(src) >= 10 and all(s.get("base_url") for s in src) else "FAIL",
            f"{len(src)} 个内置平台",
        )
        meta = catalog.lookup("deepseek", "deepseek-v4-flash")
        ok = bool(meta) and meta["context"] > 0 and meta["tools"] and meta["images"]
        run.add(
            "catalog.lookup",
            "PASS" if ok else "FAIL",
            json.dumps(meta, ensure_ascii=False)[:160] if meta else "查不到",
        )
        miss = catalog.lookup("deepseek", "__verify_not_exist__")
        run.add(
            "catalog.miss",
            "PASS" if miss is None else "FAIL",
            "未收录应返回 None",
        )
    except Exception as exc:  # noqa: BLE001
        run.add("catalog", "FAIL", f"{type(exc).__name__}: {exc}"[:300])
    run.results[-1].ms = int((time.perf_counter() - started) * 1000)


def check_memory(run: Run) -> None:
    """记忆：2-gram 检索命中 + 相似度去重（用回滚事务，不污染库）。"""
    from app.db import SessionLocal
    from app.models import Memory
    from app.services import memory as mem

    started = time.perf_counter()
    db = SessionLocal()
    try:
        db.add_all(
            [
                Memory(text="她物理最怕电磁感应", kind="fact", subject="物理"),
                Memory(text="她喜欢先看提示再要完整答案", kind="pref"),
                Memory(text="她每天七点半开始学习", kind="fact"),
            ]
        )
        db.flush()
        hits = mem.retrieve(db, "电磁感应这块我总是搞不清", limit=3)
        run.add(
            "memory.retrieve",
            "PASS" if hits and "电磁感应" in hits[0].text else "FAIL",
            hits[0].text if hits else "无命中",
        )
        dup = mem.jaccard("她物理最怕电磁感应", "她物理最怕电磁感应")
        diff = mem.jaccard("她物理最怕电磁感应", "她喜欢先看提示")
        run.add(
            "memory.dedupe",
            "PASS" if dup > 0.7 and diff < 0.7 else "FAIL",
            f"同句={dup:.2f} 异句={diff:.2f}",
        )
    except Exception as exc:  # noqa: BLE001
        run.add("memory", "FAIL", f"{type(exc).__name__}: {exc}"[:300])
    finally:
        db.rollback()
        db.close()
    run.results[-1].ms = int((time.perf_counter() - started) * 1000)


def check_knowledge(run: Run) -> None:
    """知识点：导入齐 / 只同学科 / 模型名能落到树上 / 题库已打标签。"""
    from sqlalchemy import func, select, text

    from app.db import SessionLocal
    from app.models import Kp, KpEdge, QuestionKp
    from app.services import knowledge

    started = time.perf_counter()
    db = SessionLocal()
    try:
        points = int(db.scalar(select(func.count()).select_from(Kp).where(Kp.kind == "point")) or 0)
        if points == 0:
            run.add("kp.imported", "SKIP", "还没导入：cd server && python -m scripts.import_kp")
        else:
            subjects = int(
                db.scalar(select(func.count(func.distinct(Kp.subject))).where(Kp.kind == "point")) or 0
            )
            run.add("kp.imported", "PASS" if subjects >= 9 else "FAIL", f"{points} 个知识点 / {subjects} 个学科")

        edges = int(db.scalar(select(func.count()).select_from(KpEdge)) or 0)
        run.add("kp.edges", "PASS" if edges > 0 else "SKIP", f"{edges} 条关系边")

        cross = int(
            db.scalar(
                text(
                    "select count(*) from kp_edge e "
                    "join kp a on a.id=e.from_kp_id join kp b on b.id=e.to_kp_id "
                    "where a.subject<>b.subject"
                )
            )
            or 0
        )
        run.add("kp.same_subject", "PASS" if cross == 0 else "FAIL", f"跨学科边 {cross}")

        # 触发器要真的拦得住：硬插一条跨学科边
        blocked = False
        try:
            a = db.scalar(select(Kp).where(Kp.subject == "数学", Kp.kind == "point").limit(1))
            b = db.scalar(select(Kp).where(Kp.subject == "物理", Kp.kind == "point").limit(1))
            if a is not None and b is not None:
                db.execute(
                    text(
                        "insert into kp_edge (id, from_kp_id, to_kp_id, type, subject, source, created_at) "
                        "values ('verify_bad', :a, :b, 'prerequisite', '数学', 'verify', now())"
                    ),
                    {"a": a.id, "b": b.id},
                )
        except Exception:  # noqa: BLE001  期望就是被触发器拒绝
            blocked = True
        finally:
            db.rollback()
        run.add(
            "kp.cross_blocked",
            "PASS" if (blocked or points == 0) else "FAIL",
            "触发器拦住了跨学科边" if blocked else ("跳过" if points == 0 else "没拦住"),
        )

        if points:
            hit = knowledge.resolve(db, "物理", "牛顿第二定律", "")
            ok = hit is not None and hit.subject == "物理" and hit.source != "llm"
            run.add("kp.resolve", "PASS" if ok else "FAIL", hit.name if hit else "没匹配到")
        else:
            run.add("kp.resolve", "SKIP", "没有知识点数据")

        tagged = int(db.scalar(select(func.count()).select_from(QuestionKp)) or 0)
        run.add("kp.tagging", "PASS" if tagged > 0 else "SKIP", f"{tagged} 条题目↔知识点")
    except Exception as exc:  # noqa: BLE001
        run.add("kp", "FAIL", f"{type(exc).__name__}: {exc}"[:300])
    finally:
        db.close()
    run.results[-1].ms = int((time.perf_counter() - started) * 1000)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="schema,migration,api,catalog,memory,kp")
    parser.add_argument("--selftest", action="store_true", help="注入一个假失败，验证脚本会 exit 1")
    parser.add_argument("--destructive", action="store_true")
    args = parser.parse_args()

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    if REPORT.exists():
        REPORT.unlink()  # 纪律 1：先删旧报告

    selected = {s.strip() for s in args.only.split(",") if s.strip()}
    run = Run()

    sys.path.insert(0, str(SERVER_DIR))
    if "schema" in selected:
        check_schema(run)
    if "migration" in selected:
        check_migration(run, args.destructive)
    if "api" in selected:
        check_api(run)
    if "catalog" in selected:
        check_catalog(run)
    if "memory" in selected:
        check_memory(run)
    if "kp" in selected:
        check_knowledge(run)
    for name in ("fsrs", "export"):
        if name in selected:
            run.add(name, "SKIP", "MVP 未实现（M2 / M3 末）")

    if args.selftest:
        run.add("selftest.injected", "FAIL", "这是 --selftest 故意注入的失败")

    REPORT.write_text(
        json.dumps(
            {
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "selftest": args.selftest,
                "passed": sum(1 for r in run.results if r.status == "PASS"),
                "failed": len(run.failures),
                "skipped": len(run.skips),
                "results": [r.__dict__ for r in run.results],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    for r in run.results:
        mark = {"PASS": "PASS", "FAIL": "FAIL", "SKIP": "SKIP"}[r.status]
        print(f"[{mark}] {r.name:<28} {r.detail}")
    print(f"\nPASS={sum(1 for r in run.results if r.status == 'PASS')} "
          f"FAIL={len(run.failures)} SKIP={len(run.skips)}  → {REPORT}")

    return 1 if run.failures else 0


if __name__ == "__main__":
    sys.exit(main())