// 小满 · Pi 网关
// 职责：Pi 的会话/循环/流式 → 我们的 SSE；工具回打 FastAPI。
// 每个学科 = 一个 Pi session 文件；不常驻内存，每请求 SessionManager.open() 恢复。
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, ".pi-home");
const SESS_DIR = resolve(HERE, ".pi-sessions");
const INDEX = resolve(SESS_DIR, "index.json");
const PORT = Number(process.env.PI_PORT || 8791);
const CWD = HERE;
const FASTAPI = process.env.PI_FASTAPI || "http://127.0.0.1:8787/api/v1";
const TOKEN = process.env.PI_INTERNAL_TOKEN || "dev-internal-token";

mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(SESS_DIR, { recursive: true });

const SUBJECTS = ["全部", "语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理"];

// 把 .pi-home/skills/*/SKILL.md 正文拼进人设：我们的工具白名单挡掉了 Pi 的 skill 触发，
// 直接注入保证「讲题 → 查库 → 补答案」这套流程一定生效
function loadSkills(only) {
  var dir = resolve(AGENT_DIR, "skills");
  if (!existsSync(dir)) return "";
  var out = [];
  for (const name of readdirSync(dir)) {
    if (only && only.indexOf(name) < 0) continue;
    const f = resolve(dir, name, "SKILL.md");
    if (!existsSync(f)) continue;
    const raw = readFileSync(f, "utf8");
    const body = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
    if (body) out.push(`## 技能：${name}\n${body}`);
  }
  return out.length ? "\n\n" + out.join("\n\n") : "";
}

function xiaomanPrompt(subject, activeSkills) {
  const d = new Date();
  const today = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `你是小满，一个陪着一个高一学生学习的伙伴。她叫小满，是名字，不是「AI 助手」。

今天是 ${today}。当前学科空间：${subject || "全部"}。

说话方式：
- 短。一条回复一般不超过 4 行；要展开时先给结论，再给细节。
- 像老师，不像客服。禁止「您好，请问有什么可以帮您」这类腔调。
- 不评判人，把错归到机制上：「这里漏的是摩擦力」，不说「你又粗心」。
- 不确定就说不确定；库里没有的不要编。公式用行内 LaTeX（$...$）。
- 中文回答。

你可以用的工具：memory_search / memory_add / memory_update / memory_delete（长期记住的关于她的事）、web_search（联网搜索，时效问题用）、question_search / question_add / question_update（她的题库）、quiz_create（给她出一道检测题）。
不要读文件、不要执行命令、不要跟她聊「网关 / 工具 / 系统」这些实现细节——那些不是她该听到的。
她问「记住…」时，用 memory_add 记下来再简短确认。
当前启用了讲题流程时，按下面技能里的步骤做。` + loadSkills(activeSkills);
}

function writeModels() {
  const cfg = {
    providers: {
      xiaoman: {
        baseUrl: process.env.PI_BASE_URL || "https://api.deepseek.com/v1",
        api: "openai-completions",
        apiKey: "$DEEPSEEK_API_KEY",
        models: [
          {
            id: process.env.PI_MODEL || "deepseek-flash",
            name: process.env.PI_MODEL || "deepseek-flash",
            input: ["text", "image"],
            reasoning: true,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: Number(process.env.PI_CONTEXT || 128000),
            maxTokens: 4096,
            promptCache: { short: 300 },
          },
        ],
      },
    },
  };
  writeFileSync(resolve(AGENT_DIR, "models.json"), JSON.stringify(cfg, null, 2));
}

function readIndex() {
  try {
    return JSON.parse(readFileSync(INDEX, "utf8"));
  } catch {
    return {};
  }
}
function saveSessionFile(subject, sm) {
  const file = sm.getSessionFile();
  if (!file) return;
  const idx = readIndex();
  idx[subject] = file;
  writeFileSync(INDEX, JSON.stringify(idx, null, 2));
}

// ── 回打 FastAPI ─────────────────────────────────────
async function callTool(path, body) {
  const resp = await fetch(`${FASTAPI}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": TOKEN },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${path} → HTTP ${resp.status}`);
  return resp.json();
}

function cardsText(result, limit = 2000) {
  return JSON.stringify(result).slice(0, limit);
}

