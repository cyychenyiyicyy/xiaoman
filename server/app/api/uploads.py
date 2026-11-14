"""图片上传与读取。MVP 只存原图，不做任何解析。"""
import hashlib
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import Attachment
from ..schemas import UploadOut

router = APIRouter(tags=["uploads"])

MAX_BYTES = 20 * 1024 * 1024
ALLOWED = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/heic"}
EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic"}


def sniff(raw: bytes) -> str | None:
    """按文件头判断图片类型。相机/文件选择器常发 application/octet-stream。"""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if raw[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1"):
        return "image/heic"
    return None


@router.post("/uploads", response_model=UploadOut)
async def upload(file: UploadFile, db: Session = Depends(get_db)):
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "空文件")
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "图片超过 20MB")
    mime = (file.content_type or "").lower()
    if mime not in ALLOWED:
        mime = sniff(raw) or mime or "application/octet-stream"
    if mime not in ALLOWED:
        raise HTTPException(415, f"不支持的图片格式：{mime}")

    settings.data_path.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(raw).hexdigest()
    att = Attachment(filename=file.filename or "", mime=mime, bytes=len(raw), sha256=digest)
    dest = settings.data_path / f"{att.id}{EXT[mime]}"
    dest.write_bytes(raw)
    att.path = str(dest)
    db.add(att)
    db.commit()
    db.refresh(att)
    return UploadOut(id=att.id, url=f"/api/v1/attachments/{att.id}", mime=mime, bytes=len(raw))


@router.get("/attachments/{aid}")
def read_attachment(aid: str, db: Session = Depends(get_db)):
    att = db.get(Attachment, aid)
    if att is None:
        raise HTTPException(404, "附件不存在")
    path = Path(att.path)
    if not path.exists():
        raise HTTPException(410, "附件文件已丢失")
    return FileResponse(path, media_type=att.mime, filename=att.filename or None)