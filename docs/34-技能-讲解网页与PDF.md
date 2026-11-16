# 34 · 技能：讲解网页 / PDF 讲义 / 错题报告
> 网页 / PDF 已改为 Agent 在受限工作区自己写文件并 publish，见 docs/39；本文保留早期「Markdown → 模板」的链路记录。
>

> 之前的「技能」是给模型看的文件（`answer-question`）。这次做的是**用户可选的技能**：
> 选一个，输入框前面出现一枚胶囊，这一轮就按这个技能的流程做，最后交付一个**文件**。

代码：`agent/skills.json` · `agent/server.mjs`（注入 + 工具）· `server/app/services/{skills,artifacts}.py` ·
`server/app/api/internal.py`（工具）· `server/app/api/learn.py`（产物接口）· `web/app.js`（胶囊/弹层/产物卡）
· 迁移 `f7c3a9e1b2d4`

---

## 1. 参考的开源做法

| 做法 | 出处 | 我们借了什么 |
|---|---|---|
| **技能 = 指令 + 工具 + 按需加载** | [Claude Code Skills / slash commands](https://github.com/ytrofr/claude-code-guide/blob/2cd1733d2292dc06dfae0f7c9ad65e62a307e7c6/docs/guide/part3-extension/07-slash-commands.md) | 技能不是一堆按钮，是一段**可加载的流程说明**；技能里点名它能用的工具 |
| **已选技能做成输入框内的内联标签** | [nextclaw v0.14.33 Chat Inline Skill Tags](https://github.com/peiiii/nextclaw/blob/b684c1ddb38cdac301c4203510d76b3a12038502/docs/logs/v0.14.33-chat-inline-skill-tags/README.md) | 标签不放在输入框外，和输入共用一个容器；缩小 chip、去掉「技能」前缀、只留图标识别 |
| **输入框旁一个技能入口，列表带描述** | [deer-flow composer skill picker](https://github.com/bytedance/deer-flow) | 模型选择旁边一个入口；点开是带说明的列表，不是一排小按钮 |
| **可复用的命令 / 提示词** | [Open WebUI Prompts](https://docs.openwebui.cn/features/workspace/prompts/) | 技能是可维护的「一段流程」，不是一次性 prompt |

结论：**一个入口 + 一枚前置胶囊 + 一个带描述的弹层**，比在工具栏堆一排图标干净。

---

## 2. 交互

```
输入框工具行：[千帆 · deepseek-v4-flash ▾]  [✦ 技能 ▾]        [关][中][高]
输入框内部：
  ┌──────────────────────────────────────────────┐
  │ [✦ 讲解网页 ×]                                │  ← 选中后出现在输入内容最前面
  │ [题目 chip] [图片缩略图]                       │
  │ ＋ 说点什么…                                   │
  └──────────────────────────────────────────────┘
```

- 技能入口就在**模型胶囊旁边**，打开是弹层：图标 + 名称 + 一句说明 + 勾选；
- 选中后，输入框**内部最前面**出现胶囊（`#skillchips`），带 × 可移除；
- 胶囊**持续生效**，直到点 × 或换一个；发送后不清空（方便「再补个例题」继续用同一个技能）；
- 发出去的消息里保留这枚小 tag，回看时知道当时用的什么技能；
- 模型侧：技能 prompt 追加到 system prompt，只加载技能声明的工具（不用的工具不挂）。

---

## 3. 内置技能

| id | 名称 | 给模型的能力 | 交付 |
|---|---|---|---|
| `webpage` | 讲解网页 | `make_webpage` | 一页自包含 HTML：结论 / 概念 / 公式 / 例题 / 易错点 |
| `pdf` | PDF 讲义 | `make_pdf` | A4 PDF：学习目标 / 知识梳理 / 例题 / 易错点 / 自测 |
| `mistake-report` | 错题报告 | `question_search(status="weak")` + `make_pdf` | 按知识点分组的错题复盘 PDF |
| `card` | 知识卡片 | `make_card` | 1080×1440 卡片 PNG（见 `docs/35`） |
| `flashcards` | 记忆闪卡 | `make_flashcards` | 可翻面的自包含 HTML（见 `docs/35`） |

技能定义在 `agent/skills.json`，**网关和服务端读同一份**：

```jsonc
{
  "id": "webpage",
  "name": "讲解网页",
  "icon": "globe",
  "desc": "把一个知识点讲成一页可收藏的网页",
  "tools": ["make_webpage"],
  "prompt": "当前启用了…必须调用 make_webpage 交付…不要输出 HTML/CSS。"
}
```

- `GET /api/v1/skills` 只下发元数据，**不下发 prompt**；
- 加技能只改这一个文件（前端弹层自动出现），不用改代码。

---

## 4. 产物链路

```
agent 调 make_webpage / make_pdf
        │  （带 conversation_id / message_id / subject）
        ▼
/internal/tools/make_*  →  Markdown 渲染成统一模板  →  data/artifacts/{id}.html|pdf
        │                                               │
        └── Artifact 行（kind/title/bytes/url）──────────┘
                                                       │
这一轮结束时，assistant 消息 parts 追加 {type:"artifact"} → 前端产物卡（打开 / 下载）
```

**HTML**：服务端把 Markdown 转成 HTML（标题/列表/引用/代码/粗斜体/链接，公式保留 `$...$`），
套一张纸色模板，KaTeX 走本地 `/vendor/katex/`，没有 CDN。

**PDF**：同一份 HTML 先写到 `{id}.src.html`，让本机 Edge `--headless --print-to-pdf` 打开
`/api/v1/artifacts/{id}/source` 再打印（A4，`@page` 边距，隐藏页眉页脚）。不引第三方 PDF 库；
打印失败会删掉半成品行，不留脏数据。

**服务端安全**：Markdown 先转义 HTML 再排版，模型给的 `<script>` 不会被执行；链接只允许 `http(s)`。

产物接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/artifacts/{id}` | 打开（HTML 直接渲染 / PDF 浏览器预览） |
| GET | `/artifacts/{id}?download=1` | 下载，文件名用标题 |
| GET | `/artifacts/{id}/source` | PDF 打印用的临时 HTML（生成完即删） |

---

## 5. 验收

```powershell
cd server
.venv\Scripts\python.exe -m tests.verify
.venv\Scripts\python.exe -m tests.verify --only migration --destructive
node ..\data\tools\ui-skill.mjs
```

- `verify`：**37 PASS / 0 FAIL / 1 SKIP**（新增 `artifact` 表、`message.skill`、`api.skills`、`learn.artifact_md`）
- 迁移 `upgrade → downgrade → upgrade` 通过
- `ui-skill`：**6 PASS**（技能入口、弹层列表、选中后胶囊在输入框内、清除、无 JS 错）
- 真实 Agent 链路跑过：
  - 「用讲解网页讲离子反应」→ `make_webpage` → 9 KB HTML，KaTeX 公式正常；
  - 「用 PDF 讲义整理」→ `make_pdf` → 204 KB / 1 页 PDF，文字流可读；
  - 产物卡出现在对话里，打开/下载都通。

---

## 6. 已知限制 / 下一步

| 项 | 说明 |
|---|---|
| PDF 依赖本机 Edge | 找不到 Edge/Chrome 时工具返回失败原因；服务器上没有浏览器就生成不了 PDF；打印地址走 `APP_BASE_URL`（默认 8787） |
| Markdown 子集 | 没做表格、脚注、图片；模型写复杂表格会退化成段落 |
| 产物不能二次编辑 | 现在是「重新生成一份」，还没有就地编辑/版本历史 |
| 没有产物库 | 只能从对话里打开；下一步加「资料」页，按学科/时间列 |
| 生成的文件不清理 | 全在 `data/artifacts/`；M6 备份时要一起导出 |
| 技能是全局的 | 不按学科推荐；下一步按当前学科/知识点给「最近常用」 |
| 错题报告依赖 status | 只取 `weak`；如果错题没被沉淀过，报告会是空的 |
