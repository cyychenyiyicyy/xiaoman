import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const dir = resolve(".pi-probe"); mkdirSync(dir, { recursive: true });
const variants = [
  { name: "最小", model: { id: "deepseek-flash", name: "deepseek-flash", contextWindow: 128000, maxTokens: 4096 } },
  { name: "带 input/cost", model: { id: "deepseek-flash", name: "deepseek-flash", input: ["text","image"], reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 } },
  { name: "带 images 字段", model: { id: "deepseek-flash", name: "deepseek-flash", input: ["text","image"], images: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
      compat: { supportsImages: true } } },
];
for (const v of variants) {
  writeFileSync(resolve(dir, "models.json"), JSON.stringify({ providers: { xiaoman: {
    baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "$DEEPSEEK_API_KEY", models: [v.model] } } }, null, 2));
  try {
    const rt = await ModelRuntime.create({ authPath: resolve(dir, "auth.json"), modelsPath: resolve(dir, "models.json") });
    const m = rt.getModel("xiaoman", "deepseek-flash");
    console.log(v.name, "->", m ? `OK input=${JSON.stringify(m.input)}` : "NOT FOUND");
  } catch (e) { console.log(v.name, "-> THREW", String(e).slice(0,120)); }
}
