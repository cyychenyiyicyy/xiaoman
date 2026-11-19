# 部署（单用户，自托管）

目标：手机 / 平板只填一个 IP 就能连上小满；不新开端口，不影响同一 IP 上已有的站点。

下面以 Ubuntu + Caddy + Docker PostgreSQL 为例。实际路径按机器调整。**不要提交 `.env`、数据库密码、Pi key。**

## 1. 代码与依赖

```bash
git clone https://github.com/cyychenyiyicyy/xiaoman.git /srv/xiaoman
cd /srv/xiaoman/server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
. .venv/bin/activate && alembic upgrade head
```

复制 `server/.env.example` 为 `server/.env`，填：
- `DATABASE_URL`（PostgreSQL）
- `PI_GATEWAY=http://127.0.0.1:8791`
- `INTERNAL_TOKEN` / `PAPERCUT_*` 等

## 2. PostgreSQL（Docker）

```bash
docker run -d --name xiaoman-pg --restart unless-stopped \
  -e POSTGRES_USER=xiaoman -e POSTGRES_PASSWORD='<random>' -e POSTGRES_DB=xiaoman \
  -p 127.0.0.1:5433:5432 \
  -v /srv/xiaoman-pgdata:/var/lib/postgresql/data \
  postgres:16-alpine
```

只绑定 `127.0.0.1`，不暴露公网。

## 3. Agent 网关

```bash
cd /srv/xiaoman/agent
# 需要 Node 20+；若默认 node 很旧，用绝对路径 / PATH 覆盖
export PATH=/home/ubuntu/node24/bin:$PATH
npm ci --omit=dev
# Gateway 需要 model key；可放 /srv/xiaoman/agent/.env（chmod 600）
# DEEPSEEK_API_KEY=...
# PI_INTERNAL_TOKEN=...  # 与 server/.env 的 INTERNAL_TOKEN 一致
# PI_FASTAPI=http://127.0.0.1:8790/api/v1
node server.mjs
```

## 4. systemd

`/etc/systemd/system/xiaoman-api.service`：

```ini
[Unit]
Description=Xiaoman API
After=network-online.target docker.service

[Service]
User=ubuntu
WorkingDirectory=/srv/xiaoman/server
EnvironmentFile=/srv/xiaoman/server/.env
ExecStart=/srv/xiaoman/server/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8790
Restart=always

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/xiaoman-gateway.service`：

```ini
[Unit]
Description=Xiaoman Pi Gateway
After=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/srv/xiaoman/agent
EnvironmentFile=/srv/xiaoman/agent/.env
ExecStart=/usr/local/node20/bin/node server.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now xiaoman-api xiaoman-gateway
```

API 只监听 `127.0.0.1:8790`，网关 `127.0.0.1:8791`，数据库 `127.0.0.1:5433`。

## 5. Caddy：同一 IP，按 UA 分流

在已有的 80/443 站点里加一段（放在根 `handle` 之前）：

```caddyfile
@xiaoman header User-Agent XiaomanAlpha*
handle @xiaoman {
    reverse_proxy 127.0.0.1:8790 {
        header_up Host {host}
        header_up X-Forwarded-Proto http
        header_up X-Real-IP {remote_host}
    }
}
```

APK 的 WebView UA 以 `XiaomanAlpha/0.2` 开头，所以：
- 小满 App → 自动到小满；
- 同一 IP 的普通浏览器 / 原有站点 → 不受影响；
- 不新增端口，也不占用 `/` 之外的路径。

> UA 不是安全边界：知道这个前缀的人也能访问。公网部署请加 Tailscale、反代 Basic Auth 或只允许内网。上线前务必改掉临时 SSH 密码。

## 6. 自检

```bash
curl -s http://127.0.0.1:8790/health
curl -s -A 'XiaomanAlpha/0.2' http://127.0.0.1/api/v1/profile
curl -s http://127.0.0.1/ | head   # 应该还是原有站点
```

如果 `caddy reload` 因 systemd 命名空间报 `226/NAMESPACE`，用 `systemctl restart caddy`；配置本身先 `caddy validate --config /etc/caddy/Caddyfile`。
