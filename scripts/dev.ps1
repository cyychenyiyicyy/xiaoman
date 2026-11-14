# 小满 Xiaoman · 本地开发一键启动
# 用法： pwsh -File scripts/dev.ps1
# 做的事：起本机 PostgreSQL 18（5434）→ 建库 → 跑迁移 → 起 API（8787，带 --reload）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$dataDir = Join-Path $root 'data\pgdata18'
$logFile = Join-Path $root 'data\pg18.log'
$venv = Join-Path $root 'server\.venv\Scripts\python.exe'

if (-not (Test-Path $pgBin)) { throw "找不到 PostgreSQL 18：$pgBin" }
if (-not (Test-Path $dataDir)) {
  Write-Host "[1/4] 初始化数据目录 $dataDir"
  & (Join-Path $pgBin 'initdb.exe') -D $dataDir -U postgres --encoding=UTF8 --locale=C --auth=trust | Out-Null
}

$listening = Get-NetTCPConnection -LocalPort 5434 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Write-Host '[2/4] 启动 PostgreSQL 18（5434）'
  $argLine = "start -D `"$dataDir`" -o `"-p 5434`" -l `"$logFile`" -w"
  Start-Process -FilePath (Join-Path $pgBin 'pg_ctl.exe') -ArgumentList $argLine -WindowStyle Hidden
  Start-Sleep -Seconds 4
}

& (Join-Path $pgBin 'psql.exe') -p 5434 -U postgres -d postgres -tAc "select 1" | Out-Null
$exists = & (Join-Path $pgBin 'psql.exe') -p 5434 -U postgres -d postgres -tAc "select 1 from pg_database where datname='xiaoman_dev'"
if (-not $exists) {
  Write-Host '[3/4] 建库 xiaoman_dev'
  & (Join-Path $pgBin 'createdb.exe') -p 5434 -U postgres xiaoman_dev
}

Write-Host '[3/4] 跑迁移'
Push-Location (Join-Path $root 'server')
& $venv -m alembic upgrade head
Write-Host '[4/4] 起 API → http://127.0.0.1:8787'
try { & $venv -m uvicorn app.main:app --host 0.0.0.0 --port 8787 --reload } finally { Pop-Location }