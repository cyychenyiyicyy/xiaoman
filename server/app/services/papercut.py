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
import hmac
import json
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


# ── 官方 OpenAPI（AK/SK）──────────────────────────────
def _sign(secret: str, canonical: str) -> str:
    return base64.b64encode(hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).digest()).decode()


async def _call_openapi(image_path: Path, subject: str) -> dict:
    ak_id = settings.aliyun_ak_id
    ak_secret = settings.aliyun_ak_secret
    workspace = settings.papercut_workspace_id
    endpoint = settings.papercut_endpoint or "https://edututor.cn-hangzhou.aliyuncs.com/service/cutApi"
    if not (ak_id and ak_secret and workspace):
        raise PapercutError("官方切题需要 ALIYUN_AK_ID / ALIYUN_AK_SECRET / PAPERCUT_WORKSPACE_ID")

    # 官方接口要求 image 是 URL；本地文件先转 data URL 不行，这里支持传公网 URL（M1.2 接对象存储后启用）
    raise PapercutError(
        "官方 CutQuestions 的 image 参数要求公网 URL。方案：先把原图存到对象存储（或服务器静态目录）再调用；"
        "若你打算用云市场版（支持 base64），把 PAPERCUT_AUTH 设成 appcode。"
    )


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
        "image_correction": True,
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
    questions = body.get("questions") or []
    result = normalize(questions, _img_size(image_path))
    result["warnings"] = result["warnings"][:10]
    return result