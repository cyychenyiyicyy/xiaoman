"""models.dev 目录：内置平台清单 + 模型元数据查询。

数据源：https://models.dev/api.json（MIT，约 6MB / 230+ provider）。
缓存到 data/catalog/models.dev.json，TTL 24 小时；下载失败时用旧缓存，旧缓存也没有就返回空表（不抛错）。
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import httpx

from ..config import settings

CATALOG_URL = "https://models.dev/api.json"
TTL_SECONDS = 24 * 3600
_lock = threading.Lock()
_cache: dict | None = None
_cache_at: float = 0.0

# 内置平台：只用 OpenAI 兼容端点（MVP 的 llm.py 只实现这一种协议）
# base_url 是校对过的实际端点，不直接照抄 models.dev 的 api 字段（有的缺 /v1，有的是 anthropic 协议）
PRESETS: list[dict] = [
    {"catalog_id": "deepseek", "name": "DeepSeek", "group": "国内",
     "base_url": "https://api.deepseek.com/v1", "api_style": "openai",
     "doc": "https://api-docs.deepseek.com/quick_start/pricing"},
    {"catalog_id": "alibaba-cn", "name": "阿里云百炼", "group": "国内",
     "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_style": "openai",
     "doc": "https://help.aliyun.com/zh/model-studio/"},
    {"catalog_id": "volcengine", "name": "火山方舟", "group": "国内",
     "base_url": "https://ark.cn-beijing.volces.com/api/v3", "api_style": "openai",
     "doc": "https://www.volcengine.com/docs/82379/1330310"},
    {"catalog_id": "zhipuai", "name": "智谱 AI", "group": "国内",
     "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_style": "openai",
     "doc": "https://docs.bigmodel.cn/cn/guide/start/pricing"},
    {"catalog_id": "moonshotai-cn", "name": "Kimi（月之暗面）", "group": "国内",
     "base_url": "https://api.moonshot.cn/v1", "api_style": "openai",
     "doc": "https://platform.moonshot.cn/docs/api/chat"},
    {"catalog_id": "siliconflow-cn", "name": "硅基流动", "group": "国内",
     "base_url": "https://api.siliconflow.cn/v1", "api_style": "openai",
     "doc": "https://docs.siliconflow.cn/"},
    {"catalog_id": "stepfun", "name": "阶跃星辰", "group": "国内",
     "base_url": "https://api.stepfun.com/v1", "api_style": "openai",
     "doc": "https://platform.stepfun.com/docs/zh/overview/concept"},
    {"catalog_id": "openai", "name": "OpenAI", "group": "海外",
     "base_url": "https://api.openai.com/v1", "api_style": "openai",
     "doc": "https://platform.openai.com/docs/models"},
    {"catalog_id": "google", "name": "Google Gemini", "group": "海外",
     "base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "api_style": "openai",
     "doc": "https://ai.google.dev/gemini-api/docs/openai"},
    {"catalog_id": "openrouter", "name": "OpenRouter", "group": "海外",
     "base_url": "https://openrouter.ai/api/v1", "api_style": "openai",
     "doc": "https://openrouter.ai/docs"},
    {"catalog_id": "groq", "name": "Groq", "group": "海外",
     "base_url": "https://api.groq.com/openai/v1", "api_style": "openai",
     "doc": "https://console.groq.com/docs"},
    {"catalog_id": "togetherai", "name": "Together AI", "group": "海外",
     "base_url": "https://api.together.xyz/v1", "api_style": "openai",
     "doc": "https://docs.together.ai/docs/openai-api-compatibility"},
    {"catalog_id": "xai", "name": "xAI（Grok）", "group": "海外",
     "base_url": "https://api.x.ai/v1", "api_style": "openai",
     "doc": "https://docs.x.ai/docs/overview"},
]

PRESET_BY_ID = {p["catalog_id"]: p for p in PRESETS}


def cache_file() -> Path:
    return settings.data_path.parent / "catalog" / "models.dev.json"


def _download() -> dict | None:
    try:
        with httpx.Client(timeout=45.0) as client:
            resp = client.get(CATALOG_URL)
            resp.raise_for_status()
            data = resp.json()
        path = cache_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return data
    except Exception:  # noqa: BLE001 - 目录拿不到不能影响主流程
        return None


def load(force: bool = False) -> dict:
    global _cache, _cache_at
    with _lock:
        now = time.time()
        if _cache is not None and not force and now - _cache_at < TTL_SECONDS:
            return _cache
        path = cache_file()
        fresh = path.exists() and (now - path.stat().st_mtime) < TTL_SECONDS
        data = None
        if fresh and not force:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                data = None
        if data is None:
            data = _download()
            if data is None and path.exists():
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    data = {}
        _cache = data or {}
        _cache_at = now
        return _cache


def _norm(key: str, m: dict) -> dict:
    modalities = m.get("modalities") or {}
    inputs = modalities.get("input") or []
    limit = m.get("limit") or {}
    return {
        "key": key,
        "name": m.get("name") or key,
        "context": int(limit.get("context") or 0),
        "output": int(limit.get("output") or 0),
        "images": bool(m.get("attachment")) or ("image" in inputs),
        "tools": bool(m.get("tool_call")),
        "reasoning": bool(m.get("reasoning")),
    }


def lookup(catalog_id: str, model_key: str) -> dict | None:
    """先按 catalog_id 精确查，再跨平台兜底同名模型。查不到返回 None。"""
    data = load()
    key = (model_key or "").strip()
    if not key:
        return None

    prov = data.get(catalog_id or "")
    if isinstance(prov, dict):
        models = prov.get("models") or {}
        if isinstance(models, dict):
            if key in models:
                return _norm(key, models[key])
            lowered = {k.lower(): k for k in models}
            if key.lower() in lowered:
                return _norm(key, models[lowered[key.lower()]])

    # 兜底：别的平台也收录了同名模型（元数据通常一致）
    for pid, prov_any in data.items():
        if not isinstance(prov_any, dict):
            continue
        models = prov_any.get("models") or {}
        if isinstance(models, dict) and key in models:
            return _norm(key, models[key])
    return None


def models_of(catalog_id: str, limit: int = 300) -> list[dict]:
    data = load()
    prov = data.get(catalog_id or "")
    if not isinstance(prov, dict):
        return []
    models = prov.get("models") or {}
    if not isinstance(models, dict):
        return []
    out = [_norm(key, m) for key, m in models.items() if isinstance(m, dict)]
    out.sort(key=lambda x: (x["name"] or "").lower())
    return out[:limit]


def sources(providers_by_catalog: dict[str, dict]) -> list[dict]:
    data = load()
    out = []
    for preset in PRESETS:
        prov = data.get(preset["catalog_id"]) or {}
        models = prov.get("models") if isinstance(prov, dict) else {}
        local = providers_by_catalog.get(preset["catalog_id"])
        out.append(
            {
                **preset,
                "model_count": len(models) if isinstance(models, dict) else 0,
                "connected": bool(local and local.get("connected")),
                "provider_id": local.get("id") if local else None,
            }
        )
    return out