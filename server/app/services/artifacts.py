"""技能产物：把 Markdown 排成讲解网页 / A4 PDF。

- HTML：服务端套统一模板（纸色、clay 强调、KaTeX 公式），落在 data/artifacts/；
- PDF：先写一份临时 HTML，让本机 Edge 打开它再打印成 PDF（不引第三方 PDF 库）；
- Markdown 只支持常用子集，且在服务端转义 HTML，不执行模型给的脚本。
"""
from __future__ import annotations

import html
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from ..config import settings
from ..models import Artifact

DATE_CN = ("一", "二", "三", "四", "五", "六", "日")


def _art_dir() -> Path:
    d = settings.data_path.parent / "artifacts"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _esc(text: str) -> str:
    return html.escape(text or "", quote=False)


def _inline(text: str) -> str:
    # 行内代码先摘出来，避免里面的 * 被当成强调
    codes: list[str] = []

    def stash(m: re.Match) -> str:
        codes.append(m.group(1))
        return f"\x00C{len(codes) - 1}\x00"

    text = re.sub(r"`([^`]+)`", stash, text)
    text = re.sub(
        r"\[([^\]]+)\]\((https?://[^)\s]+)\)",
        r'<a href="\2" target="_blank" rel="noopener">\1</a>',
        text,
    )
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", text)
    for i, code in enumerate(codes):
        text = text.replace(f"\x00C{i}\x00", f"<code>{code}</code>")
    return text


