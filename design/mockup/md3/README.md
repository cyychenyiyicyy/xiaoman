# 小满 · MD3 / MICL 平板界面稿

> 打开 **[index.html](index.html)**（Chrome / Edge，窗口拉到 1280×800 或更大）。
> 设计说明见 **[docs/40](../../../docs/40-MD3平板界面重设计.md)**。

---

## 这是什么

一套按 **Material Design 3** 重排、用 **[MICL 10](https://github.com/henkpb/micl)** 组件实现的平板界面稿：

- 设计基准 **1280×800**（16:10 横屏，对应 1920×1200 / 2000×1200 学习机）；
- 7 个一级目的地：对话 / 题库 / 资料 / 地图 / 记忆 / 本周 / 设置；
- 对话是「列表 344 + 阅读栏 720」双栏；打开详情时列表收起，换成「对话 + 右栏 360」；
- 题库、资料、设置、地图、本周、复习、拍题全部重排；
- 深色只切 `.light` / `.dark` 两个类。

不是图片稿：导航、弹层、发送、主题切换都能点。

---

## 怎么打开

直接双击 `index.html`。所有依赖都在本地：

```
vendor/micl.css        MICL 10.0 组件样式（359 KB）
vendor/micl.js         MICL 运行时（list / menu / snackbar 等）
theme-clay.css         M3 颜色角色（light/dark）
app.css                应用层布局
app.js                 路由 / 弹层 / 主题 / 发送
fonts/                 Material Symbols + Instrument Sans
shots/                 1280×800 截图（19 张，含 2 张竖屏/分屏）
```

想固定深浅色或指定屏幕，用 query + hash：

```
index.html?theme=light#/chat
index.html?theme=dark#/bank
```

`?theme=` 会写入 localStorage；不带参数时沿用上次选择。

---

## 路由

| hash | 屏幕 |
|---|---|
| `#/chat` | 对话 · 新对话（默认） |
| `#/thread` | 对话 · 会话中 |
| `#/detail` | 对话 · 会话 + 右侧知识点详情 |
| `#/bank` | 题库（3 列卡片） |
| `#/library` | 资料库（列表 + A4 预览） |
| `#/map` | 知识地图（画布 + 浮动卡） |
| `#/memories` | 记忆（3 列卡片） |
| `#/week` | 本周（统计 + 图表） |
| `#/settings` | 设置（列表 + 模型详情） |
| `#/review` | 复习（全屏） |
| `#/capture` | 拍题（全屏） |
| `#/subject` | 学科空间弹层 |
| `#/skill` | 技能弹层 |
| `#/modelsheet` | 模型侧边 sheet |
| `#/question` | 题目详情侧边 sheet |

`#/review`、`#/capture` 在关闭时会回到来源屏（本周 / 对话）。

---

## 可交互的地方

- rail 切换 7 个页面；
- 对话列表 → 会话；「新对话」→ 新对话页；
- 消息里的知识点卡 → 右侧详情；详情「在对话里继续问」收起；
- 输入框：发送（Enter 或按钮）会把消息追加进会话；Shift+Enter 换行；
- 思考链一行可展开；
- 学科胶囊 → 10 项弹层，选完同步到顶栏和新对话页；
- 模型胶囊 → 侧边 sheet；技能胶囊 → 技能弹层；
- 题库卡片 → 题目侧边 sheet；「开始复习」→ 全屏复习；
- 复习评分 4 键 / 关闭；拍题「解析 3 题」→ 回题库；
- 设置里的深色开关与顶栏月亮按钮；深浅色都可用。

**没有做的**：真实数据、搜索、记忆新建、地图拖拽/缩放（只画了控件）、评分后的调度。它们是下一步，不是这一稿的验收项。

---

## 1280 的布局算术

```
rail 96 + 列表 344 + 间隙 24 + 内容 776 + 右边距 24 = 1280
详情态：rail 96 + 内容 776 + 间隙 24 + 详情 360 + 右边距 24 = 1280
```

- 内容阅读栏 max 720，居中；不把文字拉成一行 80 字；
- 1280 不硬塞三栏（列表 + 对话 + 详情），详情态收起列表；
- 宽度 ≤ 899 收列表，≤ 599 换底部导航（CSS 已写）。

---

## MICL 接入的四个坑

1. **chip 必须有 `.micl-chips` 祖先**，否则 filter chip 露出原生 checkbox、input chip 裂开；
2. **全屏 dialog** 要覆盖 MICL 的 `inset-block-start:50%` + `translate(-50%,-50%)`，显式 `inset:0; transform:none; translate:none`；
3. **侧边 sheet** 自带 40px `--_spring-buffer`，右边会被切；覆盖 `--_spring-buffer:0px` 并显式宽度；
4. **`--md-sys-layout-window-margin` 归零**后，appbar 不再负 margin，sheet 要把 padding 补回 24。

细节和依据见 `docs/40` §12。

---

## 截图

`shots/` 里是 17 张 1280×800 主屏 + 2 张适配验证 + 1 张总览拼图：

| 文件 | 内容 |
|---|---|
| `00-overview.png` | 6 屏总览（拼图） |
| `01-chat-new.png` | 新对话 |
| `02-chat-thread.png` | 会话 |
| `03-chat-detail.png` | 会话 + 详情 |
| `04-bank.png` | 题库 |
| `05-library.png` | 资料库 |
| `06-map.png` | 知识地图 |
| `07-memories.png` | 记忆 |
| `08-week.png` | 本周 |
| `09-settings.png` | 设置 |
| `10-review.png` | 复习 |
| `11-capture.png` | 拍题 |
| `12-subject.png` | 学科空间 |
| `13-skill.png` | 技能 |
| `14-model-sheet.png` | 模型 sheet |
| `15-question-sheet.png` | 题目 sheet |
| `16-dark-chat.png` | 深色 · 对话 |
| `17-dark-bank.png` | 深色 · 题库 |
| `18-portrait-chat.png` | 800×1280 竖屏（medium） |
| `19-landscape-1024.png` | 1024×768（expanded） |

---

## 已知限制

- **字体**：中文回落系统黑体；在 Windows 上是微软雅黑，在平板上是 Noto Sans CJK / MiSans，观感会略有差异。这是预期，不是 bug。
- **WebView**：MICL 10 要较新的 Chromium（建议 ≥ 125）。旧学习机的 Chrome 101 会退化（动画消失、波浪进度变平条），详见 docs/40 §12.3。
- **状态**：所有数据是静态示例；深色/浅色切换会写 localStorage，刷新后保留。
- **图标**：Material Symbols 全量字体 4 MB，本地加载；正式打包可按用到的 ligature 子集化。
