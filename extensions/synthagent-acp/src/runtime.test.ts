import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runAcpRuntimeAdapterContract } from "../../../src/acp/runtime/adapter-contract.testkit.js";
import { SynthAgentAcpRuntime } from "./runtime.js";
import type { SynthAgentAcpConfig } from "./service.js";

// ── Mock SynthAgent HTTP server ────────────────────────────────────

let mockServer: http.Server;
let mockPort: number;
let lastRequestBody: Record<string, unknown> | null = null;
let serverBehavior: "stream" | "sync-error" | "empty-body" | "hang" | "500" = "stream";

function sseChunk(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      mockServer = http.createServer((req, res) => {
        // Collect request body
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          if (body) {
            try {
              lastRequestBody = JSON.parse(body) as Record<string, unknown>;
            } catch {
              lastRequestBody = null;
            }
          }

          const url = req.url ?? "";

          // Health endpoints
          if (url === "/health" || url === "/ready") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }

          // Streaming chat endpoint
          if (url === "/v1/agent/chat/stream" && req.method === "POST") {
            // Check API key
            const apiKey = req.headers["x-api-key"];
            if (!apiKey) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Unauthorized" }));
              return;
            }

            switch (serverBehavior) {
              case "stream": {
                res.writeHead(200, {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  Connection: "keep-alive",
                });
                res.write(sseChunk("token", { content: "Hello" }));
                res.write(sseChunk("token", { content: " world" }));
                res.write(sseChunk("done", { finish_reason: "stop", content: "Hello world" }));
                res.end();
                break;
              }
              case "500": {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Internal Server Error" }));
                break;
              }
              case "empty-body": {
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.end();
                break;
              }
              case "hang": {
                res.writeHead(200, {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                });
                // Never end — caller must abort
                break;
              }
              default: {
                res.writeHead(400);
                res.end("Bad request");
              }
            }
            return;
          }

          res.writeHead(404);
          res.end("Not found");
        });
      });
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address();
        if (addr && typeof addr === "object") {
          mockPort = addr.port;
        }
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    }),
);

afterEach(() => {
  serverBehavior = "stream";
  lastRequestBody = null;
});

// ── Helpers ────────────────────────────────────────────────────────

function createConfig(overrides?: Partial<SynthAgentAcpConfig>): SynthAgentAcpConfig {
  return {
    baseUrl: `http://127.0.0.1:${mockPort}`,
    apiKey: "sa_test_unit",
    timeoutSeconds: 10,
    ...overrides,
  };
}

function createRuntime(overrides?: Partial<SynthAgentAcpConfig>): SynthAgentAcpRuntime {
  return new SynthAgentAcpRuntime(createConfig(overrides));
}

// ── Tests ──────────────────────────────────────────────────────────

