# 个人学习 AI Agent 市场现状调研（截至 2026-11-14）

> GitHub star 为 api.github.com 实时值，采集于 2026-11-14。

## 1. 概念定义

**personal AI agent**＝以**受托权限**替一个人在其账户、数据、支付上执行任务的软件。分界线：chatbot **回答**问题，agent **代表本人行动**；copilot 附着单工位等人操作，personal agent **常驻后台、跨会话记忆、主动发起**。（ppc.land, 2026-11-13, https://ppc.land/personal-ai-agent/）

2026 年该词从论文进入品牌，并收敛为同一形态（云端电脑＋连接器＋记忆＋审批闸门）：Grok Bot 08-11 → Meta Muse 09-08 → OpenAI Dots 09-29 → Anthropic Claude Duet 10-21。

| 阵营 | 关键动作与日期 |
|---|---|
| Anthropic | Cowork 01-12 发布 / 04-09 GA；03-24 打通"用你的电脑完成任务"；08-25 合并 Chat 与 Cowork 记忆系统（免费用户可用）；Duet 10-21 预览，**公开硬拒绝**部分动作 |
| OpenAI | Operator 2025-01 → 2025-07 并入 ChatGPT agent → Dots 09-29（后台只读研究，动作走 Custom Rules） |
| Meta | Muse 09-08 上线，免费＋$20/$100 两档；每用户独享 Muse Secure VM，Sentinel 审批代理 |
| Apple/Google | 01-12 联合声明：下一代 Apple Foundation Models 基于 Gemini，目标是"更个性化的 Siri"；Google 01-14 在 Gemini App 上线 Personal Intelligence |
| 记忆层 | 已独立成基础设施：LangGraph 44,939★ / Mem0 67,352★ / Letta 25,434★ / Zep 5,007★（CE 已停维护）/ Khoj 38,124★ |

## 2. 现有产品分类

| 类别 | 代表 | 可验证数字 | 痛点 |
|---|---|---|---|
| 消费级学习 App | Duolingo、Quizlet、Khanmigo、Anki | Duolingo Q3'26：DAU 64.9M(+29%)、MAU 153.1M、付费 13.1M、营收 $309M，但 2026-11-09 宣布下线 Max 档。Quizlet 自称 60M+ MAU，2026-08 才上线 Spaced Repetition 且仅网页版。Khanmigo 限美国 18+。Anki 32,788★ | 游戏化＋AI 陪练 |
| 拍照搜题/错题本 | 作业帮、Gauth、Question.AI、StudyX、Photomath | 作业帮题库 19 亿+；P60 学习机 33 亿+真题、770 万+试卷、337 教材版本、3 级错因定位、369 城覆盖；信通院认证"AI 超级老师"提分>42%（凤凰网 2026-10-30） | 立刻要答案 |
| 知识库/RAG | Gemini Notebook（原 NotebookLM）、Notion AI、Recall、Khoj | 2026-07-16 更名 Gemini Notebook，3000 万+ 用户，新增安全云端代码执行（hngn 2026-07-17） | 把资料变成可问答的库 |
| 笔记/资料 | Obsidian、思源、Heptabase、Xmind、Goodnotes | 思源 47,217★（自托管）；Xmind Agent 2026-11-12 发布 | 结构化沉淀 |

## 3. 痛点与空白：纸质资料 → 结构化知识 → 主动复习

- **拍摄端已过剩**：作业帮 19 亿题库，Gauth/Question.AI/StudyX 遍地。
- **结构化环节碎片化**：Gemini Notebook 能读 PDF 但只给摘要、不产复习卡；Anki 有最好的调度器（FSRS）却不认得你的资料；Quizlet 有 5 亿+现成卡但跨天调度 2026-08 才上线且仅网页。
- **"主动复习"是全线最弱一环**：Anki/Quizlet 要你打开 app 才见卡；豆包爱学/作业帮是被动问答＋硬 push。**没有一家把"纸→卡→按遗忘曲线主动推回"做全。**
- 中国侧佐证：洛图科技 RUNTO，2026-08 中国学习平板线上销量 21.2 万台，同比 **-44.7%**、销额 7.5 亿元、-32.2%；而纯软件免费的豆包爱学 2026-06 MAU **1943.81 万**，居中国 AI 原生 APP TOP10 第 6（新浪财经 2026-08-05）。硬件+题库路线在萎缩。

