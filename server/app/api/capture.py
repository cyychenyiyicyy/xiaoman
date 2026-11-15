"""录入（M1.1）：上传一页 → 任务状态机 → 解析 → 抽取 → 待确认。"""
import hashlib
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal, get_db
from sqlalchemy import select

from ..models import CaptureTask, LLMProvider
from ..services import ocr

router = APIRouter(tags=["capture"])

ALLOWED = {"image/jpeg", "image/png", "image/webp"}
EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


def _sniff(raw: bytes) -> str | None:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


async def run_task(task_id: str) -> None:
    """后台跑一页：parsing → extracting → review/failed。"""
    with SessionLocal() as db:
        task = db.get(CaptureTask, task_id)
        if task is None:
            return
        task.status, task.error = "parsing", ""
        db.commit()
        try:
            key = settings.ocr_api_key or settings.deepseek_api_key
            if not key:
                row = db.scalars(
                    select(LLMProvider).where(LLMProvider.base_url.contains("deepseek.com"))
                ).first()
                key = row.api_key if row else ""
            blocks = await ocr.parse_to_blocks(Path(task.page_path), api_key=key)
            task.blocks_json, task.status = blocks, "extracting"
            db.commit()

            groups = await ocr.extract_groups(blocks)
            task.groups_json = groups
            task.confidence = ocr.confidence_of(groups)
            task.status = "review"
            db.commit()
        except Exception as exc:  # noqa: BLE001
            task.status, task.error = "failed", str(exc)[:400]
            db.commit()


def _out(t: CaptureTask, full: bool = False) -> dict:
    data = {
        "id": t.id,
        "status": t.status,
        "page_no": t.page_no,
        "subject": t.subject,
        "paper_id": t.paper_id,
        "confidence": round(t.confidence or 0, 3),
        "error": t.error,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        "question_count": sum(len(g.get("questions") or []) for g in (t.groups_json or {}).get("groups") or []),
    }
    if full:
        data["blocks"] = t.blocks_json or {}
        data["groups"] = t.groups_json or {}
    return data


@router.post("/capture/pages", status_code=201)
async def upload_page(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    subject: str = Form("全部"),
    paper_id: str = Form(""),
    page_no: int = Form(1),
    db: Session = Depends(get_db),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "空文件")
    mime = (file.content_type or "").lower()
    if mime not in ALLOWED:
        mime = _sniff(raw) or mime
    if mime not in ALLOWED:
        raise HTTPException(415, f"不支持的图片格式：{mime}")

    task = CaptureTask(subject=subject[:20], paper_id=paper_id[:32], page_no=max(1, int(page_no)))
    dest_dir = settings.data_path.parent / "captures"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{task.id}{EXT[mime]}"
    dest.write_bytes(raw)
    task.page_path = str(dest)
    db.add(task)
    db.commit()
    db.refresh(task)

    background.add_task(run_task, task.id)
    return {"task_id": task.id, "status": task.status, "sha256": hashlib.sha256(raw).hexdigest()[:16]}


@router.get("/capture/tasks")
def list_tasks(status: str = "", limit: int = 50, db: Session = Depends(get_db)):
    stmt = select(CaptureTask).order_by(CaptureTask.created_at.desc()).limit(max(1, min(limit, 200)))
    if status:
        stmt = stmt.where(CaptureTask.status == status)
    return {"items": [_out(t) for t in db.scalars(stmt).all()]}


@router.get("/capture/tasks/{task_id}")
def get_task(task_id: str, full: bool = False, db: Session = Depends(get_db)):
    task = db.get(CaptureTask, task_id)
    if task is None:
        raise HTTPException(404, "任务不存在")
    return _out(task, full=full)


@router.post("/capture/tasks/{task_id}/retry")
async def retry_task(task_id: str, background: BackgroundTasks, db: Session = Depends(get_db)):
    task = db.get(CaptureTask, task_id)
    if task is None:
        raise HTTPException(404, "任务不存在")
    if not task.page_path or not Path(task.page_path).exists():
        raise HTTPException(410, "原图已丢失，需要重拍")
    task.status, task.error = "queued", ""
    db.commit()
    background.add_task(run_task, task.id)
    return {"task_id": task.id, "status": "queued"}


@router.get("/capture/page/{task_id}")
def page_image(task_id: str, db: Session = Depends(get_db)):
    from fastapi.responses import FileResponse

    task = db.get(CaptureTask, task_id)
    if task is None or not Path(task.page_path).exists():
        raise HTTPException(404, "原图不存在")
    return FileResponse(task.page_path)