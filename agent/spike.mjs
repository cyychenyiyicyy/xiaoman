// Pi SDK 一天验证：createAgentSession → subscribe → prompt → getEntries
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const here = resolve(".");
const agentDir = resolve(here, ".pi-home");
mkdirSync(agentDir, { recursive: true });

// 自定义 provider（DeepSeek OpenAI 兼容端点），key 走环境变量
writeFileSync(
  resolve(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          api: "openai-completions",
          apiKey: "$DEEPSEEK_API_KEY",
          models: [{ id: "deepseek-flash", contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    },
    null,
    2
  )
);

const runtime = await ModelRuntime.create({
  authPath: resolve(agentDir, "auth.json"),
  modelsPath: resolve(agentDir, "models.json"),
});
console.log("providers:", typeof runtime.getProviderIds === "function" ? runtime.getProviderIds() : "(no getter)");

const model = runtime.getModel ? runtime.getModel("deepseek", "deepseek-flash") : undefined;
console.log("model:", model ? model.id : "(not found)");

const { session } = await createAgentSession({
  cwd: here,
  agentDir,
  modelRuntime: runtime,
  model,
  thinkingLevel: "off",
  tools: [],
  noTools: "all",
});

const types = [];
const text = [];
const sub = session.subscribe((ev) => {
  types.push(ev.type);
  if (ev.type === "message_update") {
    const d = ev.delta || ev;
    if (d && typeof d.text === "string") text.push(d.text);
  }
});

await session.prompt("用一句话说什么是加速度。");
await new Promise((r) => setTimeout(r, 1500));

console.log("事件类型:", [...new Set(types)]);
console.log("正文片段:", text.join("").slice(0, 120));
console.log("有 getEntries:", typeof session.getEntries === "function");
if (typeof session.getEntries === "function") {
  const entries = await session.getEntries();
  console.log("entries 数:", entries.length);
}
if (sub && typeof sub.close === "function") sub.close();
await session.shutdown?.();
process.exit(0);