describe("SynthAgentAcpRuntime", () => {
  // ── Adapter contract ─────────────────────────────────────────

  it("passes the ACP adapter contract suite", async () => {
    await runAcpRuntimeAdapterContract({
      createRuntime: () => createRuntime(),
      agentId: "synthagent",
      successPrompt: "hello",
      includeControlChecks: true,
      assertSuccessEvents: (events) => {
        expect(events.some((e) => e.type === "text_delta")).toBe(true);
        expect(events.some((e) => e.type === "done")).toBe(true);
      },
    });
  });

  // ── ensureSession ────────────────────────────────────────────

  describe("ensureSession", () => {
    it("returns a valid handle on healthy server", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:synthagent:acp:test-123",
        agent: "synthagent",
        mode: "oneshot",
      });

      expect(handle.sessionKey).toBe("agent:synthagent:acp:test-123");
      expect(handle.backend).toBe("synthagent-acp");
      expect(handle.runtimeSessionName).toMatch(/^synthagent:v1:/);
      expect(handle.backendSessionId).toContain("oc_agent_synthagent_acp_test-123");
    });

    it("marks runtime as healthy after successful session", async () => {
      const runtime = createRuntime();
      expect(runtime.isHealthy()).toBe(false);

      await runtime.ensureSession({
        sessionKey: "agent:synthagent:acp:health-check",
        agent: "synthagent",
        mode: "oneshot",
      });

      expect(runtime.isHealthy()).toBe(true);
    });

    it("throws ACP_SESSION_INIT_FAILED on unreachable server", async () => {
      const runtime = createRuntime({ baseUrl: "http://127.0.0.1:1" });

      await expect(
        runtime.ensureSession({
          sessionKey: "agent:synthagent:acp:unreachable",
          agent: "synthagent",
          mode: "oneshot",
        }),
      ).rejects.toThrow(/Cannot reach SynthAgent/);
    });
  });

  // ── runTurn ──────────────────────────────────────────────────

  describe("runTurn", () => {
    it("streams text_delta and done events from SSE", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:synthagent:acp:stream-test",
        agent: "synthagent",
        mode: "oneshot",
      });

      const events = [];
      for await (const event of runtime.runTurn({
        handle,
        text: "hello",
        mode: "prompt",
        requestId: "req-1",
      })) {
        events.push(event);
      }

      const textDeltas = events.filter((e) => e.type === "text_delta");
      expect(textDeltas).toHaveLength(2);
      expect(textDeltas[0]).toMatchObject({ type: "text_delta", text: "Hello" });
      expect(textDeltas[1]).toMatchObject({ type: "text_delta", text: " world" });

      const doneEvents = events.filter((e) => e.type === "done");
      expect(doneEvents).toHaveLength(1);
    });

    it("forwards the prompt in request body", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:synthagent:acp:body-test",
        agent: "synthagent",
        mode: "oneshot",
      });

      for await (const _ of runtime.runTurn({
        handle,
        text: "test prompt content",
        mode: "prompt",
        requestId: "req-body",
      })) {
        // consume
      }

      expect(lastRequestBody).toMatchObject({
        message: "test prompt content",
        session_id: expect.stringContaining("oc_"),
      });
    });

    it("sends x-api-key header", async () => {
      const runtime = createRuntime({ apiKey: "" });
      const handle = await runtime.ensureSession({
        sessionKey: "agent:synthagent:acp:no-key",
        agent: "synthagent",
        mode: "oneshot",
      });

      const events = [];
      for await (const event of runtime.runTurn({
        handle,
        text: "no key",
        mode: "prompt",
        requestId: "req-nokey",
      })) {
        events.push(event);
      }

      // Server returns 401 without API key
      expect(events.some((e) => e.type === "error")).toBe(true);
    });

    it("handles HTTP 500 with error event", async () => {
      serverBehavior = "500";
      const runtime = createRuntime();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:synthagent:acp:500-test",
        agent: "synthagent",
        mode: "oneshot",
      });

      const events = [];
      for await (const event of runtime.runTurn({
        handle,
        text: "trigger 500",
        mode: "prompt",
        requestId: "req-500",
      })) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent).toMatchObject({
        type: "error",
        code: "HTTP_500",
        retryable: true,
      });
    });

    it("emits done even when stream ends without done event", async () => {
      serverBehavior = "empty-body";
      const runtime = createRuntime();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:synthagent:acp:empty-test",
        agent: "synthagent",
        mode: "oneshot",
      });

      const events = [];
      for await (const event of runtime.runTurn({
        handle,
        text: "empty",
        mode: "prompt",
        requestId: "req-empty",
      })) {
        events.push(event);
      }

      expect(events.some((e) => e.type === "done")).toBe(true);
    });

    it("supports cancellation via AbortSignal", async () => {
      serverBehavior = "hang";
      const runtime = createRuntime();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:synthagent:acp:cancel-test",
        agent: "synthagent",
        mode: "oneshot",
      });

      const abortController = new AbortController();
      const events = [];

      // Abort after a short delay
      setTimeout(() => abortController.abort("test cancel"), 50);

      for await (const event of runtime.runTurn({
        handle,
        text: "hang",
        mode: "prompt",
        requestId: "req-cancel",
        signal: abortController.signal,
      })) {
        events.push(event);
      }

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toMatchObject({ type: "done", stopReason: "cancelled" });
    });
  });

  // ── cancel / close ───────────────────────────────────────────

  describe("cancel", () => {
    it("aborts active turns", async () => {
      serverBehavior = "hang";
      const runtime = createRuntime();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:synthagent:acp:cancel-method",
        agent: "synthagent",
        mode: "oneshot",
      });

      const turnPromise = (async () => {
        const events = [];
        for await (const event of runtime.runTurn({
          handle,
          text: "will be cancelled",
          mode: "prompt",
          requestId: "req-cancel-method",
        })) {
          events.push(event);
        }
        return events;
      })();

      // Let the turn start, then cancel
      await new Promise((r) => setTimeout(r, 50));
      await runtime.cancel({ handle, reason: "test" });

      const events = await turnPromise;
      expect(events.some((e) => e.type === "done")).toBe(true);
    });
  });

  // ── getStatus ────────────────────────────────────────────────

  describe("getStatus", () => {
    it("reports reachable status", async () => {
      const runtime = createRuntime();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:synthagent:acp:status-test",
        agent: "synthagent",
        mode: "oneshot",
      });

      const status = await runtime.getStatus({ handle });
      expect(status.summary).toContain("reachable");
      expect(status.backendSessionId).toBeDefined();
    });
  });

  // ── doctor ───────────────────────────────────────────────────

  describe("doctor", () => {
    it("returns healthy report when server is up", async () => {
      const runtime = createRuntime();
      const report = await runtime.doctor();

      expect(report.ok).toBe(true);
      expect(report.details).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Health endpoint: OK"),
          expect.stringContaining("Ready endpoint: OK"),
          expect.stringContaining("API key: configured"),
        ]),
      );
    });

    it("returns unhealthy when API key is missing", async () => {
      const runtime = createRuntime({ apiKey: "" });
      const report = await runtime.doctor();

      expect(report.ok).toBe(false);
      expect(report.details).toEqual(
        expect.arrayContaining([expect.stringContaining("API key not configured")]),
      );
    });

    it("returns unhealthy when server is unreachable", async () => {
      const runtime = createRuntime({ baseUrl: "http://127.0.0.1:1" });
      const report = await runtime.doctor();

      expect(report.ok).toBe(false);
    });
  });

  // ── probeHealth ──────────────────────────────────────────────

  describe("probeHealth", () => {
    it("sets healthy flag on success", async () => {
      const runtime = createRuntime();
      expect(runtime.isHealthy()).toBe(false);

      await runtime.probeHealth();
      expect(runtime.isHealthy()).toBe(true);
    });

    it("clears healthy flag on failure", async () => {
      const runtime = createRuntime({ baseUrl: "http://127.0.0.1:1" });

      await expect(runtime.probeHealth()).rejects.toThrow();
      expect(runtime.isHealthy()).toBe(false);
    });
  });
});
