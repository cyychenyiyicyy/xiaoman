# 21 · MVP 契约（主对话 + 模型配置）

> **冻结时间**：2026-11-14。本文件是 MVP 前后端的唯一接口依据，改动必须同步改前端。
> 范围由用户口述圈定：**只做主对话** —— 聊天、上下文、会话、模型添加与配置、模型选择、思考强度、拍照与图片上传。
> **不做**：题目解析 / OCR / 错题 / 复习 / 知识地图 / 统计学 / 会话列表。

---

## 1. 三个已定决策

| # | 决策 | 理由 |
|---|---|---|
| **M1** | **MVP 用 Web UI，直接复用 `design/mockup/theme.css` 与 v6 稿的对话屏**，平板浏览器打开即用；后续再套 WebView 壳出 APK | 用户要求「界面直接 copy 过来」；本机无 JDK/Android SDK，Web 是唯一能当天跑起来的形态；Ekko Pad 已验证过「WebView 壳 + Web UI」这条路 |
| **M2** | **MVP 不接 Pi**，先用 OpenAI 兼容直连 | MVP 只需要「流式 + 多模态 + 会话」，Pi 的 catalog/compaction/工具在 M4 才付租金。留 `ChatEngine` 接缝，接 Pi 时替换实现即可 |
| **M3** | **不用域名，直接用 IP**：`http://<服务器IP>:<port>` | 用户明确要求；与服务器现有 Caddy IP 反代方式一致 |

> 环境偏差：本机实际跑 **PostgreSQL 16.15**（本机原装，服务被禁用，已在项目目录 `data/pgdata` 用 `pg_ctl` 单独起在 **5433**）。生产仍是 PG18 容器。16 与 18 在 MVP 用到的特性上无差异，记为已知偏差。

---

## 2. 进程与端口

| 进程 | 地址 | 说明 |
|---|---|---|
| FastAPI | `127.0.0.1:8787` | 同时托管 `web/` 静态文件（`/` → `web/index.html`） |
| PostgreSQL | `127.0.0.1:5433` | 库 `xiaoman_dev`，用户 `postgres`，trust 认证 |
| 浏览器 | `http://127.0.0.1:8787` | 平板同网段用 `http://<本机IP>:8787` |

---

## 3. 数据表（MVP 6 张）

```sql
llm_provider(id pk, name, base_url, api_style, api_key, api_key_tail,
             connected bool, kind, sort, created_at)
llm_model(id pk, provider_id fk, model_key, display_name, context_len,
          supports_images bool, supports_thinking bool, enabled bool, sort, created_at)
conversation(id pk, subject, created_at, updated_at)        -- 单行，永不复用
message(id pk, conversation_id fk, role, kind, content_md, reasoning_md,
        images jsonb, provider_id, model_key, thinking, status, error, created_at)
attachment(id pk, filename, mime, bytes, sha256, path, created_at)
app_setting(key pk, value jsonb)                            -- 当前 model / thinking
```

- `api_style`：`openai`（默认）/ `anthropic`（预留）
- `kind`：`custom`（用户添加）/ `mock`（内置，无需 key，用于验收）
- **只追加**：`message` 不更新正文，流式结束才写 `status='done'`

---

## 4. API（前缀 `/api/v1`）

### 4.1 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/conversation` | `{id, subject, message_count, updated_at}`；不存在则创建 |
| GET | `/messages?before=<id>&limit=50` | `{items:[Message], next_before}`，倒序取正序返 |

`Message`：`{id, role:"user"|"assistant", kind:"text"|"image", content_md, reasoning_md, images:[{id,url,mime}], provider_id, model_key, thinking, status, created_at}`

### 4.2 聊天（SSE）

`POST /chat`，`Content-Type: application/json`

```json
{ "text": "…", "image_ids": ["att_…"], "thinking": "off|low|med|high" }
```

响应 `text/event-stream`，每行 `data: {json}`：

| type | 载荷 |
|---|---|
| `meta` | `{user_message_id, assistant_message_id, provider_id, model_key, thinking}` |
| `reasoning` | `{delta}` 思考链增量（可无） |
| `text` | `{delta}` 正文增量 |
| `done` | `{message_id, usage:{prompt_tokens, completion_tokens}}` |
| `error` | `{code, message}`，随后流结束 |

**规则**：模型与思考档位取自 `app_setting`，不在请求体里传；上下文 = 最近 20 条消息，超长按字符截断。

