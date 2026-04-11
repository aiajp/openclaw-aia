/**
 * SynthAgent ACP Runtime Backend
 *
 * Bridges OpenClaw's ACP session model to SynthAgent's HTTP API.
 *
 * Session model:
 *   SynthAgent supports optional session_id for conversation continuity.
 *   ensureSession() creates a session_id that maps to the OpenClaw sessionKey.
 *   runTurn() forwards prompts to POST /v1/agent/chat/stream and translates
 *   SSE events into AcpRuntimeEvent yields.
 *
 * Protocol mapping:
 *   AcpRuntimeEvent.text_delta  ← SSE event: token
 *   AcpRuntimeEvent.done        ← SSE event: done
 *   AcpRuntimeEvent.error       ← SSE event: error
 *   AcpRuntimeEvent.status      ← SSE event: ping (heartbeat)
 */

import { AcpRuntimeError } from "openclaw/plugin-sdk/acpx";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
} from "openclaw/plugin-sdk/acpx";
import type { SynthAgentAcpConfig } from "./service.js";

const BACKEND_ID = "synthagent-acp";
const HANDLE_PREFIX = "synthagent:v1:";

// ── Handle state encoding ──────────────────────────────────────────

interface HandleState {
  sessionKey: string;
  sessionId: string;
  baseUrl: string;
}

function encodeHandle(state: HandleState): string {
  return HANDLE_PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url");
}

function decodeHandle(runtimeSessionName: string): HandleState {
  if (!runtimeSessionName.startsWith(HANDLE_PREFIX)) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      `Invalid handle: expected ${HANDLE_PREFIX} prefix`,
    );
  }
  const payload = runtimeSessionName.slice(HANDLE_PREFIX.length);
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as HandleState;
}

// ── SSE line parser ────────────────────────────────────────────────

interface SseEvent {
  event?: string;
  data?: string;
}

function parseSseLine(line: string): SseEvent | null {
  if (line.startsWith("event: ")) {
    return { event: line.slice(7).trim() };
  }
  if (line.startsWith("data: ")) {
    return { data: line.slice(6) };
  }
  return null;
}

// ── Runtime implementation ─────────────────────────────────────────

export class SynthAgentAcpRuntime implements AcpRuntime {
  private healthy = false;
  private readonly config: SynthAgentAcpConfig;
  private readonly activeTurns = new Map<string, AbortController>();

