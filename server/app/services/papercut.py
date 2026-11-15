"""阿里云切题（试卷切题）：把整页照片直接切成结构化题目。

两条路都支持，用配置切换：

1) 官方 EduTutor `CutQuestions`（推荐，公测期每账号每天免费 1000 次）
   POST https://edututor.cn-hangzhou.aliyuncs.com/service/cutApi?workspaceId=<id>
   body: {"image": "<url>", "parameters": {"struct": true, "extract_images": true}}
   AK/SK 签名（Alibaba Cloud OpenAPI 风格）。

2) 云市场 `cmapi00042623`（APPCODE）
   POST <你的云市场调用地址>/educationservice/papercut
   Header: Authorization: APPCODE <code>
   body: {"imgList": ["<base64>"], "paperType": "question", "templateType": "Physics", "image_correction": true}

本模块只做三件事：调用、把响应归一成我们的 groups、给出可复核的 warnings。
不猜：算法切出来是什么就是什么，切漏的写进 warnings。
"""
from __future__ import annotations

import base64
import hashlib
import uuid
import hmac
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import httpx

from ..config import settings


class PapercutError(RuntimeError):
    pass


# 九科 → 云市场 templateType
TEMPLATE = {
    "语文": "Chinese",
    "数学": "Math",
    "英语": "English",
    "物理": "Physics",
    "化学": "Chemistry",
    "生物": "Biology",
    "历史": "History",
    "地理": "Geography",
    "政治": "Politics",
    "全部": "default",
}

# 算法给的题型 → 我们的 qtype
QTYPE = {
    "选择题": "choice",
    "填空题": "blank",
    "判断题": "judge",
    "问答题": "short",
    "解答题": "short",
    "作文题": "essay",
    "其他": "short",
}


def _poly_to_bbox(poly: list) -> list[int]:
    """pos_list 是 8 个数的多边形（像素）→ [x1,y1,x2,y2]。"""
    if not poly or len(poly) < 4:
        return []
    xs = poly[0::2]
    ys = poly[1::2]
    return [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]