### 4.3 Provider / Model / 设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/providers` | `[{id,name,base_url,api_style,api_key_tail,connected,kind,model_count}]` |
| POST | `/providers` | `{name, base_url, api_key, api_style?}` → 新建 |
| PATCH | `/providers/{id}` | 改名 / 改端点 / 换 key / 断开 |
| DELETE | `/providers/{id}` | 级联删该 provider 的模型行 |
| POST | `/providers/{id}/test` | 请求 `{base_url}/models`，返回 `{ok, models_count, latency_ms, error?}` |
| POST | `/providers/{id}/sync-models` | 拉 `/models` 并 upsert，返回 `{added, total}` |
| GET | `/models?provider_id=` | 组内模型 |
| PATCH | `/models/{id}` | `enabled / display_name / context_len / supports_images / supports_thinking` |
| GET | `/settings` | `{provider_id, model_id, thinking}` |
| PATCH | `/settings` | 改当前模型 / 思考档 |

### 4.4 附件

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/uploads` | multipart `file` → `{id, url, mime, bytes}` |
| GET | `/attachments/{id}` | 原图字节（带 content-type） |

### 4.5 健康

`GET /health` → `{ok, db:"ok", schema_version, version}`

### 4.6 契约补遗（实现先于文档，2026-11-14 补记）

前端在实现时用到了三处原文没写死的形状，**以本节为准**：

| 端点 | 补充定义 |
|---|---|
| `PATCH /providers/{id}` | 可传 `connected: false` 表示临时断开（不删 key）；传 `api_key` 会同时更新 `api_key_tail` 并置 `connected=false` |
| `POST /providers` | 返回**完整 `ProviderOut`**（含 `id` 与 `api_key_tail`），不是 204 |
| `PATCH /settings` | 请求体三个字段全部可选：`{provider_id?, model_id?, thinking?}`；只传 `thinking` 表示只改档位 |
| `POST /chat` | 请求体**只有** `text` 与 `image_ids`；模型与思考档位一律读 `app_setting` |

---

## 5. 内置 mock provider（验收用）

无 API Key 时也要能验证全链路。首次启动 seed：

- provider：`name="内置演示"`, `kind="mock"`, `base_url="mock://"`
- model：`model_key="mock-fast"`, `context_len=128000`, `supports_images=true`, `supports_thinking=true`
- `POST /chat` 命中 mock 时：读入文字 + 图片 id，按 200ms/块的节奏吐一段固定中文回复；若 `thinking != off`，先吐一段 `reasoning`。
- 目的：**流式、消息落库、上下文、图片附件、思考档位**五条链路在没有真 key 时全部可验。

---

## 6. 前端（`web/`）

| 文件 | 内容 |
|---|---|
| `theme.css` | 从 `design/mockup/theme.css` **整份复制**，只在末尾追加页面私有类 |
| `sprite.svg` | 由 `design/mockup/icons/*.svg` 生成 `<symbol id="i-*">`，**描边强制 1.7** |
| `fonts/` | 复制 `design/mockup/fonts/` 三个 Instrument Sans woff2 |
| `index.html` | 结构照 `result-ui-v6.html` V1（rail + 顶栏 + 流 + composer） |
| `app.js` | 无构建、原生 JS：SSE 读取、Markdown 渲染、模型弹层、模型管理、provider 表单、拍照/上传 |

页面私有类（`.pgrp/.mrow/.au/.chk` 等）在 v6 稿 `<style>` 里，取过来放进 `theme.css` 末尾。

**必须对上的视觉硬约束**：无 emoji 图标 · 图标 14/18/22 且描边 1.7 · 字号只用 s1–s6 · 间距只用 q1–q6 · 一屏最多一个 filled · 返回/关闭用 `ink2` 且 44×44 · 不写解释性副标题 · 数字 tabular-nums。
---

## 7. 已知限制（MVP 有意不做）

| 项 | 说明 |
|---|---|
| **无 regenerate 接口** | 「重试」是把上一条重发一次，库里会多一条 user 消息 |
| `next_before` 未使用 | 前端只加载最近 50 条，没有「加载更早」 |
| **单会话** | 没有会话列表（产品定义），也还没做九科空间切换 |
| **无鉴权** | `APP_TOKEN` 留空时不校验；**部署到公网前必须设一个长随机串** |
| 不能中途取消 | 流式开始后没有 abort 按钮 |
| pgvector 未接 | MVP 不做检索，M3 才引入 |

## 8. 怎么跑

```powershell
# 1. 起库 + 跑迁移 + 起 API（一条命令，幂等）
pwsh -File scripts/dev.ps1

# 2. 打开
http://127.0.0.1:8787          # 本机
http://192.168.66.103:8787     # 同网段平板（IP 会变，用 ipconfig 查）

# 3. 验收（必须能红）
cd server
.venv\Scripts\python.exe -m tests.verify
.venv\Scripts\python.exe -m tests.verify --selftest    # 必须 exit 1
```

首次启动会 seed 一个**内置演示模型**（不需要 API Key），用来验证流式、图片、上下文。
接真模型：点输入框左上角胶囊 → 模型管理 → 添加 OpenAI 兼容端点（`baseUrl` + `API Key`）。
`baseUrl` 要带版本段，例如 DeepSeek 填 `https://api.deepseek.com/v1`。
---

## 9. 扩展 v2（2026-11-14 晚：流式渐显 + 模型目录）

### 9.1 新增/变更字段

| 表.列 | 类型 | 说明 |
|---|---|---|
| `llm_provider.catalog_id` | TEXT default `''` | 对应 models.dev 的 provider id（`deepseek` / `alibaba-cn` …），空 = 自定义 |
| `llm_model.supports_tools` | BOOL default false | 是否支持**工具调用** |
| `llm_model.meta_source` | TEXT default `''` | `catalog`（models.dev 自动填）/ `guess`（按名字猜）/ `manual`（用户改过） |

### 9.2 目录接口

**`GET /api/v1/catalog`** → 内置平台清单（含连接状态）
```json
{"sources":[
  {"catalog_id":"deepseek","name":"DeepSeek","group":"国内",
   "base_url":"https://api.deepseek.com/v1","api_style":"openai",
   "doc":"https://api-docs.deepseek.com/quick_start/pricing",
   "model_count":4,"connected":true,"provider_id":"…"}
]}
```
`group` 只有两值：`国内` / `海外`。

**`GET /api/v1/catalog/models?catalog_id=deepseek`** → 该平台的模型清单（来自 models.dev）
```json
{"models":[{"key":"deepseek-v4-flash","name":"DeepSeek V4.1 Flash",
  "context":1048576,"output":393216,
  "images":true,"tools":true,"reasoning":true}]}
```

**`GET /api/v1/catalog/lookup?catalog_id=deepseek&model_key=deepseek-v4-flash`**
→ `{context, output, images, tools, reasoning, name}`；查不到返回 **404**（前端据此要求手填）。

**`POST /api/v1/providers`** 新增可选字段 `catalog_id`。
**`POST /api/v1/providers/{id}/sync-models`** 返回值新增 `enriched`（本次由目录自动填充的模型数）。

**`PATCH /api/v1/models/{id}`** 新增可改字段 `supports_tools`；任何 PATCH 都把 `meta_source` 置为 `manual`。
**`GET /api/v1/models`** 每项新增 `supports_tools`、`meta_source`、`output_len`。

### 9.3 界面规格（按 skill 规范）

**A. 流式渐显**

| 项 | 规则 |
|---|---|
| 节奏 | 用 `requestAnimationFrame` 队列匀速揭示，**不是**收到多少就画多少。基准 ~55 字/秒；积压每多 40 字，速率 +25%，保证不落后于真实流 |
| 渐显 | 新揭示的**词**包进 `<span class="sw">`，`animation: swfade .28s ease-out both`；`from{opacity:0;transform:translateY(1px)}` `to{opacity:1;transform:none}` |
| 结构 | 已完成的段落渲染成 Markdown 放进 `.stable`；正在流的尾段放 `.live`（纯文本 + 词 span），段末（`\n\n`）时提交进 `.stable` |
| 收尾 | `done` 时一次渲染完整 Markdown，移除 streaming 标记 |
| 光标 | 流式期间尾段后跟一个 `.caret`（2×18px，`--clay`，`steps(2)` 闪烁），结束后移除 |

**B. 模型管理页**

三段结构，沿用 `sgroup / scard / srow`：

```
已连接        → 每个 provider 一行（模型数 + chevron）
内置平台      → 两小分节「国内」「海外」，每行 = 平台名 + 「连接 ›」
自定义        → 添加 OpenAI 兼容端点
```
- 未连接平台**不列模型**（AGENTS §3.4）；
- 已内置的平台点「连接」→ 表单只要求 **API Key**（名称/端点已预填，可改）。

**C. provider 详情 / 模型行**

模型行改为可点：右侧显示 `context`（`1M` / `128K`，tabular），点开 **模型设置 sheet**：
- 显示名（input）
- 上下文长度（input，数字，单位 K）
- 多模态 / 工具调用 / 思考 三个 **switch**
- 底部一行说明来源：`models.dev` 或 `手填`
- 目录未收录时，四个字段为空并给一行 `未收录，请手动填写`（`ink3`，不是解释性副标题，是状态）

**D. 新增端点表单（含元数据）**

字段：名称 / 端点 / API Key / 显示名 / 上下文长度 / 多模态 / 工具调用 / 思考。
- 前四项必填校验；后四项可选，**留空则等 sync 后由目录补**；
- 保存后自动 `sync-models`，若 `enriched > 0` 给 toast `已从 models.dev 填充 N 个模型`；
- 保存是唯一 filled 按钮，取消为 outlined。
### 9.4 两个踩过的坑（写下来，别再犯）

**① 逐字 span 的类名不能叫 `.sw`。** `theme.css` 里 `.sw` 是设计系统的**开关组件**（42×25 + 19×19 白色旋钮）。流式逐字 span 借用了它，结果每个字都被画成一个白色圆点，看起来像「一排圆形乱码」。逐字 span 现用 `.stream-word`。
**教训**：新增组件的类名必须先在 `theme.css` 里搜一遍，禁止复用既有语义类。

**② 数学公式必须渲染，不能当普通文本吐。** 接 KaTeX（`web/vendor/katex/`，离线，270KB JS + 60 个字体 + 22.8KB CSS），走 `auto-render`，只对 `.stable`（已提交段落）做，正在流的 `.live` 加 `no-math` 跳过，避免半截公式变红字。display 公式（`$$…$$`）闭合即提交渲染，缩短裸 TeX 窗口。

**③ 客户端断开不能记成 done。** 之前断流时半截回复被标 `done`，历史里会留一条残句。现在 `CancelledError` → `status=error / 连接中断`。
### 9.5 思考过程：折叠态实时尾巴 + 秒数（2026-11-14 晚）

用户要求：**「思考要显示思考几秒；思考过程中无需展开就能看到实时」**。参照的开源实现：

| 来源 | 做法 |
|---|---|
| [CopilotKit reasoning card](https://github.com/copilotkit/copilotkit/blob/0573996d8d4270521c9d357168321b6948742d38/showcase/shell-docs/src/content/snippets/shared/guides/custom-look-and-feel/reasoning-messages.mdx) | 思考中「Thinking…」+ 脉冲；结束切「Thought for X seconds」 |
| [smoothui AI Reasoning](https://github.com/educlopez/smoothui/blob/e4b0b44a5c640ec217800eb664db18879822cd6c/apps/docs/content/docs/components/ai-reasoning.mdx) | 自己计时；结束先停一拍再收起，不硬切 |
| [DeepSeek-Reasonix #7966](https://github.com/esengine/DeepSeek-Reasonix/pull/7966) | 折叠态保留**最新流式尾巴**做预览（原实现要么全裸露、要么无预览） |
| [eliza orchestrator-reasoning](https://github.com/elizaOS/eliza/blob/524089add665fb75fdb7cc47979d419bdd31714e/plugins/plugin-task-coordinator/src/orchestrator-reasoning.tsx) | 思考中「Thinking…」，结束「Thought for {duration}」 |

**实现**

| 项 | 规则 |
|---|---|
| 折叠 | **默认折叠**。折叠态常驻一行：`思考中 · N 秒` + 最新思考尾巴（单行、右端渐隐 mask） |
| 计时 | 客户端 `performance.now()` 从首个 reasoning 增量起算，首个正文增量或结束时封口；**服务端同步测量**并写入 `message.thinking_ms`，重载后仍显示秒数 |
| 结束 | 标签变 `思考 N 秒`，预览隐藏，箭头回到最右 |
| 展开 | 用户点了才展开，展开时正文随流更新（`rbody` 只更新已展开的那个） |
| 文案 | 只写值：`思考 12 秒` / `思考中 · 3 秒`，不写解释 |

已验证（jsdom）：标签序列 `思考中 · 1 秒 → 思考 1 秒`；预览长度 9→17→24 字；**思考中自动展开次数 = 0**；DB `thinking_ms = 266`。