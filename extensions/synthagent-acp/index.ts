import type { OpenClawPluginApi } from "openclaw/plugin-sdk/acpx";
import { createSynthAgentAcpService } from "./src/service.js";

const plugin = {
  id: "synthagent-acp",
  name: "SynthAgent ACP Backend",
  description: "ACP runtime backend that bridges OpenClaw sessions to SynthAgent HTTP API.",
  register(api: OpenClawPluginApi) {
    api.registerService(createSynthAgentAcpService({ pluginConfig: api.pluginConfig }));
  },
};

export default plugin;
