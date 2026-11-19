"""单用户登录：一个访问密码 → HttpOnly 会话 Cookie。

- 密码只存 scrypt 哈希（server/.env 的 APP_PASSWORD_HASH），仓库里没有明文；
- 会话在内存里（服务重启后重新登录），30 天过期；
- 关闭登录：APP_PASSWORD_HASH 留空（本地开发默认）。
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from collections import defaultdict

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from ..config import settings

router = APIRouter(tags=["auth"])

COOKIE = "xm_session"
SESSION_TTL = max(1, int(settings.app_session_days)) * 86400
MAX_ATTEMPTS = 8
ATTEMPT_WINDOW = 300

_SESSIONS: dict[str, float] = {}
_ATTEMPTS: dict[str, list[float]] = defaultdict(list)


def auth_enabled() -> bool:
    return bool((settings.app_password_hash or "").strip())


def make_password_hash(password: str) -> str:
    """生成 scrypt$n$r$p$salt$hash，可直接写进 APP_PASSWORD_HASH。"""
    salt = secrets.token_bytes(16)
    n, r, p = 16384, 8, 1
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=32)
    return f"scrypt${n}${r}${p}${salt.hex()}${digest.hex()}"


def _verify(password: str) -> bool:
    stored = (settings.app_password_hash or "").strip()
    if not stored:
        return True
    try:
        kind, n, r, p, salt_hex, hash_hex = stored.split("$")
        if kind != "scrypt":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        got = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
        return hmac.compare_digest(got, expected)
    except (ValueError, TypeError):
        return False


def _client_ip(request: Request) -> str:
    # Caddy 会写 X-Real-IP；本地开发没有代理时用 client.host
    return (request.headers.get("x-real-ip") or request.client.host or "?").strip()


def _too_many(ip: str) -> bool:
    now = time.time()
    rows = [t for t in _ATTEMPTS[ip] if now - t < ATTEMPT_WINDOW]
    _ATTEMPTS[ip] = rows
    return len(rows) >= MAX_ATTEMPTS


def _fail(ip: str) -> None:
    _ATTEMPTS[ip].append(time.time())


def session_valid(token: str | None) -> bool:
    if not auth_enabled():
        return True
    if not token:
        return False
    exp = _SESSIONS.get(token)
    if not exp:
        return False
    if exp < time.time():
        _SESSIONS.pop(token, None)
        return False
    return True


class LoginIn(BaseModel):
    password: str = ""


@router.get("/auth/me")
def me(request: Request):
    if not auth_enabled():
        return {"authenticated": True, "auth_enabled": False}
    if not session_valid(request.cookies.get(COOKIE)):
        raise HTTPException(401, "未登录")
    return {"authenticated": True, "auth_enabled": True}


@router.post("/auth/login")
def login(payload: LoginIn, request: Request, response: Response):
    if not auth_enabled():
        return {"ok": True, "auth_enabled": False}
    ip = _client_ip(request)
    if _too_many(ip):
        raise HTTPException(429, "尝试次数太多，请 5 分钟后再试")
    if not _verify((payload.password or "").strip()):
        _fail(ip)
        raise HTTPException(401, "密码不对")
    _ATTEMPTS.pop(ip, None)
    token = secrets.token_urlsafe(32)
    _SESSIONS[token] = time.time() + SESSION_TTL
    secure = (request.headers.get("x-forwarded-proto") or "").lower() == "https"
    response.set_cookie(
        COOKIE,
        token,
        max_age=SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )
    return {"ok": True, "auth_enabled": True, "expires_in": SESSION_TTL}


@router.post("/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        _SESSIONS.pop(token, None)
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}
