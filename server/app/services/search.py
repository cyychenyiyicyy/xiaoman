"""联网搜索：Tavily / 博查。DeepSeek 原生走 llm.py 的服务端工具，这里不处理。"""
from __future__ import annotations

import httpx

TAVILY_URL = "https://api.tavily.com/search"
BOCHA_URL = "https://api.bochaai.com/v1/web-search"


def _norm(items: list[dict]) -> list[dict]:
    out = []
    for it in items:
        url = (it.get("url") or "").strip()
        if not url:
            continue
        out.append(
            {
                "type": "web",
                "title": (it.get("title") or url)[:200],
                "url": url,
                "snippet": (it.get("content") or it.get("snippet") or "")[:400],
                "site": _site(url),
            }
        )
    return out


def _site(url: str) -> str:
    try:
        from urllib.parse import urlparse

        return urlparse(url).netloc.replace("www.", "")
    except Exception:  # noqa: BLE001
        return ""


async def search(provider: str, api_key: str, query: str, max_results: int = 5) -> list[dict]:
    query = (query or "").strip()
    if not query or not api_key:
        return []
    if provider == "tavily":
        return await _tavily(api_key, query, max_results)
    if provider == "bocha":
        return await _bocha(api_key, query, max_results)
    return []


async def _tavily(key: str, query: str, n: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            TAVILY_URL,
            json={"api_key": key, "query": query, "max_results": n, "search_depth": "basic"},
        )
        resp.raise_for_status()
        data = resp.json()
    return _norm(data.get("results") or [])


async def _bocha(key: str, query: str, n: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            BOCHA_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"query": query, "count": n, "summary": True},
        )
        resp.raise_for_status()
        data = resp.json()
    pages = (((data or {}).get("data") or {}).get("webPages") or {}).get("value") or []
    return _norm(pages)


async def test(provider: str, api_key: str) -> dict:
    import time

    started = time.perf_counter()
    try:
        items = await search(provider, api_key, "测试", 1)
        return {
            "ok": True,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "count": len(items),
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "count": 0,
            "error": str(exc)[:300],
        }