  constructor(config: SynthAgentAcpConfig) {
    this.config = config;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async probeHealth(): Promise<void> {
    try {
      const res = await fetch(`${this.config.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      this.healthy = res.ok;
    } catch {
      this.healthy = false;
      throw new Error("SynthAgent health check failed");
    }
  }

  // ── AcpRuntime.ensureSession ──────────────────────────────────

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    // Generate a stable session ID from the OpenClaw sessionKey.
    // SynthAgent uses session_id for conversation continuity.
    const sessionId = `oc_${input.sessionKey.replaceAll(":", "_")}`;

    // Verify reachability before handing back a handle.
    try {
      const res = await fetch(`${this.config.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        throw new Error(`SynthAgent returned ${res.status}`);
      }
      this.healthy = true;
    } catch (cause) {
      this.healthy = false;
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `Cannot reach SynthAgent at ${this.config.baseUrl}`,
        { cause },
      );
    }

    const state: HandleState = {
      sessionKey: input.sessionKey,
      sessionId,
      baseUrl: this.config.baseUrl,
    };

    return {
      sessionKey: input.sessionKey,
      backend: BACKEND_ID,
      runtimeSessionName: encodeHandle(state),
      cwd: input.cwd,
      backendSessionId: sessionId,
    };
  }

  // ── AcpRuntime.runTurn ────────────────────────────────────────

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const state = decodeHandle(input.handle.runtimeSessionName);
    const turnAbort = new AbortController();

    // Link to caller's signal
    if (input.signal) {
      if (input.signal.aborted) {
        turnAbort.abort(input.signal.reason);
      } else {
        input.signal.addEventListener("abort", () => turnAbort.abort(input.signal!.reason), {
          once: true,
        });
      }
    }

    this.activeTurns.set(input.requestId, turnAbort);

    try {
      const body = JSON.stringify({
        message: input.text,
        session_id: state.sessionId,
      });

      const res = await fetch(`${state.baseUrl}/v1/agent/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "x-request-id": input.requestId,
        },
        body,
        signal: turnAbort.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        yield {
          type: "error" as const,
          message: `SynthAgent HTTP ${res.status}: ${errBody}`,
          code: `HTTP_${res.status}`,
          retryable: res.status >= 500,
        };
        yield { type: "done" as const, stopReason: "error" };
        return;
      }

      if (!res.body) {
        yield {
          type: "error" as const,
          message: "SynthAgent returned empty response body",
          code: "EMPTY_BODY",
          retryable: true,
        };
        yield { type: "done" as const, stopReason: "error" };
        return;
      }

      // Parse SSE stream
      let emittedDone = false;
      let currentEvent: string | undefined;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === "") {
              currentEvent = undefined;
              continue;
            }

            const parsed = parseSseLine(trimmed);
            if (!parsed) continue;

            if (parsed.event !== undefined) {
              currentEvent = parsed.event;
              continue;
            }

            if (parsed.data === undefined) continue;

            // Determine event type from "event:" field or parse from data JSON
            let eventType = currentEvent;
            let eventData: Record<string, unknown> = {};

            try {
              eventData = JSON.parse(parsed.data) as Record<string, unknown>;
              if (!eventType && typeof eventData.event === "string") {
                eventType = eventData.event;
              }
            } catch {
              // Non-JSON data line — treat as raw text token
              yield {
                type: "text_delta" as const,
                text: parsed.data,
                stream: "output" as const,
                tag: "agent_message_chunk" as const,
              };
              continue;
            }

            switch (eventType) {
              case "token":
                yield {
                  type: "text_delta" as const,
                  text: String(eventData.content ?? eventData.data ?? ""),
                  stream: "output" as const,
                  tag: "agent_message_chunk" as const,
                };
                break;

              case "done":
                yield { type: "done" as const, stopReason: "end_turn" };
                emittedDone = true;
                break;

              case "ping":
                yield {
                  type: "status" as const,
                  text: "heartbeat",
                  tag: "session_info_update" as const,
                };
                break;

              case "error":
                yield {
                  type: "error" as const,
                  message: String(eventData.error ?? eventData.data ?? "Unknown error"),
                  code: String(eventData.error_type ?? "SYNTHAGENT_ERROR"),
                  retryable: false,
                };
                break;

              default:
                // Unknown event — emit as status
                yield {
                  type: "status" as const,
                  text: `[${eventType ?? "unknown"}] ${JSON.stringify(eventData)}`,
                };
                break;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!emittedDone) {
        yield { type: "done" as const, stopReason: "end_turn" };
      }
    } catch (err: unknown) {
      if (turnAbort.signal.aborted) {
        yield { type: "done" as const, stopReason: "cancelled" };
      } else {
        const message = err instanceof Error ? err.message : String(err);
        yield {
          type: "error" as const,
          message: `SynthAgent request failed: ${message}`,
          code: "ACP_TURN_FAILED",
          retryable: true,
        };
        yield { type: "done" as const, stopReason: "error" };
      }
    } finally {
      this.activeTurns.delete(input.requestId);
    }
  }

  // ── AcpRuntime.cancel ─────────────────────────────────────────

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    // Abort all active turns for this handle
    for (const [reqId, controller] of this.activeTurns) {
      controller.abort(input.reason ?? "cancelled");
      this.activeTurns.delete(reqId);
    }
  }

  // ── AcpRuntime.close ──────────────────────────────────────────

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    // SynthAgent sessions are stateless; no server-side cleanup needed.
    // Cancel any in-flight turns.
    await this.cancel({ handle: input.handle, reason: input.reason });
  }

  // ── AcpRuntime.getCapabilities ────────────────────────────────

  getCapabilities(): AcpRuntimeCapabilities {
    return {
      controls: ["session/status"],
    };
  }

  // ── AcpRuntime.getStatus ──────────────────────────────────────

  async getStatus(input: { handle: AcpRuntimeHandle }): Promise<AcpRuntimeStatus> {
    const state = decodeHandle(input.handle.runtimeSessionName);

    let reachable = false;
    try {
      const res = await fetch(`${state.baseUrl}/ready`, {
        signal: AbortSignal.timeout(5_000),
      });
      reachable = res.ok;
    } catch {
      reachable = false;
    }

    return {
      summary: reachable ? "SynthAgent is reachable" : "SynthAgent is not reachable",
      backendSessionId: state.sessionId,
      details: {
        baseUrl: state.baseUrl,
        reachable,
        activeTurns: this.activeTurns.size,
      },
    };
  }

  // ── AcpRuntime.doctor ─────────────────────────────────────────

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    const details: string[] = [];
    let ok = true;

    // Check health endpoint
    try {
      const res = await fetch(`${this.config.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        details.push(`Health endpoint: OK (${this.config.baseUrl}/health)`);
      } else {
        ok = false;
        details.push(`Health endpoint returned ${res.status}`);
      }
    } catch (err) {
      ok = false;
      details.push(
        `Health endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Check ready endpoint
    try {
      const res = await fetch(`${this.config.baseUrl}/ready`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        details.push(`Ready endpoint: OK (${this.config.baseUrl}/ready)`);
      } else {
        ok = false;
        details.push(`Ready endpoint returned ${res.status} (DB/Redis may be down)`);
      }
    } catch (err) {
      ok = false;
      details.push(
        `Ready endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Check API key
    if (!this.config.apiKey) {
      ok = false;
      details.push("API key not configured (set SYNTHAGENT_API_KEY or plugin config)");
    } else {
      details.push(`API key: configured (${this.config.apiKey.slice(0, 8)}...)`);
    }

    this.healthy = ok;

    return {
      ok,
      code: ok ? undefined : "SYNTHAGENT_UNHEALTHY",
      message: ok ? "SynthAgent ACP backend is healthy" : "SynthAgent ACP backend has issues",
      details,
    };
  }
}