// 每个请求一份收集器：工具来源 / 新记忆
function makeTools(collect, caps, ctx) {
  const wrap = (name, label, description, parameters, run, extra) =>
    defineTool({
      name,
      label,
      description,
      parameters,
      ...(extra || {}),
      async execute(_id, params) {
        const result = await run(params);
        if (Array.isArray(result.sources)) {
          for (const s of result.sources) {
            collect.sources.push(s);
            collect.emit({ type: "source", item: s });
          }
        }
        if (result.item) {
          collect.remembered.push(result.item);
          collect.emit({ type: "memory", items: [result.item] });
        }
        return { content: [{ type: "text", text: cardsText(result) }], details: result };
      },
    });

  const base = [
    wrap(
      "memory_search",
      "检索记忆",
      "检索你长期记住的关于她的事（薄弱点、偏好、习惯、目标）。问到她的情况或需要个性化建议时先调它。",
      Type.Object({ query: Type.String({ description: "检索关键词，用她的话即可" }) }),
      (p) => callTool("/internal/tools/memory_search", { query: p.query })
    ),
    wrap(
      "memory_add",
      "记住",
      "记住一件关于她的事。她说「记住…」，或出现稳定的学习事实/偏好时调用。text ≤ 40 字。",
      Type.Object({
        text: Type.String({ description: "一句话，主语用「她」" }),
        kind: Type.Union([Type.Literal("fact"), Type.Literal("pref")], { description: "fact=事实，pref=偏好" }),
        subject: Type.Optional(Type.String({ description: "学科，可空" })),
      }),
      (p) => callTool("/internal/tools/memory_add", { text: p.text, kind: p.kind || "fact", subject: p.subject || "" })
    ),
    wrap(
      "memory_update",
      "修正记忆",
      "修正一条已有记忆（先用 memory_search 拿 id）。",
      Type.Object({
        id: Type.String(),
        text: Type.Optional(Type.String()),
        kind: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("pref")])),
        subject: Type.Optional(Type.String()),
      }),
      (p) => callTool("/internal/tools/memory_update", p)
    ),
    wrap(
      "memory_delete",
      "忘掉",
      "删掉一条记忆（归档、可恢复）。用户说「忘掉这条」时用，先用 memory_search 拿 id。",
      Type.Object({ id: Type.String() }),
      (p) => callTool("/internal/tools/memory_delete", { id: p.id })
    ),
    wrap(
      "web_search",
      "联网搜索",
      "联网搜索。涉及新闻、价格、赛事、最新数据这类时效问题时调用。",
      Type.Object({ query: Type.String({ description: "搜索词" }) }),
      (p) => callTool("/internal/tools/web_search", { query: p.query })
    ),
  ];

  // 题库 + 出题：只在「讲题 / 检测」场景装载，其余时候不挂（不用就卸载）
  if (!caps || !caps.questions) return base;
  return base.concat([
    wrap(
      "question_search",
      "查题库",
      "在她的题库里检索题目（按题干关键词 / 学科）。她自己问「我那道题」「题库里有没有…」时用。返回题目 id、题干、选项、答案。",
      Type.Object({
        query: Type.Optional(Type.String({ description: "题干关键词" })),
        subject: Type.Optional(Type.String({ description: "学科，留空=全部" })),
        limit: Type.Optional(Type.Number({ description: "最多几条，默认 5" })),
      }),
      (p) =>
        callTool("/internal/tools/question_search", {
          query: p.query || "",
          subject: p.subject || "",
          limit: Math.min(10, Math.max(1, p.limit || 5)),
        }),
      { promptGuidelines: ["回答任何题目之前，先调用 question_search 确认题库里有没有这道题。"] }
    ),
    wrap(
      "question_add",
      "新增题目",
      "把一道题存进她的题库。她说「把这道题收进题库」或你整理出新题时用。题干和答案都要完整。",
      Type.Object({
        subject: Type.String({ description: "学科" }),
        stem: Type.String({ description: "题干（含选项也可以）" }),
        answer: Type.Optional(Type.String({ description: "答案" })),
        options: Type.Optional(Type.Array(Type.String(), { description: "选项数组，可空" })),
        qtype: Type.Optional(
          Type.Union([Type.Literal("choice"), Type.Literal("blank"), Type.Literal("short"), Type.Literal("essay")], {
            description: "题型",
          })
        ),
      }),
      (p) =>
        callTool("/internal/tools/question_add", {
          subject: p.subject || "全部",
          stem: p.stem,
          answer: p.answer || "",
          options: p.options || [],
          qtype: p.qtype || "short",
        }),
      { promptGuidelines: ["答案算出来后必须写进题库，不要问用户是否要收录。"] }
    ),
    wrap(
      "question_update",
      "改题库题目",
      "修改题库里已有的题目（先用 question_search 拿到 id）。只改她说的字段，其它不要动。",
      Type.Object({
        id: Type.String({ description: "题目 id" }),
        stem: Type.Optional(Type.String()),
        answer: Type.Optional(Type.String()),
        options: Type.Optional(Type.Array(Type.String())),
        subject: Type.Optional(Type.String()),
        qtype: Type.Optional(Type.String()),
      }),
      (p) => callTool("/internal/tools/question_update", p),
      { promptGuidelines: ["题库里已有题目但答案为空或题干有错时，直接改，不要询问。"] }
    ),
    wrap(
      "quiz_create",
      "出题检测",
      "给她出一道题，检查她真的会了没有。讲完一道题、她说「考考我 / 测一测」，或你想确认她是否听懂时调用。题目会变成一张可作答的卡片出现在对话里。",
      Type.Object({
        stem: Type.String({ description: "题干（完整、可独立作答）" }),
        options: Type.Array(Type.String(), { description: "四个选项，形如 ['A. …','B. …']；开放题传空数组" }),
        answer: Type.String({ description: "正确答案（选择题写字母，如 B）" }),
        explanation: Type.Optional(Type.String({ description: "一句解析，答完才展示" })),
        kps: Type.Optional(Type.Array(Type.String(), { description: "考的知识点名（用教材叫法）" })),
        question_id: Type.Optional(Type.String({ description: "如果就是题库里那道题的重做，传它的 id" })),
        difficulty: Type.Optional(Type.Number({ description: "1–5" })),
      }),
      (p) =>
        callTool("/internal/tools/quiz_create", {
          conversation_id: (ctx && ctx.conversation_id) || "",
          message_id: (ctx && ctx.message_id) || "",
          subject: (ctx && ctx.subject) || "全部",
          stem: p.stem,
          options: p.options || [],
          answer: p.answer || "",
          explanation: p.explanation || "",
          kps: p.kps || [],
          question_id: p.question_id || "",
        }),
      {
        promptGuidelines: [
          "出完题只用一句话说「来，做一道」，不要在这轮里报答案或解析；卡片会自己收答案。",
          "一次只出一道；优先考她刚问的那个知识点，不要超纲。",
          "选择题给四个选项；答案只写字母。",
        ],
      }
    ),
  ]);
}