def render_markdown(md: str) -> str:
    lines = (md or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("```"):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            out.append("<pre><code>" + _esc("\n".join(buf)) + "</code></pre>")
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            level = len(m.group(1))
            out.append(f"<h{level}>{_inline(_esc(m.group(2).strip()))}</h{level}>")
            i += 1
            continue

        if re.match(r"^(-{3,}|\*{3,})$", stripped):
            out.append("<hr>")
            i += 1
            continue

        if re.match(r"^[-*]\s+", line):
            items = []
            while i < len(lines) and re.match(r"^[-*]\s+", lines[i]):
                items.append(_inline(_esc(lines[i].strip()[2:].strip())))
                i += 1
            out.append("<ul>" + "".join(f"<li>{x}</li>" for x in items) + "</ul>")
            continue

        if re.match(r"^\d+[.)]\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\d+[.)]\s+", lines[i]):
                body = re.sub(r"^\d+[.)]\s+", "", lines[i].strip())
                items.append(_inline(_esc(body)))
                i += 1
            out.append("<ol>" + "".join(f"<li>{x}</li>" for x in items) + "</ol>")
            continue

        if line.lstrip().startswith(">"):
            buf = []
            while i < len(lines) and lines[i].lstrip().startswith(">"):
                buf.append(lines[i].lstrip()[1:].strip())
                i += 1
            out.append("<blockquote>" + _inline(_esc(" ".join(buf))) + "</blockquote>")
            continue

        if not stripped:
            i += 1
            continue

        # 普通段落：连续非空行合并
        buf = [line.strip()]
        i += 1
        while i < len(lines):
            nxt = lines[i]
            if not nxt.strip():
                break
            if re.match(r"^(#{1,6})\s+", nxt.strip()) or nxt.strip().startswith("```"):
                break
            if re.match(r"^[-*]\s+", nxt) or re.match(r"^\d+[.)]\s+", nxt):
                break
            if nxt.lstrip().startswith(">"):
                break
            buf.append(nxt.strip())
            i += 1
        out.append("<p>" + _inline(_esc("".join(buf))) + "</p>")
    return "\n".join(out)


TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · 小满</title>
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<style>
  :root{{
    --paper:#FBFAF7;--card:#FFFFFF;--ink:#1A1917;--ink2:#6E6A62;--ink3:#A09B90;
    --line:#E8E4DA;--clay:#B0563A;--claybg:#F8EDE8;--sage:#5F7355;
    --sans:"Instrument Sans","Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
  }}
  *{{box-sizing:border-box}}
  body{{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
    font-size:15px;line-height:1.75;-webkit-font-smoothing:antialiased}}
  .page{{max-width:760px;margin:0 auto;padding:52px 32px 64px}}
  header{{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:32px}}
  .brand{{font-size:11px;letter-spacing:.12em;color:var(--clay);font-weight:500;margin-bottom:12px}}
  h1{{font-size:34px;line-height:1.24;letter-spacing:-.02em;margin:0 0 8px;font-weight:500}}
  .sub{{font-size:13px;color:var(--ink3)}}
  h2{{font-size:24px;line-height:1.3;margin:32px 0 12px;font-weight:500;letter-spacing:-.015em}}
  h3{{font-size:19px;line-height:1.5;margin:20px 0 8px;font-weight:500}}
  p{{margin:0 0 12px}}
  ul,ol{{margin:0 0 12px;padding-left:22px}}
  li{{margin:4px 0}}
  blockquote{{margin:16px 0;padding:12px 16px;background:var(--card);border-left:3px solid var(--clayline,#EAD5CB);
    color:var(--ink2);border-radius:0 8px 8px 0}}
  pre{{background:#1D1C19;color:#EFEBE3;padding:16px;border-radius:10px;overflow:auto;font-size:13px;line-height:1.6}}
  code{{font-family:ui-monospace,Consolas,monospace;font-size:.92em;background:var(--claybg);padding:1px 5px;border-radius:4px}}
  pre code{{background:none;padding:0;color:inherit}}
  hr{{border:0;border-top:1px solid var(--line);margin:32px 0}}
  a{{color:var(--clay)}}
  .foot{{margin-top:52px;padding-top:16px;border-top:1px solid var(--line);font-size:11px;color:var(--ink3);
    display:flex;justify-content:space-between}}
  @media print{{
    @page{{size:A4;margin:16mm 14mm}}
    body{{background:#fff;font-size:12.5px;line-height:1.65}}
    .page{{max-width:none;padding:0}}
    h1{{font-size:24px}} h2{{font-size:18px;margin:20px 0 8px}} h3{{font-size:15px}}
    pre{{break-inside:avoid}} blockquote{{break-inside:avoid}}
    a{{color:inherit;text-decoration:none}}
    .foot{{margin-top:28px}}
  }}
</style>
</head>
<body>
<main class="page">
  <header>
    <div class="brand">小满 · 学习档案</div>
    <h1>{title}</h1>
    <div class="sub">{meta}</div>
  </header>
  <article>
{body}
  </article>
  <div class="foot"><span>小满 · 知识点讲解</span><span>{date}</span></div>
</main>
<script defer src="/vendor/katex/katex.min.js"></script>
<script defer src="/vendor/katex/auto-render.min.js"></script>
<script>
  document.addEventListener("DOMContentLoaded", function () {{
    if (window.renderMathInElement) {{
      window.renderMathInElement(document.body, {{
        delimiters: [{{left:"$$",right:"$$",display:true}},{{left:"$",right:"$",display:false}},
                     {{left:"\\\\(",right:"\\\\)",display:false}},{{left:"\\\\[",right:"\\\\]",display:true}}],
        throwOnError:false, strict:false
      }});
    }}
  }});
</script>
</body>
</html>
"""


def build_document(title: str, markdown: str, subject: str = "") -> str:
    now = datetime.now()
    date = f"{now.month} 月 {now.day} 日"
    md = (markdown or "").lstrip("\n")
    # 正文里重复的一级标题去掉（页头已经有标题）
    if md.startswith("# "):
        first, _, rest = md.partition("\n")
        if first.lstrip("# ").strip()[:20] == (title or "").strip()[:20]:
            md = rest.lstrip("\n")
    body = render_markdown(md)
    return TEMPLATE.format(
        title=_esc(title or "知识点讲解"),
        subject=_esc(subject or ""),
        meta=_esc(subject or "") + (" · " if subject else "") + date,
        date=date,
        body=body,
    )


def _edge() -> str:
    rel = Path("Microsoft") / "Edge" / "Application" / "msedge.exe"
    for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        base = os.environ.get(key)
        if base and (Path(base) / rel).exists():
            return str(Path(base) / rel)
    for name in ("msedge", "microsoft-edge", "google-chrome", "chromium"):
        found = shutil.which(name)
        if found:
            return found
    return ""


def _print_pdf(source_url: str, pdf_path: Path) -> None:
    edge = _edge()
    if not edge:
        raise RuntimeError("找不到 Edge/Chrome，无法生成 PDF")
    with tempfile.TemporaryDirectory() as profile:
        proc = subprocess.run(
            [
                edge,
                "--headless=new",
                "--disable-gpu",
                "--no-pdf-header-footer",
                f"--user-data-dir={profile}",
                "--virtual-time-budget=5000",
                f"--print-to-pdf={pdf_path}",
                source_url,
            ],
            capture_output=True,
            timeout=120,
        )
    if not pdf_path.exists() or pdf_path.stat().st_size < 800:
        detail = (proc.stderr or b"").decode(errors="replace")[:200]
        raise RuntimeError(f"PDF 生成失败：{detail or 'Edge 没有输出'}")


def _screenshot_png(source_url: str, png_path: Path, width: int = 1080, height: int = 1440) -> None:
    edge = _edge()
    if not edge:
        raise RuntimeError("找不到 Edge/Chrome，无法生成卡片图片")
    with tempfile.TemporaryDirectory() as profile:
        proc = subprocess.run(
            [
                edge,
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                f"--user-data-dir={profile}",
                f"--window-size={width},{height}",
                "--virtual-time-budget=5000",
                f"--screenshot={png_path}",
                source_url,
            ],
            capture_output=True,
            timeout=120,
        )
    if not png_path.exists() or png_path.stat().st_size < 1500:
        detail = (proc.stderr or b"").decode(errors="replace")[:200]
        raise RuntimeError(f"卡片生成失败：{detail or 'Edge 没有输出'}")


def save_artifact(
    db: Session,
    *,
    conversation_id: str,
    message_id: str | None,
    kind: str,
    title: str,
    markdown: str = "",
    subject: str = "",
    kp_ids: list | None = None,
    document: str | None = None,
    source_md: str = "",
    skill: str = "",
    parent_id: str | None = None,
) -> Artifact:
    kind = kind if kind in ("html", "pdf", "png", "flashcards", "paper") else "html"
    title = (title or "知识点讲解").strip()[:120]
    aid = uuid.uuid4().hex
    folder = _art_dir()
    if document is None:
        if kind == "png":
            from .cards import build_card_document

            doc = build_card_document(title, markdown, subject)
        else:
            doc = build_document(title, markdown, subject)
    else:
        doc = document

    if kind in ("html", "flashcards", "paper"):
        path = folder / f"{aid}.html"
        path.write_text(doc, encoding="utf-8")
        mime = "text/html; charset=utf-8"
        artifact = Artifact(
            id=aid,
            conversation_id=conversation_id,
            message_id=message_id,
            kind=kind,
            title=title,
            subject=(subject or "")[:20],
            path=str(path),
            mime=mime,
            bytes=path.stat().st_size,
            kp_ids=kp_ids or [],
            source_md=source_md or "",
            skill=(skill or "")[:32],
            parent_id=parent_id,
        )
        db.add(artifact)
        db.commit()
        db.refresh(artifact)
        return artifact

    # PDF / PNG：先写临时 HTML，交给 Edge 打开后再打印 / 截图
    path = folder / f"{aid}.pdf" if kind == "pdf" else folder / f"{aid}.png"
    src = folder / f"{aid}.src.html"
    src.write_text(doc, encoding="utf-8")
    artifact = Artifact(
        id=aid,
        conversation_id=conversation_id,
        message_id=message_id,
        kind=kind,
        title=title,
        subject=(subject or "")[:20],
        path=str(path),
        mime="application/pdf" if kind == "pdf" else "image/png",
        bytes=0,
        kp_ids=kp_ids or [],
        source_md=source_md or "",
        skill=(skill or "")[:32],
        parent_id=parent_id,
    )
    db.add(artifact)
    db.commit()
    base = (settings.app_base_url or "http://127.0.0.1:8787").rstrip("/")
    try:
        if kind == "pdf":
            _print_pdf(f"{base}/api/v1/artifacts/{aid}/source", path)
        else:
            _screenshot_png(f"{base}/api/v1/artifacts/{aid}/source", path)
    except Exception:
        db.delete(artifact)
        db.commit()
        raise
    finally:
        if src.exists():
            src.unlink(missing_ok=True)
    artifact.bytes = path.stat().st_size if path.exists() else 0
    db.commit()
    db.refresh(artifact)
    return artifact


def workspace_root() -> Path:
    p = Path(settings.workspace_dir)
    if p.is_absolute():
        return p.resolve()
    # 从 server/ 或仓库根启动都能找到 agent/workspaces
    for base in (Path.cwd(), Path(__file__).resolve().parents[2]):
        q = (base / p).resolve()
        if q.exists():
            return q
    return (Path.cwd() / p).resolve()


def publish_workspace(
    db: Session,
    *,
    conversation_id: str,
    message_id: str | None,
    path: str,
    title: str,
    kind: str = "html",
    subject: str = "",
    skill: str = "",
) -> Artifact:
    """把受限工作区里的 HTML 文件发布成资料库产物；PDF 交给 Edge 打印。"""
    ws = workspace_root() / conversation_id
    target = (ws / path).resolve()
    if not target.is_relative_to(ws.resolve()) or not target.is_file():
        raise ValueError("工作区里没有这个文件")
    doc = target.read_text(encoding="utf-8")
    if not doc.strip():
        raise ValueError("文件是空的")
    real_kind = "pdf" if kind == "pdf" else ("paper" if kind == "paper" else "html")
    return save_artifact(
        db,
        conversation_id=conversation_id,
        message_id=message_id,
        kind=real_kind,
        title=title or target.stem,
        subject=subject,
        document=doc,
        source_md=doc,
        skill=skill,
    )


def source_path(aid: str) -> Path:
    return _art_dir() / f"{aid}.src.html"


def payload(a: Artifact) -> dict:
    return {
        "id": a.id,
        "kind": a.kind,
        "title": a.title,
        "subject": a.subject or "",
        "url": f"/api/v1/artifacts/{a.id}",
        "mime": a.mime,
        "bytes": int(a.bytes or 0),
        "skill": a.skill or "",
        "parent_id": a.parent_id or "",
    }


def append_artifact_parts(db: Session, message) -> list[dict]:
    from sqlalchemy import select

    parts = [dict(p) for p in (message.parts or [])]
    have = {p.get("artifact", {}).get("id") for p in parts if p.get("type") == "artifact"}
    rows = db.scalars(select(Artifact).where(Artifact.message_id == message.id).order_by(Artifact.created_at)).all()
    for a in rows:
        if a.id not in have:
            parts.append({"type": "artifact", "artifact": payload(a)})
    message.parts = parts
    return parts
