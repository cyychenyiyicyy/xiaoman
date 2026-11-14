# 个人自建 App 技术栈调研（2026 年 11 月）

> 场景：一个人用；Android 客户端 + 自建后端 API，部署在自己的 Linux 服务器；GitHub Actions 自动打包 APK（争取发 F-Droid 或 GitHub Releases）；Material Design 3 界面。
> 调研日期：2026-11-14/15。所有版本与价格均标注了来源与时间点。

---

## 0. 结论先行：推荐组合

| 层 | 选择 | 一句话理由 |
|---|---|---|
| Android 端 | **Kotlin + Jetpack Compose + Material3**（Compose BOM 2026.09.00+，material3 1.4.0 stable） | 官方路线、APK 最小、CI 最成熟、长期不会弃维护 |
| 本地存储 | **Room**（2.8.5 stable；Room 3.0 面向 KMP 重写中） | 单平台就选 Room，别提前上 Drift/SQLDelight |
| 网络 | **Ktor Client**（或 OkHttp+Retrofit）+ kotlinx.serialization | Kotlin 原生、多端通用 |
| 后端 | **Python 3.11+ / FastAPI 0.162.x + SQLAlchemy 2 + Pydantic v2** | 一个人写最快、AI 生态好、FastAPI 升得勤 |
| 数据库 | **PostgreSQL 18.x + pgvector 0.8.7**；纯本地数据上 **SQLite** | 一个容器搞定关系+向量；不碰 Neo4j / SurrealDB |
| 定时任务 | **APScheduler**（进程内）或 **cron / systemd timer** | 单用户不配 Redis 队列 |
| 鉴权 | **Tailscale（个人免费版）+ Tailscale Serve** 兜底 **Caddy Basic Auth + API Key** | 单用户最省事的两层 |
| 部署 | **Docker Compose + Caddy**（自动 HTTPS） | Caddy 自动签发/续期 Let's Encrypt |
| 监控 | **Uptime Kuma** + **healthchecks.io** | 一个探活一个盯 cron |
| 推送 | **自建 ntfy**（服务端 + Android 客户端）；应用内消息走 **WebSocket 长连接** | FCM 在国内不可用；ntfy 自建可靠 |
| 分发 | **GitHub Releases（主）** + **F-Droid（副，开源才做）** + 直接 APK | F-Droid 审核慢、只收 FOSS |

---

## 1. Android 技术选型对比

### 1.1 四个候选的横向对比

| 维度 | Kotlin + Compose（官方） | Flutter | React Native / Expo | Kotlin Multiplatform |
|---|---|---|---|---|
| 2026-11 稳定版 | Compose BOM 2026.09.00；material3 **1.4.0** stable，1.5.0-rc01（AndroidX release notes, 2026-11-12） | **3.47**（2026-08 发布；3.47.9 为 2026-10-29 最新补丁） | RN **0.86** + Expo SDK **57**（2026-06-30）；SDK 58/RN 0.88 在路上 | Compose Multiplatform **1.13.0-beta02**（2026-11-12），KMP 官方稳定 |
| APK 体积 | 最小。原生空壳 ~1.4–2.9 MB（R8+资源压缩后；Ekko Pad 实测 2.90 MB） | 最小 ~8–16 MB（自带渲染引擎），release 常见 16–22 MB | 中等 ~10–22 MB（Hermes），裸工程可到 50–80 MB | 与 Compose 相当（共享 UI 时） |
| 学习曲线 | **最高**（Kotlin + 声明式 + 重组心智模型） | 中（Dart 简单，UI 全自己画） | **最低**（若已会 JS/TS） | 高（Kotlin + Compose + Gradle KMP 三件套） |
| GitHub Actions 构建 | **最成熟**：`gradle/actions/setup-gradle`（v5.x）缓存 + Android SDK 预装 | 需自己装 Flutter SDK，缓存较重 | Android 端 OK；官方推荐把构建交给 **EAS Workflows**（Expo 自家 CI） | Android 侧同 Compose；iOS 侧需 macOS runner（$0.062/min） |
| 第三方库健康度 | 最好（AndroidX 官方背书 + KMP 化进行中） | 好（pub.dev ~48k 包），但 **3.47 起 Material/Cupertino 拆成独立包 `material_ui` 1.0**，SDK 内旧库已冻结并将弃用 | 生态最杂、版本碎片化 | 库本身少，官方库在补齐（Room 3.0 专为 KMP 重写） |
| F-Droid 可收录 | ✅ 最好（无 GMS 依赖即可） | ✅ 可以，但构建脚本要重写（Flutter 版常需 `sudo:`/改 CMake） | ⚠️ 勉强（Hermes/Metro 产物 + 依赖闭源库多） | ✅ 同 Compose |

### 1.2 结论：为什么选 Compose

**「单人维护 + 长期项目 + 自建 API」这个前提，Kotlin + Compose 的三个硬优势是决定性的：**