const THINK = { off: "off", low: "low", med: "medium", high: "high" };

// 这一轮要不要装「讲题」能力：引用题目了，或者话里在问题目
const QUESTION_RE = /(这|那|哪)道?题|怎么(做|解|写|选)|为什么(选|错)|解析|答案解析|题库|对不对|答案是什么|求[解值]|考考|考我|测一测|测一下|检测|会不会|出(一)?道题/;

function planCapabilities(body, text) {
  const byRef = Array.isArray(body.question_ids) && body.question_ids.length > 0;
  const byText = QUESTION_RE.test(text || "");
  const questions = byRef || byText;
  return { questions, skills: questions ? ["answer-question"] : [] };
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function handleChat(res, body) {
  const subject = SUBJECTS.includes(body.subject) ? body.subject : "全部";
  const text = String(body.text || "").trim();
  if (!text) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "empty" }));
    return;
  }

  writeModels();
  const runtime = await ModelRuntime.create({
    authPath: resolve(AGENT_DIR, "auth.json"),
    modelsPath: resolve(AGENT_DIR, "models.json"),
  });
  const model = runtime.getModel("xiaoman", process.env.PI_MODEL || "deepseek-flash");
  if (!model) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "model not found" }));
    return;
  }

  const convKey = body.conversation_id ? `conv:${body.conversation_id}` : `subj:${subject}`;
  const idx = readIndex();
  const saved = idx[convKey];
  const sm = saved && existsSync(saved) ? SessionManager.open(saved, SESS_DIR, CWD) : SessionManager.create(CWD, SESS_DIR);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const collect = { sources: [], remembered: [], parts: [], emit: (o) => sse(res, o) };
  const caps = planCapabilities(body, body.text || "");
  const tools = makeTools(collect, caps, { conversation_id: body.conversation_id || "", message_id: body.assistant_message_id || "", subject });

  const loader = new DefaultResourceLoader({
    cwd: CWD,
    agentDir: AGENT_DIR,
    systemPromptOverride: () => xiaomanPrompt(subject, caps.skills),
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: CWD,
    agentDir: AGENT_DIR,
    modelRuntime: runtime,
    model,
    thinkingLevel: THINK[body.thinking] || "off",
    sessionManager: sm,
    resourceLoader: loader,
    customTools: tools,
    tools: tools.map((t) => t.name),
  });

  try { session.sessionName = subject; } catch {}
  sse(res, { type: "meta", subject, model: model.name, thinking: body.thinking || "off" });

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    saveSessionFile(subject, sm);
    // usage / 成本（Pi 的 message.usage：input/output/cacheRead/cacheWrite/cost）
    let usage = { prompt_tokens: 0, completion_tokens: 0, cache_hit: 0, cache_miss: 0, cost: 0 };
    try {
      const msgs = session.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const u = msgs[i]?.usage;
        if (u && (u.output || u.input || u.cacheRead)) {
          usage = {
            prompt_tokens: (u.input || 0) + (u.cacheRead || 0),
            completion_tokens: u.output || 0,
            cache_hit: u.cacheRead || 0,
            cache_miss: u.input || 0,
            cost: u.cost?.total ?? (u.cost || 0),
          };
          break;
        }
      }
    } catch {}
    sse(res, {
      type: "done",
      usage,
      sources: collect.sources,
      tools: collect.parts.filter((p) => p.type === "tool").map((p) => p.name),
      remembered: collect.remembered,
      parts: collect.parts,
    });
    res.end();
    session.dispose?.();
  };

  let reasonPart = null;
  let textPart = null;
  session.subscribe((ev) => {
    const ame = ev.assistantMessageEvent;
    if (ev.type === "message_update" && ame) {
      if (ame.type === "thinking_delta" && ame.delta) {
        if (!reasonPart) {
          reasonPart = { type: "reasoning", text: "", ms: 0, _t0: Date.now() };
          collect.parts.push(reasonPart);
        }
        reasonPart.text += ame.delta;
        sse(res, { type: "reasoning", delta: ame.delta });
        return;
      }
      if (ame.type === "text_delta" && ame.delta) {
        if (!textPart) {
          textPart = { type: "text", text: "" };
          collect.parts.push(textPart);
        }
        textPart.text += ame.delta;
        sse(res, { type: "text", delta: ame.delta });
        return;
      }
      if (ame.type === "thinking_end" && reasonPart && !reasonPart.ms) {
        reasonPart.ms = Date.now() - reasonPart._t0;
        delete reasonPart._t0;
      }
      return;
    }
    if (ev.type === "tool_execution_start") {
      collect.parts.push({ type: "tool", name: ev.toolName, queries: ev.args?.query ? [String(ev.args.query)] : [], count: 0 });
      sse(res, { type: "tool", name: ev.toolName, state: "start", queries: ev.args?.query ? [String(ev.args.query)] : [] });
      return;
    }
    if (ev.type === "tool_execution_end") {
      for (let i = collect.parts.length - 1; i >= 0; i--) {
        if (collect.parts[i].type === "tool" && collect.parts[i].name === ev.toolName) {
          collect.parts[i].count = 1;
          break;
        }
      }
      sse(res, { type: "tool", name: ev.toolName, state: "end", count: 1 });
      return;
    }
    // 官方建议：agent_settled 才代表 Pi 不会再自动继续（agent_end 之后可能有重试/排队）
    if (ev.type === "agent_settled") finish();
  });

  // 多模态：把附件读成 ImageContent（{type:'image', data: base64, mimeType}）
  const images = [];
  for (const file of body.images || []) {
    try {
      const data = readFileSync(file).toString("base64");
      const ext = String(file).toLowerCase().split(".").pop();
      const mimeType =
        ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
      images.push({ type: "image", data, mimeType });
    } catch {
      /* 单张读不到就跳过，不让整轮失败 */
    }
  }
  const promptOpts = images.length ? { images } : undefined;
  try {
    if (session.isStreaming) await session.steer(text, promptOpts);
    else await session.prompt(text, promptOpts);
  } catch (err) {
    sse(res, { type: "error", code: "pi", message: String(err).slice(0, 400) });
  }
  finish();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, subjects: Object.keys(readIndex()), port: PORT }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/debug/plan") {
    const text = url.searchParams.get("text") || "";
    const caps = planCapabilities({ question_ids: (url.searchParams.get("qids") || "").split(",").filter(Boolean) }, text);
    const dummy = { sources: [], remembered: [], parts: [], emit: () => {} };
    const names = makeTools(dummy, caps).map((t) => t.name);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ text, caps, tools: names }, null, 2));
    return;
  }
  if (req.method === "POST" && url.pathname === "/agent/chat") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      res.writeHead(400).end();
      return;
    }
    await handleChat(res, body);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ detail: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => console.log(`pi gateway on http://127.0.0.1:${PORT}`));
