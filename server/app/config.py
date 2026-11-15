"""配置：全部来自 server/.env 或环境变量。"""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVER_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=SERVER_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgresql+psycopg://postgres@127.0.0.1:5433/xiaoman_dev"
    app_token: str = ""
    data_dir: str = "../data/uploads"
    web_dir: str = "../web"
    auto_create: int = 0

    # 上下文与生成
    history_limit: int = 20
    history_token_budget: int = 110000
    pi_gateway: str = "http://127.0.0.1:8791"   # Pi 网关（唯一 AI 路径）
    internal_token: str = "dev-internal-token"
    ocr_provider: str = "mock"      # mock | cloud | local
    ocr_api_key: str = ""           # 云 OCR 的 key，留空则用 provider 的 key
    deepseek_api_key: str = ""      # 环境变量 DEEPSEEK_API_KEY

    # 阿里云切题（每页一张 → 结构化题目）
    papercut_auth: str = ""         # appcode（云市场）| aksk（官方 OpenAPI）
    papercut_appcode: str = ""      # 云市场 APPCODE
    papercut_endpoint: str = ""     # 云市场调用地址（控制台复制）；官方默认 edututor.cn-hangzhou.aliyuncs.com/service/cutApi
    papercut_workspace_id: str = "" # 官方 OpenAPI 的百炼业务空间 id
    aliyun_ak_id: str = ""
    aliyun_ak_secret: str = ""
    papercut_openapi_endpoint: str = ""  # 默认 edututor.cn-hangzhou.aliyuncs.com
    oss_bucket: str = ""               # 公网图床（官方切题要求 image 是 URL）
    oss_endpoint: str = ""             # 如 https://oss-cn-hangzhou.aliyuncs.com
    papercut_correct: bool = False     # 开矫正后坐标在矫正图上，复核框会偏；默认关
    message_char_cap: int = 8000
    default_max_tokens: int = 4096

    @property
    def data_path(self) -> Path:
        return (SERVER_DIR / self.data_dir).resolve()

    @property
    def web_path(self) -> Path:
        return (SERVER_DIR / self.web_dir).resolve()


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()