## 4. 自建/私有化

明确支持 self-host：**OpenClaw**（MIT，394,412★ / 82,893 fork；状态、记忆、凭据全在本机）、**Open WebUI**（158,606★，官网称 464M+ 下载、534K+ 社区）、**Khoj**（AGPL-3.0，38,124★）、**思源 SiYuan**（AGPL-3.0，47,217★）、**screenpipe**（22,372★，本地 SQLite 录屏转写）、AnythingLLM / LibreChat / Onyx CE。

三条实证动机：
1. **隐私与信任**：Howdy.com 2026-10 调查 1006 名美国成年人，207 名 agent 用户中 20% 抓到 agent 访问其禁止的信息、13% 发生未授权购买，**32% 不知道 agent 跑在本地还是公司服务器**。
2. **安全**：荷兰 AP 2026-02-12 警告 OpenClaw 类 agent，称约 1/5 插件疑似含恶意代码；Koi 至 02-17 在 ClawHub 数到 824 个恶意 skill。
3. **成本**：模型下沉本地（Ollama），真实成本是硬件、电费与自己的时间。

**结构性空白：几乎所有自建玩家都是通用助手，没有一个是"学习/复习"垂直产品。**

## 5. 2026 趋势

Agentic（问答→行动）；长期记忆成标配层（Anthropic 08-25 记忆合并）；权限闸门＋硬拒绝；主动推送与间隔重复开始合流（Quizlet 08 月上线 SR）；多模态输入（拍照/手写/语音/录屏）；本地优先回潮（Perplexity Personal Computer 2026-03 发布、05-07 全 Mac 用户可用，Mac mini 24/7 常驻）。AI Tutor 市场规模 2026 约 $2.7B，2036 预计 >$34.4B（Fundamental Business Insights, 2026-10-18）。

## 6. 市场空白总结（产品负责人视角）

**不要做"又一个 AI 老师"**——豆包爱学（免费、1943 万 MAU）与作业帮（19 亿题库＋硬件）已双向挤压，K12 付费墙难立。

**真正的空位是那条没人做全的闭环：纸质/散乱资料 → 自动结构化成可复习知识单元 → 按遗忘曲线主动推回。**

1. **强产品在接口处相遇但没人占领。** Anki 有最好的调度器却要你手工造卡；Gemini Notebook 能读 PDF 却只给摘要不给复习计划；作业帮出题即终止。
2. **"主动"这条 2026 行业主线在学习场景没落地。** Muse 每小时更新用户画像、Dots 后台研究、Claude 跨会话记忆——但学习场景的"主动"仍是传统 push，而非"基于你的遗忘曲线＋上周错题＋久未触碰的知识点，生成今天该练的 10 分钟"。
3. **护城河是私有化＋结构化质量，不是模型。** Anki 的壁垒是 FSRS 调度算法与社区卡库，Google 的壁垒是模型与检索；夹在中间的"资料→知识单元"是脏活（手写识别、公式还原、跨资料去重、对齐课标考纲），但做好后学习数据沉淀在本地——正好接上 self-host 需求，而**这个组合目前只有 Anki 生态插件与思源在做，两者都停在"内容管理"，没做"主动复习"**。

**建议切口**：面向大学生/考研/考证/留学等"资料多、周期长、复习需求强、愿付费"人群（高中生付费决策链在家长，列为次选），以本地优先＋可插拔自建架构交付，配 Anki 导出互操作作为信任与迁移成本的解药。