def _img_size(path: Path) -> tuple[int, int]:
    """不依赖 Pillow，读 PNG/JPEG 头拿宽高；拿不到就按 0 处理（后续不归一化）。"""
    try:
        raw = path.read_bytes()[:64 * 1024]
    except OSError:
        return (0, 0)
    if raw.startswith(b"\x89PNG\r\n\x1a\n") and len(raw) >= 24:
        return (int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big"))
    if raw.startswith(b"\xff\xd8"):
        i = 2
        while i < len(raw) - 9:
            if raw[i] != 0xFF:
                i += 1
                continue
            marker = raw[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h = int.from_bytes(raw[i + 5 : i + 7], "big")
                w = int.from_bytes(raw[i + 7 : i + 9], "big")
                return (w, h)
            if marker in (0xD8, 0xD9):
                i += 2
                continue
            seg_len = int.from_bytes(raw[i + 2 : i + 4], "big")
            i += 2 + seg_len
    return (0, 0)


def _poly_xy_bbox(pos_list: list, w: int, h: int) -> list[int]:
    """[{x,y},...] 像素多边形 → 归一化 [x1,y1,x2,y2]（0–1000）。"""
    xs = [p.get("x", 0) for p in pos_list if isinstance(p, dict)]
    ys = [p.get("y", 0) for p in pos_list if isinstance(p, dict)]
    if not xs or not ys:
        return []
    x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
    if not w or not h:
        return [int(x1), int(y1), int(x2), int(y2)]
    return [int(x1 * 1000 / w), int(y1 * 1000 / h), int(x2 * 1000 / w), int(y2 * 1000 / h)]


def _split_options(text: str) -> tuple[str, list[str]]:
    """把「题干 + A. … B. …」拆成题干与选项。"""
    marks = list(re.finditer(r"(?<![A-Za-z0-9])([A-D])[.．、]\s*", text))
    if len(marks) < 2:
        return text.strip(), []
    stem = text[: marks[0].start()].strip()
    options = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        options.append(text[m.start() : end].strip())
    return stem, options


def _market_groups(data: dict) -> dict:
    """云市场扫描版切题的响应：page_list[].subject_list[]（每项已是切好的题）。"""
    groups: list[dict] = []
    warnings: list[str] = []
    for page in data.get("page_list") or []:
        w = int(page.get("width") or page.get("orgWidth") or 0)
        h = int(page.get("height") or page.get("orgHeight") or 0)
        pno = int(page.get("page_id") or 0) + 1
        for sub in page.get("subject_list") or []:
            text = (sub.get("text") or "").strip()
            if not text:
                continue
            pos = None
            for c in sub.get("content_list_info") or []:
                if c.get("pos"):
                    pos = c["pos"]
                    break
            bbox = _poly_xy_bbox(pos or [], w, h)
            stem, options = _split_options(text)
            qtype = "choice" if options else ("blank" if ("____" in text or "＿" in text) else "short")
            groups.append(
                {
                    "group_id": f"G{len(groups) + 1}",
                    "section": "",
                    "shared_stem": "",
                    "shared_pages": [pno],
                    "questions": [
                        {
                            "number": str(len(groups) + 1),
                            "type": qtype,
                            "score": None,
                            "stem": stem,
                            "options": options,
                            "answer": "",
                            "source_page": pno,
                            "bbox": bbox,
                            "continues_previous": bool(sub.get("is_multipage")),
                        }
                    ],
                }
            )
    if not groups:
        warnings.append("没切出题目")
    elif len(groups) == 1:
        warnings.append("只切出 1 题：可能整页被当成一题，或切题失败，建议核对原图后重拍")
    return {"groups": groups, "warnings": warnings, "source": "papercut"}


def normalize(questions: list, size: tuple[int, int]) -> dict:
    """算法响应 → 我们的 groups（每题一个 group，坐标归一化到 0–1000）。"""
    w, h = size
    groups = []
    warnings = []
    for idx, q in enumerate(questions or []):
        info = q.get("info") or {}
        stem = ((info.get("stem") or {}).get("text") or "").strip()
        if not stem:
            warnings.append(f"第 {idx + 1} 题没拿到题干文本")
            continue
        options = [((o or {}).get("text") or "").strip() for o in info.get("option") or []]
        answers = [((a or {}).get("text") or "").strip() for a in info.get("answer") or []]
        bbox = _poly_to_bbox((q.get("pos_list") or [[]])[0])
        if bbox and w and h:
            bbox = [
                int(bbox[0] * 1000 / w),
                int(bbox[1] * 1000 / h),
                int(bbox[2] * 1000 / w),
                int(bbox[3] * 1000 / h),
            ]
        groups.append(
            {
                "group_id": f"G{len(groups) + 1}",
                "section": "",
                "shared_stem": "",
                "shared_pages": [1],
                "questions": [
                    {
                        "number": str(idx + 1),
                        "type": QTYPE.get(str(info.get("type") or ""), "short"),
                        "score": None,
                        "stem": stem,
                        "options": options,
                        "answer": "\n".join(a for a in answers if a),
                        "source_page": 1,
                        "bbox": bbox,
                        "continues_previous": False,
                    }
                ],
            }
        )
    return {"groups": groups, "warnings": warnings, "source": "papercut"}


# ── 官方 OpenAPI（AK/SK，公测期每天免费 1000 次）────────

def _oss_url(image_path: Path) -> str:
    """把本地图传到 OSS 并签一个临时公网 URL（官方接口要求 image 是 URL）。"""
    try:
        import oss2
    except ImportError as exc:  # pragma: no cover
        raise PapercutError("没装 oss2：pip install oss2") from exc

    ak_id, ak_secret = settings.aliyun_ak_id, settings.aliyun_ak_secret
    bucket_name, endpoint = settings.oss_bucket, settings.oss_endpoint
    if not (bucket_name and endpoint):
        raise PapercutError("官方切题要先把图传到 OSS：配 OSS_BUCKET / OSS_ENDPOINT（同一个 AK 即可）")

    auth = oss2.Auth(ak_id, ak_secret)
    bucket = oss2.Bucket(auth, endpoint, bucket_name)
    key = f"xiaoman/cut/{uuid.uuid4().hex}{image_path.suffix or '.png'}"
    bucket.put_object(key, image_path.read_bytes())
    return bucket.sign_url("GET", key, 3600)


async def _call_openapi(image_path: Path, subject: str) -> dict:
    """官方 CutQuestions：AK/SK 签名，返回 data 是 JSON 字符串。"""
    ak_id = settings.aliyun_ak_id
    ak_secret = settings.aliyun_ak_secret
    workspace = settings.papercut_workspace_id
    if not (ak_id and ak_secret and workspace):
        raise PapercutError(
            "官方切题需要 ALIYUN_AK_ID / ALIYUN_AK_SECRET / PAPERCUT_WORKSPACE_ID"
            "（AccessKey 与百炼业务空间 id，见 docs/25）"
        )

    try:
        from alibabacloud_edututor20250707.client import Client
        from alibabacloud_edututor20250707 import models as m
        from alibabacloud_tea_openapi import models as open_api_models
    except ImportError as exc:  # pragma: no cover
        raise PapercutError("没装官方 SDK：pip install alibabacloud-edututor20250707") from exc

    url = _oss_url(image_path)
    cfg = open_api_models.Config(access_key_id=ak_id, access_key_secret=ak_secret)
    cfg.endpoint = settings.papercut_openapi_endpoint or "edututor.cn-hangzhou.aliyuncs.com"
    client = Client(cfg)
    req = m.CutQuestionsRequest(
        image=url,
        parameters=m.CutQuestionsRequestParameters(struct=True, extract_images=True),
        workspace_id=workspace,
    )
    resp = client.cut_questions(req)
    body = resp.body
    if not body or not body.success:
        raise PapercutError(f"切题失败：{(body.message if body else '空响应')}")

    data = body.data
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except json.JSONDecodeError as exc:
            raise PapercutError("切题返回的 data 不是 JSON") from exc
    return data if isinstance(data, dict) else {}


# ── 云市场（APPCODE，支持 base64）────────────────────
async def _call_appcode(image_path: Path, subject: str) -> dict:
    appcode = settings.papercut_appcode
    endpoint = settings.papercut_endpoint
    if not (appcode and endpoint):
        raise PapercutError("云市场切题需要 PAPERCUT_APPCODE 与 PAPERCUT_ENDPOINT（从云市场控制台复制调用地址）")
    raw = image_path.read_bytes()
    payload = {
        "imgList": [base64.b64encode(raw).decode()],
        "paperType": "question",
        "templateType": TEMPLATE.get(subject, "default"),
        "image_correction": bool(settings.papercut_correct),
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=15.0)) as client:
        resp = await client.post(
            endpoint,
            headers={"Authorization": f"APPCODE {appcode}", "Content-Type": "application/json"},
            json=payload,
        )
        if resp.status_code >= 400:
            raise PapercutError(f"切题 HTTP {resp.status_code}: {resp.text[:200]}")
        return resp.json()


async def cut(image_path: Path, subject: str = "全部") -> dict:
    """返回 {groups, warnings, source}。auth 由 settings.papercut_auth 决定（appcode|aksk）。"""
    auth = (settings.papercut_auth or "").lower()
    if auth == "appcode":
        data = await _call_appcode(image_path, subject)
    elif auth == "aksk":
        data = await _call_openapi(image_path, subject)
    else:
        raise PapercutError("没配切题：把 PAPERCUT_AUTH 设成 appcode 或 aksk")

    # 两种响应都可能把结构化结果塞在 data 字符串里
    body = data.get("data") if isinstance(data, dict) else None
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            body = {}
    if not isinstance(body, dict):
        body = data if isinstance(data, dict) else {}
    if body.get("page_list"):
        result = _market_groups(body)
    else:
        questions = body.get("questions") or []
        result = normalize(questions, _img_size(image_path))
    result["warnings"] = result["warnings"][:10]
    return result