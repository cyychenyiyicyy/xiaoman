// 打印事件结构与会话方法名
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
const agentDir = resolve(".pi-home");
const runtime = await ModelRuntime.create({ authPath: resolve(agentDir,"auth.json"), modelsPath: resolve(agentDir,"models.json") });
const model = runtime.getModel("deepseek", "deepseek-flash");
const { session, extensionsResult } = await createAgentSession({ cwd: ".", agentDir, modelRuntime: runtime, model, thinkingLevel: "off", tools: [], noTools: "all" });
console.log("AgentSession 方法:", Object.getOwnPropertyNames(Object.getPrototypeOf(session)).filter(n => !n.startsWith("_")).slice(0,40).join(", "));
let shown = 0;
session.subscribe((ev) => {
  if (ev.type === "message_update" && shown < 2) {
    shown++;
    console.log("message_update keys:", Object.keys(ev));
    console.log("payload:", JSON.stringify(ev).slice(0, 400));
  }
});
await session.prompt("只说一句：加速度是速度的变化率。");
await new Promise(r => setTimeout(r, 1200));
console.log("最后消息:", JSON.stringify(session.getLastMessage ? session.getLastMessage() : null).slice(0,300));
process.exit(0);
