"""切题自检：拿一张图直接跑 papercut，不开界面。

用法：
    cd server
    .venv\\Scripts\\python.exe -m scripts.cut_test <图片路径> [学科]
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.services import papercut  # noqa: E402


async def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python -m scripts.cut_test <图片路径> [学科]")
        return 2
    image = Path(sys.argv[1])
    subject = sys.argv[2] if len(sys.argv) > 2 else "全部"
    if not image.exists():
        print(f"图片不存在：{image}")
        return 2

    print(f"auth={settings.papercut_auth or '(未配置)'}  subject={subject}")
    try:
        result = await papercut.cut(image, subject)
    except papercut.PapercutError as exc:
        print(f"失败：{exc}")
        return 1

    groups = result.get("groups") or []
    print(f"provider={result.get('source')}  questions={sum(len(g.get('questions') or []) for g in groups)}")
    for g in groups:
        for q in g.get("questions") or []:
            print(f"  {g['group_id']} #{q['number']:<3} {q['type']:<6} bbox={q.get('bbox')}  {q['stem'][:40]}")
            if q.get("answer"):
                print(f"        answer: {q['answer'][:40]}")
    for w in result.get("warnings") or []:
        print("  warning:", w)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))