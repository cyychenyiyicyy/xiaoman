"""小满 Xiaoman · MVP 服务入口。

启动顺序：建目录 →（可选）建表 → seed → 挂载 API 与静态前端。
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, text

from .api import (
    auth as auth_api,
    capture,
    catalog_api,
    chat,
    conversations,
    internal,
    kp,
    learn,
    memories,
    profile,
    providers,
    questions,
    stats,
    settings as settings_api,
    uploads,
)
from .config import settings
from .db import Base, SessionLocal, engine
from .seed import ensure_seed

APP_VERSION = "0.1.0-mvp"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.data_path.mkdir(parents=True, exist_ok=True)
    if settings.auto_create:
        Base.metadata.create_all(engine)
    with SessionLocal() as db:
        ensure_seed(db)
    yield


app = FastAPI(title="小满 Xiaoman", version=APP_VERSION, lifespan=lifespan)


@app.middleware("http")
async def token_guard(request: Request, call_next):
    """只有设了 APP_TOKEN 才校验；本机开发留空即不拦。"""
    if settings.app_token and request.url.path.startswith("/api"):
        token = request.headers.get("x-api-token") or request.query_params.get("token")
        if token != settings.app_token:
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


@app.middleware("http")
async def shell_no_cache(request: Request, call_next):
    """壳 HTML 不强缓存：WebView 关闭重开才能拿到新的 version 参数。"""
    response = await call_next(request)
    if request.url.path in ("/", "/index.html") and response.headers.get(
        "content-type", ""
    ).startswith("text/html"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


@app.middleware("http")
async def auth_guard(request: Request, call_next):
    """单用户访问密码：只保护 API，静态壳公开（登录页需要加载）。"""
    if not auth_api.auth_enabled():
        return await call_next(request)
    path = request.url.path
    if not path.startswith("/api"):
        return await call_next(request)
    public = {
        "/api/v1/auth/me",
        "/api/v1/auth/login",
        "/api/v1/auth/logout",
    }
    if path in public:
        return await call_next(request)
    if path.startswith("/api/v1/internal/"):
        if request.headers.get("x-internal-token") == settings.internal_token:
            return await call_next(request)
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    if not auth_api.session_valid(request.cookies.get(auth_api.COOKIE)):
        return JSONResponse({"detail": "未登录"}, status_code=401)
    return await call_next(request)


app.include_router(auth_api.router, prefix="/api/v1")
app.include_router(chat.router, prefix="/api/v1")
app.include_router(conversations.router, prefix="/api/v1")
app.include_router(catalog_api.router, prefix="/api/v1")
app.include_router(memories.router, prefix="/api/v1")
app.include_router(internal.router, prefix="/api/v1")
app.include_router(capture.router, prefix="/api/v1")
app.include_router(questions.router, prefix="/api/v1")
app.include_router(kp.router, prefix="/api/v1")
app.include_router(learn.router, prefix="/api/v1")
app.include_router(stats.router, prefix="/api/v1")
app.include_router(profile.router, prefix="/api/v1")
app.include_router(providers.router, prefix="/api/v1")
app.include_router(settings_api.router, prefix="/api/v1")
app.include_router(uploads.router, prefix="/api/v1")


@app.get("/health")
def health():
    db_state = "ok"
    tables = 0
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
        tables = len(inspect(engine).get_table_names())
    except Exception as exc:  # noqa: BLE001
        db_state = f"error: {str(exc)[:200]}"
    return {
        "ok": db_state == "ok",
        "db": db_state,
        "schema_version": APP_VERSION,
        "tables": tables,
        "model": settings.database_url.rsplit("/", 1)[-1],
    }


if settings.web_path.exists():
    app.mount("/", StaticFiles(directory=str(settings.web_path), html=True), name="web")
