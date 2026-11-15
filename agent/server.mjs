// 小满 · Pi 网关（P0）
// 职责：把 Pi 的会话/循环/流式包成我们的 SSE，不写任何 AI 逻辑。
// 每个学科 = 一个 Pi session 文件；不常驻内存，每次请求 SessionManager.open() 恢复。
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, ".pi-home");
const SESS_DIR = resolve(HERE, ".pi-sessions");
const INDEX = resolve(SESS_DIR, "index.json");
const PORT = Number(process.env.PI_PORT || 8791);
const CWD = HERE;

mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(SESS_DIR, { recursive: true });

const SUBJECTS = ["全部", "语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理"];

// ── 模型配置：一个 OpenAI 兼容 provider（P4 会改成 FastAPI 生成）──
function writeModels() {
  const baseUrl = process.env.PI_BASE_URL || "https://api.deepseek.com/v1";
  const modelId = process.env.PI_MODEL || "deepseek-flash";
  const cfg = {
    providers: {
      xiaoman: {
        baseUrl,
        api: "openai-completions",
        apiKey: "$DEEPSEEK_API_KEY",
        models: [
          {
            id: modelId,
            name: modelId,
            contextWindow: Number(process.env.PI_CONTEXT || 128000),
            maxTokens: 4096,
          },
        ],
      },
    },
  };
  writeFileSync(resolve(AGENT_DIR, "models.json"), JSON.stringify(cfg, null, 2));
}

// ── 学科 → session 文件 ────────────────────────────────
function readIndex() {
  try {
    return JSON.parse(readFileSync(INDEX, "utf8"));
  } catch {
    return {};
  }
}
function writeIndex(idx) {
  writeFileSync(INDEX, JSON.stringify(idx, null, 2));
}

function sessionFor(subject, create = false) {
  const idx = readIndex();
  const saved = idx[subject];
  if (saved && existsSync(saved)) return { sm: SessionManager.open(saved, SESS_DIR, CWD), created: false };
  if (!create) return null;
  return { sm: SessionManager.create(CWD, SESS_DIR), created: true };
}

function saveSessionFile(subject, sm) {
  const file = sm.getSessionFile();
  if (!file) return;
  const idx = readIndex();
  idx[subject] = file;
  writeIndex(idx);
}

// ── 事件映射：Pi → 我们的 SSE 形状（界面不认识 Pi）──────
function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const THINK = { off: "off", low: "low", med: "medium", high: "high" };

async function handleChat(req, res, body) {
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
  const modelId = process.env.PI_MODEL || "deepseek-flash";
  const model = runtime.getModel("xiaoman", modelId);
  if (!model) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "model not found" }));
    return;
  }

  const found = sessionFor(subject, true);
  const { session } = await createAgentSession({
    cwd: CWD,
    agentDir: AGENT_DIR,
    modelRuntime: runtime,
    model,
    thinkingLevel: THINK[body.thinking] || "off",
    sessionManager: found.sm,
    tools: [],
    noTools: "all",
  });

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  sse(res, { type: "meta", subject, model: modelId, thinking: body.thinking || "off" });

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    saveSessionFile(subject, found.sm);
    sse(res, { type: "done" });
    res.end();
    session.dispose?.();
  };

  session.subscribe((ev) => {
    const ame = ev.assistantMessageEvent;
    if (ev.type === "message_update" && ame) {
      if (ame.type === "thinking_delta" && ame.delta) sse(res, { type: "reasoning", delta: ame.delta });
      else if (ame.type === "text_delta" && ame.delta) sse(res, { type: "text", delta: ame.delta });
      return;
    }
    if (ev.type === "tool_execution_start") {
      sse(res, { type: "tool", name: ev.toolName, state: "start" });
      return;
    }
    if (ev.type === "tool_execution_end") {
      sse(res, { type: "tool", name: ev.toolName, state: "end" });
      return;
    }
    if (ev.type === "agent_end" || ev.type === "agent_settled") done();
  });

  try {
    await session.prompt(text);
  } catch (err) {
    sse(res, { type: "error", code: "pi", message: String(err).slice(0, 400) });
    done();
    return;
  }
  // 兜底：prompt 返回后若事件已结束
  setTimeout(done, 30000);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, subjects: Object.keys(readIndex()), port: PORT }));
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
    await handleChat(req, res, body);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ detail: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`pi gateway on http://127.0.0.1:${PORT}`);
});