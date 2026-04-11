import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk/acpx";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/acpx";
import { SynthAgentAcpRuntime } from "./runtime.js";

const BACKEND_ID = "synthagent-acp";

export interface SynthAgentAcpConfig {
  baseUrl: string;
  apiKey: string;
  timeoutSeconds: number;
}

export interface CreateSynthAgentAcpServiceParams {
  pluginConfig?: Record<string, unknown>;
}

function resolveConfig(
  pluginConfig?: Record<string, unknown>,
  ctxConfig?: Record<string, unknown>,
): SynthAgentAcpConfig {
  const raw = { ...pluginConfig, ...ctxConfig };
  return {
    baseUrl:
      (raw.baseUrl as string | undefined) ??
      process.env.SYNTHAGENT_BASE_URL ??
      "http://localhost:8000",
    apiKey: (raw.apiKey as string | undefined) ?? process.env.SYNTHAGENT_API_KEY ?? "",
    timeoutSeconds: (raw.timeoutSeconds as number | undefined) ?? 120,
  };
}

export function createSynthAgentAcpService(
  params: CreateSynthAgentAcpServiceParams = {},
): OpenClawPluginService {
  let lifecycleRevision = 0;

  return {
    id: `${BACKEND_ID}-service`,

    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const rev = ++lifecycleRevision;
      const config = resolveConfig(params.pluginConfig, ctx.config);

      if (!config.apiKey) {
        ctx.log?.warn?.(
          "[synthagent-acp] No API key configured. Set SYNTHAGENT_API_KEY or plugin config apiKey.",
        );
      }

      const runtime = new SynthAgentAcpRuntime(config);

      registerAcpRuntimeBackend({
        id: BACKEND_ID,
        runtime,
        healthy: () => runtime.isHealthy(),
      });

      // Fire-and-forget health probe
      runtime.probeHealth().catch(() => {
        if (lifecycleRevision === rev) {
          ctx.log?.warn?.(`[synthagent-acp] SynthAgent not reachable at ${config.baseUrl}`);
        }
      });
    },

    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      ++lifecycleRevision;
      unregisterAcpRuntimeBackend(BACKEND_ID);
    },
  };
}
