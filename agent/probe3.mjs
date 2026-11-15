import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
const rt = await ModelRuntime.create({ authPath: resolve(".pi-home","auth.json"), modelsPath: resolve(".pi-home","models.json") });
console.log("model:", rt.getModel("xiaoman", process.env.PI_MODEL || "deepseek-flash") ? "OK" : "NOT FOUND");
console.log("providers:", rt.getProvider ? rt.getProvider("xiaoman") : "(no getter)");
