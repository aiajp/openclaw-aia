/**
 * Parser for Claude Code `--output-format stream-json` NDJSON output.
 *
 * Each line is a JSON object with a `type` field:
 *   - "system"      → init info (session_id, tools, mcp_servers)
 *   - "assistant"    → model response content
 *   - "tool_use"     → tool invocation
 *   - "tool_result"  → tool output
 *   - "result"       → final result (subtype: "success" | "error")
 */

import type { CliBackendConfig } from "../../config/types.js";
import { isRecord } from "../../utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StreamJsonEvent =
  | { type: "system"; sessionId?: string; data: Record<string, unknown> }
  | { type: "assistant"; text: string; data: Record<string, unknown> }
  | { type: "tool_use"; toolName: string; toolInput: unknown; data: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; data: Record<string, unknown> }
  | {
      type: "result";
      subtype: string;
      text: string;
      sessionId?: string;
      costUsd?: number;
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      data: Record<string, unknown>;
    };

export type StreamJsonCallback = (event: StreamJsonEvent) => void;

// ---------------------------------------------------------------------------
// Line parser
// ---------------------------------------------------------------------------

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => (block as { text: string }).text)
      .join("");
  }
  return "";
}

function parseStreamJsonLine(line: string): StreamJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }
  const data = parsed;
  switch (data.type) {
    case "system": {
      const sessionId = typeof data.session_id === "string" ? data.session_id : undefined;
      return { type: "system", sessionId, data };
    }
    case "assistant": {
      const message = isRecord(data.message) ? data.message : data;
      const content = message.content;
      const text = extractTextFromContent(content);
      return { type: "assistant", text, data };
    }
    case "tool_use": {
      const tool = isRecord(data.tool) ? data.tool : data;
      const toolName = typeof tool.name === "string" ? tool.name : "unknown";
      const toolInput = tool.input ?? {};
      return { type: "tool_use", toolName, toolInput, data };
    }
    case "tool_result": {
      const result = isRecord(data.tool_result) ? data.tool_result : data;
      const toolUseId = typeof result.tool_use_id === "string" ? result.tool_use_id : "";
      return { type: "tool_result", toolUseId, data };
    }
    case "result": {
      const subtype = typeof data.subtype === "string" ? data.subtype : "unknown";
      const text = typeof data.result === "string" ? data.result : "";
      const sessionId = typeof data.session_id === "string" ? data.session_id : undefined;
      const costUsd = typeof data.cost_usd === "number" ? data.cost_usd : undefined;
      const rawUsage = isRecord(data.usage) ? data.usage : undefined;
      const usage = rawUsage
        ? {
            input: typeof rawUsage.input === "number" ? rawUsage.input : undefined,
            output: typeof rawUsage.output === "number" ? rawUsage.output : undefined,
            cacheRead: typeof rawUsage.cache_read === "number" ? rawUsage.cache_read : undefined,
            cacheWrite: typeof rawUsage.cache_write === "number" ? rawUsage.cache_write : undefined,
          }
        : undefined;
      return { type: "result", subtype, text, sessionId, costUsd, usage, data };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// NDJSON line buffer
// ---------------------------------------------------------------------------

export function createStreamJsonParser(callback: StreamJsonCallback) {
  let buffer = "";

  return {
    /** Feed a raw stdout chunk. Lines are parsed and emitted via callback. */
    feed(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer.
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseStreamJsonLine(line);
        if (event) {
          callback(event);
        }
      }
    },
    /** Flush any remaining buffered data. Call after the process exits. */
    flush(): void {
      if (buffer.trim()) {
        const event = parseStreamJsonLine(buffer);
        if (event) {
          callback(event);
        }
      }
      buffer = "";
    },
  };
}

// ---------------------------------------------------------------------------
// Result extraction from accumulated events (replaces parseCliJson for stream-json)
// ---------------------------------------------------------------------------

export function extractStreamJsonResult(
  events: StreamJsonEvent[],
  _backend: CliBackendConfig,
): {
  text: string;
  sessionId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
} | null {
  // Find the result event (last one wins)
  let resultEvent: (StreamJsonEvent & { type: "result" }) | undefined;
  let systemSessionId: string | undefined;

  for (const evt of events) {
    if (evt.type === "result") {
      resultEvent = evt;
    }
    if (evt.type === "system" && evt.sessionId) {
      systemSessionId = evt.sessionId;
    }
  }

  if (!resultEvent) {
    // Fall back: concatenate all assistant text
    const text = events
      .filter((e): e is StreamJsonEvent & { type: "assistant" } => e.type === "assistant")
      .map((e) => e.text)
      .join("");
    return text ? { text, sessionId: systemSessionId } : null;
  }

  const usage = resultEvent.usage
    ? {
        ...resultEvent.usage,
        total:
          (resultEvent.usage.input ?? 0) +
          (resultEvent.usage.output ?? 0) +
          (resultEvent.usage.cacheRead ?? 0) +
          (resultEvent.usage.cacheWrite ?? 0),
      }
    : undefined;

  return {
    text: resultEvent.text,
    sessionId: resultEvent.sessionId ?? systemSessionId,
    usage,
  };
}
