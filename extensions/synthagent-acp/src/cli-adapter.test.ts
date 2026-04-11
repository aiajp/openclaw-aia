import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// ── Mock SynthAgent server ─────────────────────────────────────────

let mockServer: http.Server;
let mockPort: number;

function sseChunk(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      mockServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const url = req.url ?? "";

          if (url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }

          if (url === "/v1/agent/chat/stream" && req.method === "POST") {
            const apiKey = req.headers["x-api-key"];
            if (!apiKey) {
              res.writeHead(401);
              res.end("Unauthorized");
              return;
            }
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            });
            res.write(sseChunk("token", { content: "Hi" }));
            res.write(sseChunk("token", { content: " there" }));
            res.write(sseChunk("done", { content: "Hi there" }));
            res.end();
            return;
          }

          if (url === "/v1/agent/chat" && req.method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ response: "sync fallback response" }));
            return;
          }

          res.writeHead(404);
          res.end();
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

// ── Helpers ────────────────────────────────────────────────────────

const CLI_PATH = path.resolve(import.meta.dirname, "../../../scripts/synthagent-cli");

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = execFile(
      CLI_PATH,
      args,
      {
        env: {
          ...process.env,
          SYNTHAGENT_BASE_URL: `http://127.0.0.1:${mockPort}`,
          SYNTHAGENT_API_KEY: "sa_test_cli",
          ...env,
        },
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          code: error?.code !== undefined ? Number(error.code) : (proc.exitCode ?? 0),
        });
      },
    );
  });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("synthagent-cli adapter", () => {
  it("streams response from SSE endpoint", async () => {
    const result = await runCli(["Hello from CLI test"]);
    expect(result.stdout).toContain("Hi");
    expect(result.stdout).toContain("there");
  });

  it("accepts --autonomous flag without error", async () => {
    const result = await runCli(["--autonomous", "test with autonomous"]);
    expect(result.stdout).toContain("Hi");
  });

  it("fails with missing API key", async () => {
    const result = await runCli(["no key test"], { SYNTHAGENT_API_KEY: "" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("SYNTHAGENT_API_KEY");
  });

  it("fails with no prompt", async () => {
    const result = await runCli([]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("No prompt");
  });

  it("shows help with --help", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("Usage:");
  });
});
