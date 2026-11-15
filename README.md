# 小满 · Xiaoman

> **一个会先开口的学习伙伴。**
> 名字取自节气：麦粒渐满，还没满。

单用户自建项目 —— 只给一个人用（高一 · 九科），部署在自己的服务器上，Android 平板为主界面。

| | |
|---|---|
| 包名 | `site.e1e.xiaoman` |
| 访问 | **直接用 IP**：`http://106.53.223.250`（**不做域名**） |
| 主色 | `#B0563A` 陶土 |
| 技术栈 | Kotlin + Compose / FastAPI + PostgreSQL / Pi / FSRS |

---

## 📍 现在到什么阶段了

| 阶段 | 状态 | 位置 |
|---|---|---|
| 市场调研 · 开源调查 · 需求分析 | ✅ | `docs/01`–`03` |
| 技术选型 · 路线图 · 风险 | ✅ | `docs/04`–`05` |
| AI 运行时设计（Pi + ~20 个工具） | ✅ | `docs/06` |
| 产品设计（单一会话 + 8 种消息） | ✅ | `docs/07` |
| 学科空间 · 错题模块 · 视觉系统 | ✅ | `docs/10`–`12` |
| **界面设计：18 个页面全部出稿** | ✅ | `design/mockup/` · `docs/17` `docs/19` |
| 深色模式 · 拍题摄像头 · 导航规范 | ✅ | `docs/18` `docs/19` |
| 品牌（名字定稿） | ✅ `docs/13`；**图标待定** | `design/brand/` |
| **代码** | 🟡 **MVP 已跑通**：主对话 Web（聊天 / 模型配置 / 图片） | `web/` · `server/` · `docs/21` |
| **题库解析 · 知识点** | ✅ 拍题入库即自动生成答案/解析/知识点/年级/难度；高中九科知识点树（6161 点 / 4369 边） | `docs/30` |
| **知识地图（P5）** | ✅ 一科一张知识点网：学科/模块/章切换、章级总览、先修链跳转、搜索定位 | `docs/31` |

