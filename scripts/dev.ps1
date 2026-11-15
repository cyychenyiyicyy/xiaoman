# 小满 Xiaoman · 本地开发一键启动
# 用法： pwsh -File scripts/dev.ps1
# 起：PostgreSQL 18（5434）→ 迁移 → Pi 网关（8791）→ API（8787，--reload）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$dataDir = Join-Path $root 'data\pgdata18'
$logFile = Join-Path $root 'data\pg18.log'
$venv = Join-Path $root 'server\.venv\Scripts\python.exe'
$agentDir = Join-Path $root 'agent'

if (-not (Test-Path $pgBin)) { throw "找不到 PostgreSQL 18：$pgBin" }
if (-not (Test-Path $dataDir)) {
  Write-Host "[1/5] 初始化数据目录"
  & (Join-Path $pgBin 'initdb.exe') -D $dataDir -U postgres --encoding=UTF8 --locale=C --auth=trust | Out-Null
}

if (-not (Get-NetTCPConnection -LocalPort 5434 -State Listen -ErrorAction SilentlyContinue)) {
  Write-Host '[2/5] 启动 PostgreSQL 18（5434）'
  $argLine = "start -D `"$dataDir`" -o `"-p 5434`" -l `"$logFile`" -w"
  Start-Process -FilePath (Join-Path $pgBin 'pg_ctl.exe') -ArgumentList $argLine -WindowStyle Hidden
  Start-Sleep -Seconds 4
}

$exists = & (Join-Path $pgBin 'psql.exe') -p 5434 -U postgres -d postgres -tAc "select 1 from pg_database where datname='xiaoman_dev'"
if (-not $exists) {
  Write-Host '[3/5] 建库 xiaoman_dev'
  & (Join-Path $pgBin 'createdb.exe') -p 5434 -U postgres xiaoman_dev
}

Write-Host '[3/5] 跑迁移'
Push-Location (Join-Path $root 'server')
& $venv -m alembic upgrade head
Pop-Location

# Pi 网关：模型 key 从库里取（不写进文件）
$key = (& (Join-Path $pgBin 'psql.exe') -p 5434 -U postgres -d xiaoman_dev -tAc "select api_key from llm_provider where base_url like '%deepseek.com%' limit 1")
if ($key) { $env:DEEPSEEK_API_KEY = $key.Trim() }
$env:PI_INTERNAL_TOKEN = 'dev-internal-token'
if (-not (Get-NetTCPConnection -LocalPort 8791 -State Listen -ErrorAction SilentlyContinue)) {
  Write-Host '[4/5] 启动 Pi 网关 → http://127.0.0.1:8791'
  Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $agentDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $root 'data\pi.out.log') -RedirectStandardError (Join-Path $root 'data\pi.err.log')
  Start-Sleep -Seconds 3
}

Write-Host '[5/5] 起 API → http://127.0.0.1:8787'
Push-Location (Join-Path $root 'server')
try { & $venv -m uvicorn app.main:app --host 0.0.0.0 --port 8787 --reload } finally { Pop-Location }