1. **CI 最短、最可靠。** `ubuntu-latest` runner 自带 JDK 17 + Android SDK，`gradle/actions/setup-gradle` 一行搞定依赖缓存；Flutter 需要额外装 SDK（约多 3–5 分钟/次），RN 若用 EAS 就多一个外部服务和账号依赖。
2. **APK 体积差一个数量级。** 你是自用/小众分发，2.9 MB vs 16 MB 的差距直接决定下载与安装成功率。
3. **依赖长期维护有官方承诺。** AndroidX 每年多轮 stable；Room 3.0（2026-03 起 alpha）已明确转向 KMP + JS/WASM；Compose 本身在 1.13.0-rc（2026-11-04）。

**Flutter 的唯一强项是「未来要上 iOS」**，但 Kotlin Multiplatform 在这条路上更正统：Google 官方支持 KMP 共享业务逻辑（[developer.android.com/kotlin/multiplatform](https://developer.android.com/kotlin/multiplatform)），Compose Multiplatform 1.13 已有 RC。但**现在就上 KMP 是过度设计**——它把学习曲线从「Kotlin + Compose」拉长到「Kotlin + Compose + KMP + Compose Multiplatform」，而 iOS 的需求是假设性的。

> **务实建议：** 现在写 **纯 Android + Compose**，但从第一天起把「业务逻辑/网络/数据模型」放进纯 Kotlin 模块（不做任何 Android 依赖），将来要 iOS 时，用 KMP 把这些模块搬走、UI 用 Compose Multiplatform 重写——这是成本最低的演进路径。

**Flutter 3.47 的新变化值得注意**：`material_ui` / `cupertino_ui` 成为独立包（1.0，2026-08），SDK 内旧 Material 库已冻结、计划在 2026 年 11 月稳定版正式弃用（Flutter release notes / breaking-changes, 2026-11）。如果你选 Flutter，要立刻跟进这次迁移，否则后面会有一波 break。

---

## 2. GitHub Actions 打包 Android：完整要点

### 2.1 签名密钥管理

**做法（GitHub Secrets + base64 keystore）：**

```bash
# 本地一次性生成，永久备份（丢了就得重新上架，无法更新）
keytool -genkey -v -keystore release.keystore -alias app \
  -keyalg RSA -keysize 4096 -validity 10000 -storetype PKCS12

# 转 base64 存进 Secret：KEYSTORE_BASE64
base64 -w 0 release.keystore > release.keystore.b64
```

Secrets 四件套：`KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`。

CI 中还原并签名的推荐写法——**不改 `build.gradle`，用 `-Pandroid.injected.signing.*` 注入**，密码不进仓库（AppForShare 指南, 2026-11-01）：

```yaml
- name: Restore keystore
  run: |
    echo "${{ secrets.KEYSTORE_BASE64 }}" | base64 -d > $RUNNER_TEMP/release.keystore
- name: Build signed release APK
  run: |
    ./gradlew assembleRelease \
      -Pandroid.injected.signing.store.file="$RUNNER_TEMP/release.keystore" \
      -Pandroid.injected.signing.store.password="${{ secrets.KEYSTORE_PASSWORD }}" \
      -Pandroid.injected.signing.key.alias="${{ secrets.KEY_ALIAS }}" \
      -Pandroid.injected.signing.key.password="${{ secrets.KEY_PASSWORD }}"
```

**签名方案与 Play App Signing**：Android 现在默认 v2+v3（v1 仅对 API<24 兼容），v4 用于增量安装（apksigner）。只要上 Google Play，你手上的密钥是 **upload key**（可申请重置），Play 用自己持有的 **app signing key** 重签（AppForShare, 2026-11-01）。**自建分发则直接用自己的 key 签，用户必须能装同一签名的新版**——所以密钥离线多备份。

### 2.2 用哪些 action

| 用途 | Action | 备注 |
|---|---|---|
| 检出 | `actions/checkout@v4` | |
| JDK | `actions/setup-java@v4`（temurin 17/21） | runner 自带，但显式声明更稳 |
| Gradle + 缓存 | **`gradle/actions/setup-gradle@v4/v5`** | v5 提供 `gradle-actions-caching` 增强缓存，**公开仓库免费**（gradle/actions docs, 2026-10-21）；v6 将引入更多缓存provider |
| 产物上传 | `actions/upload-artifact@v4` | `retention-days` 1–90 |
| 下载产物 | `actions/download-artifact@v4` | 跨 job 传 APK |
| 发 Release | **`softprops/action-gh-release@v2`** | v2.6.2 是 v2 最后版本、不再维护（2025-09-19 起 GitHub Actions 弃用 Node 20 runtime），**新项目建议直接用 v3**（v3.0.4 已发布, 2026-11-05）；或官方 `gh release create` CLI |
| 备选 | `r0adkll/release-github-action` | 更老，权限模型受限，新项目不推荐 |

> **你现有的 `work/2026-11-08-ekko平板app打包/app/.github/workflowss/android.yml` 可直接升级三处**：`actions/upload-artifact@v4` ✅ 保持；`softprops/action-gh-release@v2` → **v3**；`gradle/actions/setup-gradle@v4` → 保持或升 v5（拿增强缓存）。另外目前是 `assembleDebug` + `github.run_number` 造版本号，建议改成 **release 签名 + git tag 驱动**（见 2.4）。

### 2.3 APK vs AAB

- **`assembleRelease` → `.apk`**：可下载直接安装，适合自用/直链/F-Droid 二进制仓库。
- **`bundleRelease` → `.aab`**：Google Play 专用格式，手机上装不了。
- 同一个 workflow 里两者都产出、同一把 key 签，versionCode 对齐即可。
- R8（`minifyEnabled true`）+ 资源压缩能把 APK 压掉 50%+；Compose 项目开 R8 是默认收益。

### 2.4 版本号管理（推荐 git tag 驱动）

```
git tag v1.5.0 && git push origin v1.5.0
```
CI 里解析：
```yaml
- id: ver
  run: |
    TAG="${GITHUB_REF#refs/tags/v}"
    echo "name=$TAG" >> $GITHUB_OUTPUT
    echo "code=$(echo $TAG | tr -d '.' | cut -c1-8)" >> $GITHUB_OUTPUT   # 1.5.0 → 150
```
或用 `gradle.properties` 里单一来源 + `git describe` 推导。

**铁律：`versionCode` 必须全局单调递增，且 F-Droid、Play、GitHub Releases 三处一致**——F-Droid 官方文档明确提醒 `applicationId` 一旦确定基本不可改，`versionCode` 必须永远递增（[F-Droid Quick Start Guide](https://f-droid.org/en/docs/Submitting_to_F-Droid_Quick_Start_Guide), 2026-11-08）。

### 2.5 发到 F-Droid：格式与硬性要求

**F-Droid 的信任模型：它自己从源码构建，然后签名分发**（[F-Droid Reproducible Builds](https://f-droid.org/docs/Reproducible_Builds), 2026-11-12）。从 2023-09 起，若你的构建可复现，F-Droid 会**用上游开发者自己的签名**分发，证明「这就是我想发布的」。

**硬性要求（Inclusion Policy / Quick Start Guide, 2026-11）：**
1. 源码公开 + **FOSS 许可证文件**；
2. **依赖必须全是 FOSS**——Firebase、GMS 是典型反例；
3. 干净 checkout 可直接构建，无手工步骤；
4. 不打包专有二进制 blob。

**元数据格式（重要更新）：** 官方主仓库现在**只认 `.yml`（YAML）**——`.txt` 与 `.json`（即所谓 fastdroid.json）**已于 2020 年被移除**（[fdroidserver metadata docs](http://fdroid.gitlab.io/fdroidserver/fdroidserver.metadata.html), 2026-06-29；[Build Metadata Reference](https://f-droid.org/en/docs/Build_Metadata_Reference), 2026-11-09)）。不要再写 fastdroid.json。

推荐做法：**在自家仓库里放一个 `metadata/<applicationId>.yml`**，然后向 `fdroid/fdroiddata` 提 MR（比自己写全量 metadata 更省事，见 [Inclusion How-To](https://f-droid.org/en/docs/Inclusion_How-To), 2026-03-21）。示例：

```yaml
Categories: [Internet]
License: GPL-3.0-or-later
SourceCode: https://github.com/you/yourapp
RepoType: git
Repo: https://github.com/you/yourapp.git
Builds:
  - versionName: '1.5.0'
    versionCode: 150
    commit: v1.5.0
    subdir: app
```
配 `AutoUpdateMode: Version` + `UpdateCheckMode: Tags`，之后打 tag 就能自动出新版本。

**审核时长：人工志愿审核，常常「一个月以上」**（F-Droid forum, 2020-07-08）——所以 F-Droid 适合当**长期分发渠道**，不适合当「今天要发出去」的通道。**GitHub Releases 才是主通道。**

**如果不想被审核：自建 F-Droid 仓库。** 用 `fdroidserver` 工具自建 repo（[Setup an F-Droid App Repo](https://f-droid.org/docs/Setup_an_F-Droid_App_Repo), 2026-10-31），F-Droid 客户端可添加任意第三方 repo（IzzyOnDroid 就是这么做的）。代价：用户要手动加源、没自动更新。

### 2.6 多渠道分发策略

| 渠道 | 门槛 | 更新体验 | 建议 |
|---|---|---|---|
| **GitHub Releases** | 零 | 手动下载 | ✅ **主通道**，配合 App 内「检查更新」提示 |
| **直接 APK（对象存储/服务器）** | 零 | 手动 | 备用，App 内可查版本 |
| **F-Droid 官方仓库** | 开源 + FOSS 依赖 + 审核 | ✅ 自动更新 | 有条件再做；用 `AutoUpdateMode` 走 tag |
| **自建 F-Droid repo** | 无 | 半自动 | 想自动更新又不想排队时用 |
| **Google Play** | 开发者账号 $25 一次性 | ✅ 自动 | 国内用户基本用不到，且 targetSdk 必须 ≥36（见下） |
| ~~其他应用市场~~ | — | — | 国内 ROM 厂商市场，个人应用基本不收 |

> ⚠️ **2026 年的两个硬约束，务必注意：**
> 1. **Google Play 要求新应用与更新必须 target Android 16 (API 36)**，自 2026-08-31 起（[Google Play target API 要求](https://support.google.com/googleplay/android-developer/answer/11926878), 2026-11-12）。你现有的 Ekko Pad 用的是 targetSdk 34——上 Play 会被拒，但走 GitHub/F-Droid 分发不受此限。
> 2. **Android 开发者验证（developer verification）**：从 2026-09-30 起，参与商店在巴西/印尼/新加坡/泰国等地区的认证设备上开始拦截未验证开发者的应用安装，**全球铺开目标 2027 年**（[developer.android.com/developer-verification](https://developer.android.com/developer-verification/guides), 2026-11-12）。**建议现在就去 Android Developer Console 注册开发者身份并占住包名**，避免将来装不上自己的 APK。

---

## 3. 后端技术栈推荐

### 3.1 语言 / 框架

| 选项 | 优势 | 劣势 | 判断 |
|---|---|---|---|
| **Python + FastAPI** | FastAPI **0.162.5**（2026-11-11 发布）迭代很勤；Pydantic v2 自动出 OpenAPI；AI/模型调用生态最好（你的 App 大概率带 LLM） | 类型安全靠 mypy，异步心智负担 | ✅ **推荐** |
| TypeScript + NestJS | 全栈一套类型；tRPC 端到端类型 | NestJS 样板多，单人项目偏重；与 Android 端不共享类型 | 可选 |
| Go + chi/gin | 单二进制、内存小、部署最简 | 开发速度慢；LLM 生态弱；SQL 迁移/ORM 生态弱 | 仅当「想极致省资源」 |

**理由：** 你的后端是「自建 API + 可能调 LLM」——Python 的生态优势压倒性。FastAPI 直接给你 OpenAPI 文档，Android 端可以用 OpenAPI 生成客户端，类型不用手抄。

### 3.2 数据库

| 选项 | 判断 |
|---|---|
| **PostgreSQL 18.x + pgvector 0.8.7** | ✅ **推荐**。关系数据 + 向量检索 + 全文都在一个 ACID 引擎里，一个容器搞定；PostgreSQL 18.7 已于 2026-11-12 发布（PostgreSQL release notes）；pgvector 0.8.7 修掉了 IVFFlat 索引构建的缓冲区溢出 CVE-2026-103484（2026-10-05） |
| SQLite（服务端）+ sqlite-vec | ✅ 数据量小/纯本地时更省。sqlite-vec 适合 local-first 桌面/移动端；服务器端就用 PostgreSQL，别两套 |
| SurrealDB | ❌ **不建议**：核心是 **BSL 1.1 源码可用**，非商业自建可以，但「不能作为 Database Service」是道坎（[SurrealDB License FAQ](https://surrealdb.com/license), 2026-10-17）；生态和文档不如 PG |
| CouchDB | ❌ 单用户用不上，运维心智成本高 |
| **Neo4j Community** | ❌ **不值得**。GPLv3 免费、单实例无集群（[reviewramble 2026-10-26](https://reviewramble.com/github-repos/neo4j)）；但多一个 JVM 服务、备份、Cypher 学习成本。**先用 PG 的递归 CTE / 边表**，真需要再上 |

### 3.3 定时任务 / 队列

| 方案 | 适用 |
|---|---|
| **cron / systemd timer** | ✅ 首选。定时跑脚本、备份、清理。零依赖，挂了容器也能跑 |
| **APScheduler** | ✅ 任务调度要写在应用进程里时用（单用户规模它最省事） |
| Celery | ❌ 需要 Redis/RabbitMQ + worker + beat，单用户纯负担 |
| arq / BullMQ | ❌ 同上，要 Redis |
| pg-boss | ⚠️ 若已用 PostgreSQL，它比 Celery 轻；但仍需一个 worker 进程 |

**结论：单用户不要引入消息队列。** 需要「后台任务」时，FastAPI 里起一个 `BackgroundTasks` 或独立的 asyncio worker 循环即可。

### 3.4 单用户鉴权（最省事）

**推荐两层叠加：**

1. **第一层（网络面）：Tailscale。** 个人版 **$0，最多 6 用户、设备不限、50 个 tagged resources**（[tailscale.com/pricing](https://tailscale.com/pricing), 2026-11-09；2026-04-08 起免费版从 1 用户扩到 6 用户）。配 **Tailscale Serve** 把服务只在 tailnet 内暴露，**服务器 443 端口对公网完全关闭**。这是最省事也最安全的一层。
2. **第二层（应用面）：Caddy 反代 Basic Auth + App 内 API Key/JWT。** 这样即使将来要走公网（F-Droid 用户、给别人用），App 里也能带上密钥。

**其它选项对比：**
- **Cloudflare Access**：适合「浏览器访问 + 多用户」，但要在 App 里做 OAuth/PKCE 流程，对原生 App 是负担。**Cloudflare Tunnel 本身免费且不限流量**（2026-07-28 起完全免费，[bex.co](https://bex.co/blog/2026/07/28/cloudflare-tunnel-free-zero-open-ports-ingress)）——如果你要公网域名 + 自动 HTTPS，这是 Caddy 之外的免费替代。
- **反代 Basic Auth**：最省事，但明文 base64，务必走 HTTPS。
- **Passkey/WebAuthn**：体验好但实现成本高，单用户不值得。

### 3.5 部署

**Docker Compose + Caddy**，Caddy 自动申请/续期 Let's Encrypt 证书，零 cron（[Caddy 自动 HTTPS 实践](https://dev.to/denis0wn/automatic-https-for-your-dockerized-app-with-caddy-442h), 2026-09-02）。相比 Nginx+certbot，少一套手写配置和续期 cron。

```yaml
# docker-compose.yml（骨架）
services:
  api:   { build: ., environment: DATABASE_URL: postgres://... }
  db:    { image: pgvector/pgvector:pg18 }
  caddy: { image: caddy:2-alpine, ports: ["443:443","80:80"], volumes: ["./Caddyfile:/etc/caddy/Caddyfile", caddy_data:/data] }
volumes: { caddy_data: }
```
Caddyfile 三行：
```
api.example.com {
  reverse_proxy api:8000
  basicauth { * } h2 <bcrypt>
}
```

**备份**：Postgres `pg_dump` + 异地对象存储，用 cron 跑，配 healthchecks.io 监控。

### 3.6 监控

- **Uptime Kuma**：主动探活 HTTP/TCP，看服务是否在线 + 证书到期。
- **healthchecks.io**：被动心跳，专盯 cron/定时任务是否按时跑（dead man's switch）。
- **Beszel**：轻量主机/容器资源指标（CPU/RAM/磁盘），比 Prometheus 轻得多。
- 两者分工明确：**Kuma 主动轮询服务，healthchecks 被动等 cron 报到**（[selfhosting.sh 对比](https://selfhosting.sh/compare/uptime-kuma-vs-healthchecks), 2026-01-03）。

---

## 4. 移动端如何调用后端

### 4.1 REST vs GraphQL vs tRPC

**选 REST + OpenAPI。** 理由（[pavlealeksic.com 2026-03-12](https://pavlealeksic.com/blog/rest-graphql-trpc-2026)）：REST 对公开 API 和「客户端不受你控制」的场景是正解，学习曲线最低，OpenAPI 3.1 已与 JSON Schema 对齐，任何客户端都能生成代码。

- **GraphQL**：适合「多个客户端要不同数据切片」；单人 App 没有这个场景，反而多一层 schema + 缓存一致性负担。
- **tRPC**：只在「同一个 TypeScript 团队同时写前后端」时最优。你的客户端是 Kotlin，用不上。

**实现**：`FastAPI` 自动出 `/openapi.json` → Android 端用 **Ktor Client + kotlinx.serialization**，或用 Retrofit + OpenAPI Generator 生成 Kotlin 数据类。

### 4.2 离线缓存

**选 Room。** 2026-11 状态：
- **Room 2.8.5** stable（2026-09-09）；**Room 3.0** 正在重写，2026-03 首个 alpha，主打 KMP + JS/WASM，移除 Java AP/KAPT，仅保留 KSP（[Room 3.0 官方博客](https://android-developers.googleblog.com/2026/03/room-30-modernizing-room.html), 2026-05-22）。**注意 3.0 尚未 stable，先别用 alpha。**
- **Drift 2.35.4**（2026-11-11）是 Dart 生态的，不是 Kotlin——除非你选 Flutter。
- **SQLDelight**：KMP 场景更合适（从 SQL 生成 Kotlin），纯 Android 项目 Room 更顺。

**同步模式（offline-first）：** 网络层**永远不直接喂 UI**——写入一律先落 Room，UI 观察 Room（Flow），网络层只负责把远端变化写回 Room（[xdroid.dev 离线优先指南](https://xdroid.dev/2026/04/offline-first-android-architecture.html), 2026-10-27）。冲突解决用「本地 outbox 表 + 幂等操作 ID + 服务端 last-write-wins 或 CRDT」，比强行做通用同步引擎省事得多。定时同步用 **WorkManager** 的 `PeriodicWorkRequest`（最短 15 分钟）。

### 4.3 推送通知：这是自建 App 最需要想清楚的一环

**先排除两个选项：**
- ❌ **FCM 在中国大陆不可用。** 两处同时坏：Google 的 FCM 端点被墙，且国产 ROM 不带 Google Play Services，FCM 依赖它收推送（[Chinaready FCM 分析](https://landscape.chinaready.co/alternatives/firebase-cloud-messaging), 2026-10-25）。你手机若无 GMS，FCM token 都拿不到。
- ❌ **OneSignal 免费档 2026 年已缩水到 1,000 MAU**（新用户 2026-09-01 起、存量 2026-10-01 起生效，[OneSignal 官方博客](https://onesignal.com/blog/whats-changing-on-onesignals-free-plan), 2026-09-01)）。单用户够用，但它是**第三方托管 + 仍依赖 FCM**，解决不了国内问题。

**推荐方案，按可靠性排序：**

1. **✅ 自建 ntfy（首选）**
   - 服务端 `ntfy server v2.37.2`（2026-11-03），Android 客户端 `v1.25.2`（2026-07-23），都在 F-Droid 上（[ntfy release notes](https://docs.ntfy.sh/releases), 2026-11-08）。
   - **客户端状态澄清：没有废弃，仍在维护**（2026-07-23 刚发了 v1.25.2，2026-11-07 还在推 WebSocket ping 间隔优化等提交）。它同时是 **UnifiedPush 分发器**，也支持 Web Push / PWA（[UnifiedPush ntfy 文档](https://unifiedpush.org/users/distributors/ntfy/), 2026-09-24）。
   - **用法：你的后端 `POST https://ntfy.yourdomain.com/topic` 推消息，手机装 ntfy 客户端订阅该 topic。** 这是纯自建、不碰 Google、国内可用、且有兜底（无 instant delivery 时会降级轮询，延迟可能到数分钟——[ntfy phone 文档](https://docs.ntfy.sh/subscribe/phone), 2026-11-12）。
   - **重要：UnifiedPush 文档仓库已于 2025-05-05 被归档为只读**（[UnifiedPush/documentation](https://github.com/UnifiedPush/documentation)），说明 UnifiedPush 生态整体动能减弱——所以别把它当唯一依赖，当作 ntfy 客户端的一个额外能力。
2. **✅ 应用内长连接（最可靠的应用内消息）**
   - App 内 WebSocket 直连你的后端（Gunicorn/Uvicorn 支持 WebSocket），配合 Postgres **LISTEN/NOTIFY** 或 Redis pub/sub 触发。**这才是「AI 回复完成」这类消息的正确通道**——你现有的 Ekko Pad 已经是「前台服务 + WebView + 原生通知」的路子。
   - Android 侧用 **OkHttp WebSocket**（自带心跳/重连），或 Ktor Client WebSockets。
3. **✅ Gotify**（自建推送服务器，Go 写的单二进制）
   - REST 发送 + WebSocket 实时 + Android 客户端（`gotify_flutter` 等），**不需要 Firebase 或 APNs**（[selfhostable.dev 2026-04-01](https://selfhostable.dev/blog/gotify-push-notifications)）。相比 ntfy 它的 HTTP API 更像传统推送服务。**缺点：生态小、客户端更新不如 ntfy 活跃。**
4. ⚠️ **MQTT（Mosquitto/HiveMQ）**：如果你要「设备在线/离线状态 + 双向控制」，MQTT 是标准解。日常消息通知不如 ntfy 省事。

> **一句话：** *通知 App 收到的东西* 用 **ntfy**；*App 自己界面内的实时消息* 用 **WebSocket 长连接**。不要指望 FCM。

---

## 5. 界面设计：Material 3

### 5.1 动态取色（Material You）

- **动态取色本身没有被弃用**，官方文档仍在推荐（[developer.android.com 动态颜色](https://developer.android.com/develop/ui/views/theming/dynamic-colors), 2026-11-12）。
- **Android 16 引入的是新东西，不是取消动态色：**
  - **Material 3 Expressive** 成为 Android 16 的设计语言，Compose 已有对应实现（[Compose M3 文档](https://developer.android.com/develop/ui/compose/designsystems/material3), 2026-11-12）。**注意：M3 Expressive 在 material3 1.5.0 里，1.4.0 stable 还没有**（[m3exp-web SOURCES.md](https://github.com/kyra-labs/m3exp-web/blob/main/SOURCES.md), 2026-11-13）——想要 Expressive 就等 1.5.0 stable，或先用 1.5.0-beta/rc。
  - **Android 16 QPR2 强制主题化图标**，App 不能 opt out，系统会自动用彩色滤镜生成单色图标（[9to5Google](https://9to5google.com/2025/09/16/android-16-auto-themed-icons-apps-cant-opt-out), 2025-09-16）。**所以务必提供 `monochrome` 图层**（adaptive icon 的第三层），否则图标会被自动染色得很丑。
  - **Android 16 QPR2 还带来强制暗色模式**（对不原生支持暗色的 App 生效）——**你的 App 必须正确实现暗色模式**。

**Compose 落地写法：**
```kotlin
@Composable
fun AppTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colorScheme = if (darkTheme) dynamicDarkColorScheme(context)
                      else dynamicLightColorScheme(context)
    MaterialTheme(colorScheme = colorScheme, typography = M3Typography, content = content)
}
```
`dynamicLightColorScheme` / `dynamicDarkColorScheme` 内部已做 **API 31+ 才取色、低版本回退静态 M3 配色**（[anddev.org](https://anddev.org/article/material-3-dynamic-color-a-safer-compose-migration-path.html), 2026-10-27），无需自己判版本。

### 5.2 组件库选型

| 平台 | 选择 | 说明 |
|---|---|---|
| **Android（Compose）** | `androidx.compose.material3`（BOM 2026.09.00+）+ `material3-adaptive`（1.4.0-alpha03）做多尺寸适配 | 官方。`material3-adaptive` 还在 alpha，但 Jetpack 官方页面已推荐用它做自适应布局（[Jetpack 库列表](https://developer.android.google.cn/jetpack?hl=zh-cn), 2026-03-06） |
| **Web** | ⚠️ **Material Web（`@material/web`）已进入维护/被替代**，社区延续品是 **petal-elements**（[petal-elements 迁移文档](https://github.com/Saki340/petal-elements/blob/main/docs/migrating.md), 2026-11-13)）。如果 Web 端要求严格 M3，用 petal-elements 或手写 CSS 变量 | 
| **React** | **MUI v7**（[mui.com 升级到 v7](https://mui.com/material-ui/migration/upgrade-to-v7), 2026-10-23） | MUI 的 M3 支持度不如 Compose 原生，跨端视觉一致性要靠 token 手工对齐 |

### 5.3 跨端 UI 一致性怎么做

**做法：共享设计令牌（design tokens），不共享代码。**

- **在 Figma 用 Material Theme Builder 定义一套 token**（颜色、字阶、圆角、间距、动效曲线），导出成 JSON。
- **代码侧各自映射**：Compose 读 token 生成 `ColorScheme`/`Typography`；Web 侧转 CSS 自定义属性；Flutter 侧转 `ThemeData`。M3 的 token 体系本身就为此设计——[Material Web theming](https://material-web.dev/theming/material-theming) 明确用 design tokens 作为基础，映射到 CSS custom properties；[Figma 设计令牌指南](https://figma.com/resource-library/design-tokens) 也强调跨 Web/iOS/Android 的作用（2026-11-12）。
- **优先把 App 做成「Web 版 + Android 壳」还是「原生」？** 你的 Ekko Pad 就是 WebView 壳 —— 如果 App 主体是 Web，那 M3 一致性问题自动消失（同一套 CSS），Android 壳只负责原生能力（通知、前台服务、离线缓存）。**这在单人项目里是最省力的「一致性」方案。**

---

## 6. 成本估算

### 6.1 服务器

| 项 | 价格 | 来源 |
|---|---|---|
| Hetzner Cloud CX23（2 vCPU / 4GB / 40GB） | **≈ €5.99/月 ≈ $7.1**（含 IPv4 €0.5） | [vpsbenchmarks](https://vpsbenchmarks.com/hosters/hetzner/plans/cx23), 2026-11-02 |
| Hetzner 最低 CAX11（ARM） | €3.79–3.99/月 | [comparethestack](https://comparethestack.com/compare/vps/hetzner-vs-vultr), 2026-11-04 |
| Vultr 最低 vc2-1c-0.5gb | **$3.50/月**（另有 IPv4 费 $0.5） | 同上 |
| Vultr 1C1G | $6.00/月 | [vpsscouter](https://vpsscouter.com/compare/hetzner-vs-vultr), 2026-11-13 |
| 腾讯云轻量 2核2G | 新客 **68 元/年**；4核4G 秒杀 **38 元/年**（每日 10:00/15:00 限量）；日常价 780 元/年 | [腾讯云社区 2026-11-11](https://cloud.tencent.com/developer/article/2776128) |
| 域名 | ≈ $10–15/年（.com/.dev） | — |
| Cloudflare Tunnel | **$0**（2026-07-28 起不限流量、不限隧道数） | [bex.co](https://bex.co/blog/2026/07/28/cloudflare-tunnel-free-zero-open-ports-ingress) |
| Tailscale | **$0**（个人版 6 用户） | [tailscale.com/pricing](https://tailscale.com/pricing), 2026-11-09 |
| F-Droid 托管 | **$0** | [f-droid.org](https://f-droid.org/zh_Hans/), 2026-10-02 |

**推荐：腾讯云轻量 2核2G 68 元/年**（约 $0.9/月）或 **Hetzner CX23 ≈ $7/月**。单用户 + Docker Compose，2C2G 起步就够。

### 6.2 GitHub Actions 额度

- **公开仓库 + 标准 runner：完全免费、无限分钟**（[GitHub Actions billing docs](https://docs.github.com/enterprise-cloud@latest/billing/managing-billing-for-github-actions/about-billing-for-github-actions), 2026-05-16）。
- **私有仓库（Free 个人计划）：2,000 Linux 分钟/月 + 500 MB 产物存储**（[cicdcalculator](https://cicdcalculator.com/github-actions-free-tier), 2026-06-29）。
- **超出后单价**：Linux 2核 $0.006/min、Linux 1核 $0.002/min、arm64 $0.005/min、macOS $0.062/min（[GitHub runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing.md), 2026-10-19）。**2026-01-01 起 GitHub 托管 runner 降价最多 39%**，免费额度不变（[github/roadmap#1196](https://github.com/github/roadmap/issues/1196), 2025-12-16）。
- **产物存储**：默认保留 90 天（可配 1–90 天）；Free 账户 artifact 额度 500 MB，与 Packages 共享，超出 $0.25/GB·月（[latchkey.dev](https://latchkey.dev/learn/cost/github-actions-cache-and-artifact-storage-cost), 2026-09-21）。
- **产物存储与 GitHub Packages 共享 500 MB 额度**，所以只上传需要的 APK，且 `retention-days: 7` 就够，别每次推都留 90 天。

**结论：完全够用。** 一次 Compose release 构建约 3–8 分钟。私有仓库每天构建一次 = 约 150 分钟/月，远低于 2000 分钟。**公开仓库则一分钱不花**（注意：公开仓库意味着源码公开，这正好与 F-Droid 收录的要求一致——**如果打算上 F-Droid，仓库就设为公开，两件事一起解决**）。

### 6.3 模型 API 成本

**DeepSeek 2026-08-17 起改为峰谷分时定价**（高峰 = 北京时间 9:00–12:00、14:00–18:00，闲时为高峰一半）（[新浪财经](https://finance.sina.com.cn/jjxw/2026-08-14/doc-inineywf3244451.shtml), 2026-08-14；[官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md), 2026-11-05）：

| 模型 | 闲时 输入 | 闲时 输出 | 高峰 输入 | 高峰 输出 |
|---|---|---|---|---|
| deepseek-v4-flash | ¥1 / 1M | ¥2 / 1M | ¥2 | ¥4 |
| deepseek-v4-pro | ¥4.5 / 1M | ¥13.5 / 1M | ¥9 | ¥27 |

缓存命中输入可低至 ¥0.15/1M（pro 闲时）——**长系统提示词务必开缓存**。

其他参考（[llmabacus 2026-11-07](https://llmabacus.com/en/chinese-llm-api-pricing)；[nilesharma 2026-11-10](https://nilesharma.space/blog/chinese-ai-models)）：Qwen3.5 Flash 输入最便宜 $0.030/1M；GLM、Qwen、Kimi 旗舰输出普遍比 2025 贵 1.6–12 倍（**生成式溢价**）。

**单用户估算：** 假设每天 50 次对话 × 平均 3K 输入 + 800 输出 tokens ≈ 每月 4.5M 输入 / 1.2M 输出。
- DeepSeek v4-flash **闲时**：¥4.5 + ¥2.4 ≈ **¥7/月**（约 $1）
- DeepSeek v4-pro **闲时**：¥20 + ¥16 ≈ **¥36/月**（约 $5）
- 高峰时段翻倍 → pro 约 ¥72/月
- 走 OpenAI/Anthropic 则是几十美元量级，**没必要**。

**结论：模型成本 ¥5–70/月，比服务器还便宜一个量级。真正的成本是时间。**

### 6.4 总成本

| 项 | 月成本 |
|---|---|
| 服务器（腾讯云轻量 2C2G，摊年） | ≈ ¥5.7（68 元/年） |
| 域名 | ≈ ¥7/月（$10/年） |
| Tailscale + Cloudflare Tunnel | ¥0 |
| GitHub Actions（公开仓库） | ¥0 |
| F-Droid 托管 | ¥0 |
| DeepSeek v4-flash（闲时日常） | ≈ ¥7 |
| **合计** | **≈ ¥20/月（$3），峰谷高峰/用 pro 模型时 ≈ ¥90/月** |

---

## 7. 落地清单（建议顺序）

1. **今天**：去 Android Developer Console 注册开发者身份 + 占住 `applicationId`（防 2027 年开发者验证拦安装）。
2. **今天**：把 Android 仓库设为 **public** + 加 FOSS 许可证（一步同时解决 F-Droid 收录和 Actions 无限额度）。
3. **本周**：Android 工程起 Compose + Material3（BOM 2026.09.00），后端起 FastAPI + PostgreSQL(pgvector) + Docker Compose + Caddy。
4. **本周**：写 `.github/workflows/android.yml`：checkout → setup-java → **setup-gradle(v5)** → 还原 keystore → `assembleRelease`（带 `-Pandroid.injected.signing.*`）→ upload-artifact（retention 7 天）→ **softprops/action-gh-release@v3**（tag 驱动 versionCode）。
5. **本月**：接入 Room 离线缓存 + Ktor Client；打通 ntfy（自建服务端 + F-Droid 客户端）。
6. **有余力**：写 `metadata/<applicationId>.yml` 提 fdroiddata MR；加 adaptive icon 的 `monochrome` 图层；等 material3 1.5.0 stable 上 M3 Expressive。

---

## 附：关键来源

- AndroidX release notes（Compose Material3 1.4.0 / 1.5.0-rc01、Room 2.8.5）— developer.android.com/jetpack/androidx/releases
- F-Droid：Inclusion Policy、Build Metadata Reference、Submitting Quick Start Guide、Reproducible Builds — f-droid.org/docs（均为 2026-11 页面）
- F-Droid 元数据格式变更（仅 .yml，移除 .txt/.json）— fdroid.gitlab.io/fdroidserver/fdroidserver.metadata.html, 2026-06-29
- GitHub Actions 计费与 runner 价格 — docs.github.com/en/billing/reference/actions-runner-pricing.md, 2026-10-19
- Android 开发者验证 — developer.android.com/developer-verification/guides, 2026-11-12
- Google Play target API 36 — support.google.com/googleplay/android-developer/answer/11926878, 2026-11-12
- ntfy 版本与状态 — docs.ntfy.sh/releases, 2026-11-08
- FCM 国内不可用 — landscape.chinaready.co, 2026-10-25
- OneSignal 免费档 1,000 MAU — onesignal.com/blog/whats-changing-on-onesignals-free-plan, 2026-09-01
- Material 3 Expressive / 强制主题图标 — 9to5google.com, 2025-09-16；developer.android.com M3 文档, 2026-11-12
- Flutter 3.47 material_ui 拆分 — flutter.dev/blog/whats-new-in-flutter-3-47, 2026-11-05
- DeepSeek 峰谷定价 — api-docs.deepseek.com 定价页, 2026-11-05；新浪财经 2026-08-14
- 服务器价格 — vpsbenchmarks 2026-11-02；腾讯云社区 2026-11-11
- Tailscale 免费版 — tailscale.com/pricing, 2026-11-09