> 设计与规范已经足够详细，可以直接照着写代码。见 [§13 从这里开始](#13-从这里开始)。

---

## 1. 这是什么

不是「又一个学习 App」，是补一条**断掉的链**：

```
纸质/散落资料 ──✗──> 结构化 ──✗──> 知识关联 ──✗──> 主动复习
```

三个断点：**痕迹不落库、落库不关联、关联不复发**。产品的全部价值在最后一环会**回头改第一环的优先级**。

### 最锋利的差异化：对话即采集

你只有不会的时候才去问 AI，所以**每一次提问本身就是最真实的薄弱点信号**。

- Anki 要你**先知道自己不会什么**，再手工造卡；
- NotebookLM 能读资料，但**不产生复习行为**；
- 作业帮给你答案，然后**结束**。

而这里：**答案给完，系统才刚刚开始工作。**

> 「AI 只给答案」的解法不是换更强的模型，**是让答案流进数据库**。

---

## 2. 用户与设备

| 项 | 值 |
|---|---|
| 使用者 | 一个人（项目作者本人） |
| 学段 | 高一 |
| 科目 | **九科**：语文 / 数学 / 英语 / 物理 / 化学 / 生物 / 政治 / 历史 / 地理 |
| 主设备 | **平板**（横屏 ≥840dp） |
| **拍题方式** | **平板前摄 + 顶部镜面 = 俯视桌面**。学习机前摄高清，是天然拍题机位 |
| 手机 | 可选，只读对话。**手机拍照上传那条路径已作废** |

---

## 3. 产品形态：一个伙伴，九个空间

| 轴 | 设计 |
|---|---|
| **关系轴**（她是谁） | **单一**。一个人格、一套语气、一份记忆 —— 她叫小满 |
| **内容轴**（在聊什么） | **分科**。九个学科空间，每个空间内是一条**无限长的连续对话** |

- **没有会话列表，没有「新建对话」**；切换学科 = 换空间，历史永远在；
- **首页「全部」** = 她今早说的那段话 + 今日四科 + 本周数据（**长得像对话，不是仪表盘**）；
- **功能不是 Tab，是消息的展开**：功能以卡片出现在流里，点开在右栏展开；
- **记忆 / 复习队列 / 知识地图 / 错题本 / 本周** 是全局的，不按科拆。

---

## 4. 架构与技术栈

```
Android 平板（Compose + M3）
        │ HTTPS / SSE
        ▼
┌─────────────────────────────────────────────────┐
│ FastAPI：复习调度 / 知识图谱 / 错题 / 统计 / 鉴权  │
│   │ 内网 HTTP                                    │
│   ▼                                             │
│ 薄网关（Node/TS，~200 行）：createAgentSession    │
│   │ 进程内                                       │
│   ▼                                             │
│ Pi（AI 层本体：对话循环 / provider / 模型目录 /   │
│      会话 / compaction / 成本 / 工具调用）         │
│   │ 工具回调                                     │
│   ▼                                             │
│ ~20 个学习工具（kp_search / question_search /     │
│                  deposit_from_chat …）           │
└─────────────────────────────────────────────────┘
                     │
                PostgreSQL + pgvector
```

| 层 | 选择 | 理由 |
|---|---|---|
| Android | Kotlin + **Compose** + **Material3** | 官方路线，APK ~2.9MB，CI 最成熟 |
| 本地存储 | Room 2.8.x | 单平台用官方方案（别用 alpha 的 3.0） |
| 网络 | Ktor Client + kotlinx.serialization | 支持 WebSocket |
| 后端 | **FastAPI** + SQLAlchemy 2 + Pydantic v2 | 一人写最快，自动出 OpenAPI |
| 数据库 | **PostgreSQL 18 + pgvector** | 关系 + 向量 + 全文一个容器 |
| 复习调度 | **py-fsrs（FSRS-6）** | 绝不自研算法 |
| 知识图谱 | **PG 边表 + 递归 CTE** | 千级节点，Neo4j 是纯负担 |
| AI 运行时 | **Pi**（`@earendil-works/pi-coding-agent`，**锁精确版本**） | 见 `docs/06` |
| OCR | **先用云 API**（¥0.01–0.05/页） | 50 页/天买 GPU 不划算 |
| 推送 | 自建 **ntfy** + WebSocket | FCM 国内不可用 |
| 分发 | GitHub Releases 主 + F-Droid 副 | 仓库设 public，Actions 免费 |
| 部署 | Docker Compose + Caddy | 自动 HTTPS + Tailscale |

**不用自己写**：provider 适配、模型清单、定价表、对话循环、流式解析、工具调用协议、重试、上下文裁剪、会话存储、密钥管理、token 核算 —— 这些 Pi 全包了。

---

## 5. 界面设计 ⭐

> 本节是开发的唯一视觉依据。**完整可交互稿在 `design/mockup/`，用浏览器打开**。

### 5.1 设计令牌（唯一来源）

#### 颜色

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `paper` | `#FBFAF7` | `#151412` | 页面底 |
| `card` | `#FFFFFF` | `#1D1C19` | 卡片 / 输入框 |
| `fill` | `#F4F1EA` | `#25231F` | 你的气泡、次级容器 |
| `fill2` | `#EDE9E0` | `#2F2C27` | 进度条底、掌握度空格 |
| `ink` | `#1A1917` | `#EFEBE3` | 主文字 |
| `ink2` | `#6E6A62` | `#A9A499` | 次要文字、**返回/关闭控件** |
| `ink3` | `#A09B90` | `#8C877C` | 三级文字、标签 |
| `line` | `#E8E4DA` | `#2C2A25` | 1px 描边、分隔线 |
| `line2` | `#DCD7CA` | `#3A362F` | 输入框边、按钮边 |
| **`clay`** | **`#B0563A`** | **`#C97A5E`** | 主色：主按钮、当前项、薄弱数字 |
| `claybg` | `#F8EDE8` | `#33241D` | 选中底、确认卡底 |
| `clayline` | `#EAD5CB` | `#4C332A` | 强调容器描边 |
| **`on-clay`** | **`#FFFFFF`** | **`#201712`** | **赤陶上的文字**（深色下必须是深字） |
| `sage` | `#5F7355` | `#8FA383` | **只用于「已掌握/已完成」** |

> **赤陶底上不许写死 `#fff`** —— 浅色下只有 3.2:1，不达标。一律用 `--on-clay`。

#### 字号：6 级，别无其它

| Token | 字号 / 行高 | 字重 | 用在哪 |
|---|---|---|---|
| `s1` | **34 / 1.24** | 500 | 掌握度大数字、引导标题 |
| `s2` | **24 / 1.30** | 500 | 页面标题、知识点名 |
| `s3` | **19 / 1.50** | 500 | 她开口的第一句、题干 |
| `s4` | **15 / 1.72** | 400 | 正文（唯一正文尺寸） |
| `s5` | **13 / 1.60** | 400 | 次要说明、按钮文字 |
| `s6` | **11 / 1.45** | 500 + 字距 .08em | 标签、元信息、角标 |

**不许出现 14.5 / 16 / 17 / 20 / 27 这类中间值。** 要更大就跳一档。

#### 间距：7 档

```
4 · 8 · 12 · 20 · 32 · 52
```

段内 4/8 · 段间 12/20 · 区块间 32/52 · 页面留白 20（手机）/ 32–52（平板详情）。

#### 图标

| 项 | 值 |
|---|---|
| 来源 | **Lucide**（MIT），内联 `<symbol>` + `currentColor` |
| 尺寸 | **只有 14 / 18 / 22 三档** |
| 描边 | **`1.7`** 统一；≥30px 的装饰图形用 `1.4`（`--stroke-soft`） |
| 禁止 | emoji 当图标；实心与线性混用 |

#### 形状

| Token | 值 | 用在哪 |
|---|---|---|
| 卡片 | **10** | 所有卡片 |
| 按钮 | **8** | 所有按钮 |
| 胶囊 | 999 | chip、输入条 |
| 弹层 | 18（仅顶部两角） | sheet |

#### 三级面 + 一条铁律

| 面 | 长相 | 用在哪 |
|---|---|---|
| **flush** | 无框无底 | 她的话、列表行、段落 —— **默认就用它** |
| **outlined** | 1px 描边 + 白底 | **只有"可点/可操作"的才配** |
| **filled** | 浅纸底 | **需要你决策的** |

> ⚠️ **一屏最多一个 filled。** 一旦有两个，就都不重要了。

#### 数字

**全部 tabular-nums**（`font-feature-settings:"tnum"`）。掌握度、题数、天数、分钟、日期、进度，全部右对齐成列。

### 5.2 字体

| 用途 | 字体 |
|---|---|
| 全部（标题、正文、数字、按钮、标签） | **Instrument Sans** 400/500/600 |
| 中文回落 | 思源黑体 / 微软雅黑 → Android 用 `FontFamily.SansSerif`（内置 Noto Sans CJK，**零体积**） |

**没有衬线。** 中文衬线只有两档字重，放大就发虚；且和数学符号对不齐（`−1 < x < 4` 一眼就能看出两套字在打架）。

字体文件在 `design/mockup/fonts/`（latin 子集，3 档共 ~51KB，离线可用）。

### 5.3 导航与退出

| 页面类型 | 控件 | 位置 |
|---|---|---|
| **L0 一级**（rail 六项：对话/错题/地图/记忆/本周/设置） | 无 | 靠 rail 切换 |
| **L1 二级**（卡片展开 / 设置子页） | `‹` 返回 | 左上 |
| **全屏流程**（拍题 / 复习 / 引导） | `✕` 关闭 | 左上 |
| **弹层 sheet** | `✕` | **右上**（同时保留点遮罩关闭） |
| **表单** | 顶部 `✕` + 底部「取消」 | 两条路都能出去 |

**五条硬规则**

1. **一律 44×44dp 热区**（图标 14–18px，但热区不能小）；
2. 颜色用 **`ink2`**（不是 `ink3`，它在浅底看不清）；
3. **每屏必须有标题**，标题与返回同一行；
4. **左侧只放"出去"，右侧放"页内移动"**（如 `‹ 2 / 24 ›` 翻页器必须在右侧）；
5. 副标题写**"我在哪"**（`错题` / `数学 · 必修一` / `受力分析 · 3/15`），不写解释。

### 5.4 文案纪律

> **副标题只在承载「状态 / 值」时出现，不承载「解释」。**

| ✅ 留 | ❌ 删 |
|---|---|
| `已连接` · `07:30` · `11 个模型` · `1M` · `2 / 5` | `超出顺延到明天` · `这里只是选` · `不动题目与知识点` · `在输入框里点胶囊也能改` |

- 标签/按钮用**名词或动词**（`清空复习记录`，不是 `清空所有复习记录，不动题目与知识点`）；
- **例外**：她主动说的话（开场、周报、提醒）不是 UI 文案，可以自然语言。

### 5.5 三态

| 态 | 组件 | 规则 |
|---|---|---|
| **空** | `.empty` | 34px 灰图标 + 一句标题 + 一句说明（≤36 字）+ **一个动作** |
| **加载** | `.skel` | **骨架条**（14px、圆角 7、微光扫过），**不用转圈** |
| **错误** | `.err` | clay 图标 + **说清是什么错** + **给一条退路** + 两个动作 |

### 5.6 拍题

**平板自己拍**：前摄 + 顶部镜面 = 俯视桌面。取景框**实时框住识别到的题目**（赤陶描边）——**拍的时候就知道框到了什么**。

摄像头选择器：**前摄（默认）/ 后摄 / USB**。只有名词和勾，没有任何说明。

### 5.7 18 个页面 × 对应稿

| ID | 页面 | 稿文件 | 屏 | 里程碑 |
|---|---|---|---|---|
| **P0** | 对话（10 个学科空间） | `result-ui-v6.html` V1 | ✅ | **M1** |
| — | 拍题取景 | `result-ui-v8.html` D1 · `v9-nav` N1 | ✅ | **M1** |
| — | 选择摄像头（弹层） | `result-ui-v8.html` D2 · `v9-nav` N6 | ✅ | **M1** |
| **P1** | 采集校对 | `result-ui-v7-a.html` A1 | ✅ | **M1** |
| **P2** | 复习会话 | `result-ui-v7-a.html` A2 · `v9-nav` N2 | ✅ | **M1** |
| **P14** | 确认写入（弹层） | `result-ui-v7-a.html` A5 | ✅ | **M1** |
| **P15** | 附件选择（弹层） | `result-ui-v7-a.html` A6 | ✅ | **M1** |
| **P11** | 引导 | `result-ui-v7-c.html` C1 | ✅ | **M1** |
| **P10** | 设置 | `result-ui-v6.html` V3 · `v8` D6 | ✅ | **M1** |
| **P3** | 题目详情 | `result-ui-v7-a.html` A3 · `v9-nav` N3 | ✅ | M2 |
| **P4** | 知识点详情 | `result-ui-v7-a.html` A4 | ✅ | M2 |
| **P7** | 错题本（全部错题 / 知识分类） | `result-ui-v7-b.html` B1 · B2 | ✅ | M2 |
| **P8** | 找旧题 | `result-ui-v7-b.html` B3 · `v9-nav` N4 | ✅ | M2 |
| **P9** | 记忆面板 | `result-ui-v7-b.html` B6 | ✅ | M2 |
| **P13** | 上传队列 | `result-ui-v7-c.html` C2 · `v9-nav` N5 | ✅ | M2 |
| **P17** | 模型弹层 / 模型管理 / provider 详情 | `result-ui-v6.html` V2 · V4 · V5 | ✅ | M2 |
| — | 自定义端点（表单） | `result-ui-v7-c.html` C6 | ✅ | M2 |
| **P5** | 知识地图 | `result-ui-v7-b.html` B4 | ✅ | M3 |
| **P6** | 周报 | `result-ui-v7-b.html` B5 | ✅ | M3 |
| **P16** | 数据与导出 | `result-ui-v7-c.html` C3 | ✅ | M3 |
| **P18** | 关于与诊断 | `result-ui-v7-c.html` C4 | ✅ | M3 |
| — | 学科选择（弹层） | `result-ui-v7-c.html` C5 | ✅ | M2 |
| — | 空 / 加载 / 错误 | `result-ui-v9-states.html` S1–S3 | ✅ | **M1** |
| — | 手机 compact | `result-ui-v9-states.html` S4–S6 | ✅ | M3 |

### 5.8 全部可视稿

| 文件 | 屏数 | 内容 |
|---|---|---|
| **`theme.css`** | — | **共用样式表（所有 v7+ 稿件引用它）** |
| `result-ui-v6.html` | 5 | 对话 / 模型弹层 / 设置 / 模型管理 / provider 详情 |
| `result-ui-v7-a.html` | 6 | 采集 / 复习 / 题目 / 知识点 / 确认 / 附件 |
| `result-ui-v7-b.html` | 6 | 错题双泳道 / 找旧题 / 地图 / 周报 / 记忆 |
| `result-ui-v7-c.html` | 6 | 引导 / 队列 / 导出 / 诊断 / 学科 / 自定义端点 |
| `result-ui-v8.html` | 6 | 拍题 / 选择摄像头 / **深色 ×4** |
| `result-ui-v9-nav.html` | 6 | 返回与退出规范 |
| `result-ui-v9-states.html` | 6 | 三态 + 手机 compact |
| `result-ui-v5.html` · `v4` · `v3` | 5 · 5 · 5 | 历史版本（对照演进用） |
| `result-brand.html` | — | 品牌预览（图标尺寸阶梯 / 自适应遮罩 / 淘汰方案） |
| `result-ui-mockup-tablet.html` | 8 | 最早的平板稿（历史） |
| `result-ui-mockup-mistakes.html` | 4 | 错题模块改版（历史） |
| `result-ui-mockup-subject.html` | 3 | 学科空间（历史） |
| `result-ui-mockup.html` | 6 | 手机 v2（历史） |

**怎么打开**：双击任意 `.html`。改配色只改 `theme.css` 顶部 `:root`，刷新即可。

### 5.9 Compose 落地

```kotlin
// ── 字族：只打包拉丁，中文走系统 ───────────────────────
val AppSans = FontFamily(
    Font(R.font.instrument_sans_regular, FontWeight.Normal),
    Font(R.font.instrument_sans_medium,  FontWeight.Medium),
)

// ── 6 级字阶 ─────────────────────────────────────────
val AppTypography = Typography(
    displayLarge   = TextStyle(AppSans, 34.sp, lineHeight = 1.24.em, letterSpacing = (-0.02).em, fontWeight = FontWeight.Medium),
    headlineMedium = TextStyle(AppSans, 24.sp, lineHeight = 1.30.em, letterSpacing = (-0.015).em, fontWeight = FontWeight.Medium),
    titleLarge     = TextStyle(AppSans, 19.sp, lineHeight = 1.50.em, fontWeight = FontWeight.Medium),
    bodyLarge      = TextStyle(AppSans, 15.sp, lineHeight = 1.72.em),
    bodyMedium     = TextStyle(AppSans, 13.sp, lineHeight = 1.60.em),
    labelSmall     = TextStyle(AppSans, 11.sp, lineHeight = 1.45.em, letterSpacing = 0.08.em, fontWeight = FontWeight.Medium),
)

// ── 7 档间距：任何 .padding(13.dp) 都是错的 ─────────────
object Sp { val q1 = 4.dp; val q2 = 8.dp; val q3 = 12.dp
            val q4 = 20.dp; val q5 = 32.dp; val q6 = 52.dp }

// ── 三级面：做成三个 Composable，不是三个随手写的 modifier ─
@Composable fun Flush(content: @Composable ColumnScope.() -> Unit)
@Composable fun Outlined(content: @Composable ColumnScope.() -> Unit)   // 1dp line + r10
@Composable fun Filled(content: @Composable ColumnScope.() -> Unit)     // fill 底 + r10

// ── 图标：只用 14/18/22，描边 1.7 ─────────────────────
object Ic { val sm = 14.dp; val md = 18.dp; val lg = 22.dp; const val stroke = 1.7f }

// ── 数字等宽 ─────────────────────────────────────────
val TabularNum = TextStyle(fontFeatureSettings = "tnum")

// ── 动态取色必须关掉 ─────────────────────────────────
val scheme = if (dark) XmDarkScheme else XmLightScheme   // 不要 dynamicLightColorScheme
```

> 图标转换：`design/mockup/icons/*.svg` → Android `vector drawable`（或 Composition 里直接用 `ImageVector`）。

---

## 6. 数据模型

**9 张核心表**（详见 `docs/03 §5`）：

| 表 | 作用 |
|---|---|
| `kp` | 知识点树（`parent_id` 自引用 + `mastery` 派生值） |
| `kp_edge` | 先修边（DAG，`type = prereq/part_of/rel`） |
| `question` | 题目 = Anki 的 note |
| `question_kp` | 题目↔知识点多对多 + 权重 + 主知识点 |
| `mistake` | 「我错了」这个事实（错因、错次、状态） |
| `attempt` | 每次重做留痕 |
| `card` | 调度单元（字段名照 FSRS 规范，可直接喂 `py-fsrs`） |
| `review_log` | **只追加，永不覆盖** —— 训练 FSRS 参数的唯一数据源 |
| `fsrs_param` | 个人权重 |

**后续增补**（`docs/10 §5` · `docs/11 §6.4` · `docs/16 §3`）：

```sql
-- question
stem_preview_png TEXT          -- 题干缩略图（服务端预渲染，列表卡片用）
textbook_ref     TEXT          -- 「数学 / 必修一」
bookmarked_at    TIMESTAMPTZ
source           TEXT          -- 平板拍 / PDF / 手工

-- kp
summary_md   TEXT              -- 定义摘要（3 行内）
textbook_ref TEXT
q_count      INT               -- 物化计数
new_count    INT               -- 上次查看后新增
last_seen_at TIMESTAMPTZ

-- 新增表
note         (question_id, body_md, updated_at)     -- 「我的笔记」，与 AI 解析分家
event        (subject, summary, kp_ids[], at)       -- 会话摘要（三层记忆第 2 层）
kp_cross_ref (from_kp, to_kp, note)                 -- 跨科软关联，不进先修闸门
```

**四条铁律**

1. **`kp_edge` 只能同学科内**（触发器强制）；跨科走 `kp_cross_ref`，否则两棵树调度互相锁死；
2. **`review_log` 只追加**；
3. **`stem_preview_png` 必须随结构化一起产出** —— 否则 M2 做错题本时要回填全库；
4. 任何 schema 变更**必须**附迁移，且 `upgrade → downgrade → upgrade` 三次不报错。

---

## 7. API 面

| 分组 | 端点 |
|---|---|
| 采集 | `POST /capture/pages` · `GET /capture/tasks/{id}` · `POST /capture/tasks/{id}/retry` |
| 题目 | `GET /questions?view=time\|kp&…` · `POST /questions` · `PATCH /questions/{id}` · `GET /questions/{id}/neighbors` · `POST /questions/{id}/ask` |
| 知识点 | `GET /kp/tree` · `GET /kp/{id}/neighbors` · `POST /kp/{id}/edges` |
| 复习 | `GET /review/queue?limit=20` · `POST /review/{card}/grade` · `POST /mistakes/{id}/attempt` |
| 对话 | `POST /chat`（SSE） · `GET /chat/stream?subject=` · `GET /chat/entries?since=` |
| 概览 | `GET /overview` · `GET /stats/weekly` · `GET /stats/heatmap` |
| 导出 | `GET /export/apkg` · `POST /export/full` |

**三条约定**：所有列表用 **cursor 分页**；所有写操作**幂等**（客户端 `op_id`）；`/review/queue` 必须**纯函数输出**（里面不许塞 LLM 调用）。

---

## 8. 目录结构

```
xiaoman/
├── README.md            # 本文件（开发入口）
├── AGENTS.md            # 给 AI agent 的硬约束与验收清单
├── docs/                # 25 篇调研与设计文档
│   ├── 00-调研总览.md
│   ├── 01-需求分析 … 23-Pi接入验证与计划.md
│   └── result-*.md      # 两份原始调研底稿
├── design/
│   ├── mockup/          # ⭐ 界面稿（15 个 HTML）+ theme.css + fonts + icons + scripts
│   └── brand/           # 图标 SVG 母版 + PNG 全套（43 个文件）
├── server/              # 待建：FastAPI（api + worker + 迁移 + 测试）
├── agent/               # 待建：Pi 网关（Node/TS）+ 学习领域 package
└── android/             # 待建：Compose 工程
```

---

## 9. 里程碑

| # | 里程碑 | 交付物 | 验收（自己可验） | 预估 |
|---|---|---|---|---|
| **M0** | 骨架 | monorepo、docker-compose 起得来、9 张表建好、Android 空壳、Actions 出签名 APK | 平板装上能打开；`curl /health` ok；推 tag 出 APK | **1 周** |
| **M1** | **录入闭环** ★关键路径 | 拍 → 上传 → OCR → 切题 → LLM 组装 → 人工确认 → 入库 | **拍 10 页卷子，20 分钟内变成结构化题目** | **2–3 周** |
| **M2** | 复习闭环 | FSRS + 每日队列 + 四档评分 + revlog + 首页 | 连续 7 天打开都有队列；评分后 due 正确变化 | **2 周** |
| **M3** | 知识关联 | 知识点树 + 标注 + 先修边 + 掌握度聚合 + 图谱 | 能回答「我电磁感应老错，根因在哪」并给出先修链 | **2–3 周** |
| **M4** | 提问沉淀 | Pi 网关 + `/chat` 流式 + 自动沉淀 + 引用溯源 | 问一次 AI，3 秒后库里多出 1–3 个待复习项 | **3–5 天** |
| **M5** | 主动与统计 | ntfy + 周报 + 热力图 + 遗忘预警 | 周日收到周报；断签 3 天只提醒一次 | **1–2 周** |

**业余每周 8–10 小时 → 到 M2 约 6 周，到 M5 约 2.5 个月（合计 80–120 小时）。**

> **M1 是生死线。** 没有真实录入，你就不会用；你不用，项目就死了。M1 的验收标准是**真实跑通 10 页**，不是「代码写完了」。

---

## 10. 成本

| 项 | 月成本 |
|---|---|
| 服务器（腾讯云轻量 2C2G，68 元/年摊薄） | ≈ ¥5.7 |
| 域名 | ¥0（直接用 IP，不买域名） |
| Tailscale / Cloudflare Tunnel / GitHub Actions（公开仓库）/ F-Droid | ¥0 |
| DeepSeek v4-flash（闲时 50 次/天） | ≈ ¥7 |
| OCR 云 API（50 页/天） | ≈ ¥15–75 |
| **合计** | **≈ ¥35–95 / 月** |

---

## 11. 数据主权（这条最重要）

> **代码会重写，数据要活十年。**

- 所有表带 `schema_version`，变更走迁移脚本；
- **导出是一等功能**，不是附属功能：随时产出 `JSON + Markdown + 图片` 完整包，以及 **Anki apkg**；
- **只要数据能导出成 Markdown + apkg，这个项目就永远不会变成负担** —— 真做不下去了，进 Anki 继续复习。

---

## 12. 开发约定

完整版在 **[AGENTS.md](AGENTS.md)**，这里是摘要：

| 类别 | 规则 |
|---|---|
| 视觉 | 无衬线 · 6 级字号 · 7 档间距 · 三级面（一屏一个 filled）· 图标 14/18/22 + 1.7 · 禁 emoji · 关动态取色 |
| 导航 | 二级 `‹` / 流程 `✕` / 弹层右上 `✕` / 左侧只放"出去" |
| 文案 | 副标题只承载状态值，不承载解释 |
| 数据 | `kp_edge` 同科 · `review_log` 只追加 · 迁移可回滚 · 导出可校验 |
| 代码 | 不写死绝对路径 · **验证脚本必须能 exit 1** · 依赖锁精确版本 · 改完跑 `pytest` / `verify.py` |
| 不做 | 多用户 / 游戏化 / 自研 SRS / 自研 OCR / Google Play / Web 端 |

> 历史教训（写进 `AGENTS.md §4`）：**验证脚本从不设退出码，报告 31 个 FAIL 却 exit 0，把坏包放上线了。** 所以每个检查脚本结尾必须 `sys.exit(1 if failures else 0)`，且开跑前先删旧报告。

---

## 13. 从这里开始

### 先跑 MVP（已经能用的那部分）

> 形态：**Web 先跑，最后 WebView 套壳打包安卓**。电脑上测试，不折腾 APK。
> 范围：主对话 + 模型添加/配置/选择 + 思考档位 + 拍照上传图片。**不做** OCR / 错题 / 复习。
> 契约：**[docs/21-MVP契约.md](docs/21-MVP契约.md)**

```powershell
pwsh -File scripts/dev.ps1          # 起 PostgreSQL(5434) → 迁移 → API(8787)
# 浏览器打开 http://127.0.0.1:8787  或同网段 http://<本机IP>:8787
```

首次启动自带一个**内置演示模型**（不用 API Key）：能验流式、图片、上下文。
接真模型：点输入框左上角模型胶囊 → 模型管理 → 添加 OpenAI 兼容端点。

验收（脚本必须能红）：
```powershell
cd server
.venv\Scripts\python.exe -m tests.verify              # 全绿
.venv\Scripts\python.exe -m tests.verify --selftest   # 必须 exit 1
```

### 第一周

1. **今天**：Android Developer Console 注册开发者身份，占住 `site.e1e.xiaoman`（防 2027 年开发者验证拦安装）；
2. **今天**：仓库设 **public** + 加 MIT 许可证（一步解决 Actions 无限额度 + F-Droid 收录）；
3. **本周**：建 `server/ android/ agent/`，把 [§4](#4-架构与技术栈) 的架构图贴进 `server/ARCHITECTURE.md`；
4. **本周**：docker-compose 起 pg + api + caddy，`/health` 通（**先别写业务**）；
5. **本周**：`py-fsrs` 跑 20 行 demo（`next_states` / `review_card`），确认手感；
6. **本周**：**按 `docs/06 §10` 做一天的 Pi 验证** —— 起 Pi、写 `models.json`、写一个假 tool、SDK 跑通流式。这条路真假一天内就能确认；
7. **本周**：起 Compose 工程，照 [§5.9](#59-compose-落地) 落 `AppTypography` / `Sp` / 三级面三个 Composable。

### 然后先做 M1 的六个界面

`P0 对话` · `拍题取景` · `P1 采集校对` · `P2 复习` · `P14 确认弹层` · `P15 附件弹层`（+ `P11 引导` + 三态）

### 老实话

**先把「拍→存→排→复习→统计」跑通，AI 笨一点没关系。** 这条链不依赖任何模型能力，是纯工程；而它是你每天真正会用的部分。

---

## 14. 文档索引

| 你想知道 | 读 | 你想知道 | 读 |
|---|---|---|---|
| 为什么做、做给谁 | `01` | **AI 层怎么写 / 20 个工具** | **`06`** |
| 市场有没有人做过 | `02` | **单一会话 / 8 种消息** | **`07`** |
| 哪些轮子能用（FSRS/知识点/OCR） | `03` | 18 个界面清单 | `08` |
| 技术栈怎么选、Pi 边界 | `04` | 平板双栏 / 断点 | `09` |
| 什么时候做什么 | `05` | **错题模块（借鉴豆包）** | **`10`** |
| **学科空间（九科怎么分）** | **`11`** | **视觉系统（token）** | **`12`** |
| 名字与图标 | `13` | v4 修正（首页双栏/学科图标） | `14` |
| v5 模型进输入框 · 设置规范 | `15` | **全面规范化 + 模型体系** | **`16`** |
| **18 页对照 + 每页决定** | **`17`** | 深色模式 + 拍题摄像头 | `18` |
| **导航 / 三态 / 手机** | **`19`** | 调研底稿 | `result-*` |
| **开发顺序 / M0 拆解 / 环境缺口** | **`20`** | **MVP 契约（主对话 / 模型配置）** | **`21`** |
| **记忆 / 工具状态 / 来源 / 联网搜索** | **`22`** | **Pi 接入验证与迁移计划** | **`23`** |
| **录入流水线** | **`24`** | 阿里云切题开通 | `25` |
| **知识点与题库解析（M1.5）** | **`30`** | **知识地图（P5）** | **`31`** |
| 对话列表 / 平板侧栏 / 本周 / 自动标题 | `26`–`29` | | |

---

## 附：还没做的

| 项 | 说明 |
|---|---|
| **产品图标** | 几何方案两轮被否；图像模型额度用尽（本周剩 4%）。当前唯一可用候选：`design/brand/logo-4.png`（「满」字标） |
| 拍题手势 | 连拍 / 自动裁边 / 俯拍畸变矫正，未设计 |
| 动效规格 | 只定了时长（180/240ms），没出示意 |
| 引导第 2/3 步 | 只画了第 1 步 |
| 代码 | **从这里开始** |

---

## 许可证

自用项目，暂不开源。若将来开源，MIT。

第三方：Lucide（MIT）· Instrument Sans（OFL）· Pi（MIT）· `py-fsrs`（MIT）· PaddleOCR（Apache-2.0）。

