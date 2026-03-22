/**
 * skill-claude-code handler
 *
 * Spawns Claude Code sessions on whitelisted directories,
 * streams progress to Slack via stream-json output, and
 * gates git push behind Slack approval.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

// ── Types ──

export interface SlackMessenger {
  postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string; channel: string }>;
  postBlockMessage(
    channel: string,
    blocks: SlackBlock[],
    threadTs?: string,
  ): Promise<{ ts: string; channel: string }>;
  updateMessage(channel: string, ts: string, blocks: SlackBlock[]): Promise<void>;
}

export interface SlackBlock {
  type: string;
  text?: unknown;
  accessory?: unknown;
  elements?: unknown[];
  block_id?: string;
  [key: string]: unknown;
}

export type ClaudeCodeAction = "spawn" | "status" | "log" | "stop" | "git_push";

export interface SpawnPayload {
  action: "spawn";
  workdir: string;
  task: string;
  background?: boolean;
  timeout?: number;
}

export interface StatusPayload {
  action: "status";
  sessionId: string;
}

export interface LogPayload {
  action: "log";
  sessionId: string;
  tail?: number;
}

export interface StopPayload {
  action: "stop";
  sessionId: string;
}

export interface GitPushPayload {
  action: "git_push";
  workdir: string;
  branch?: string;
  force?: boolean;
}

export type ActionPayload =
  | SpawnPayload
  | StatusPayload
  | LogPayload
  | StopPayload
  | GitPushPayload;

export interface HandlerContext {
  messenger: SlackMessenger;
  channel: string;
  threadTs?: string;
  user: string;
}

export interface HandlerResult {
  success: boolean;
  data?: unknown;
  error?: string;
  sessionId?: string;
}

interface SessionInfo {
  id: string;
  process: ChildProcess;
  workdir: string;
  task: string;
  startedAt: number;
  output: string[];
}

// ── Constants ──

const ALLOWED_DIRS = [
  "/home/ubuntu/obsidian-artifacts/",
  "/home/ubuntu/openclaw-aia/",
  "/Volumes/Dev_SSD/rag-in-a-box/",
  "/Volumes/Dev_SSD/synthagent/",
];

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_TIMEOUT_MS = 1_800_000; // 30 minutes
const SLACK_UPDATE_INTERVAL_MS = 5_000; // Throttle Slack updates

// ── Session Registry ──

const sessions = new Map<string, SessionInfo>();

// ── Whitelist Validation ──

function normalizeDir(dir: string): string {
  return dir.endsWith("/") ? dir : dir + "/";
}

function isAllowedDir(workdir: string): boolean {
  const normalized = normalizeDir(workdir);
  return ALLOWED_DIRS.some((allowed) => normalized.startsWith(allowed));
}

// ── Main Entry Point ──

export async function handleClaudeCodeAction(
  payload: ActionPayload,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  switch (payload.action) {
    case "spawn":
      return handleSpawn(payload, ctx);
    case "status":
      return handleStatus(payload);
    case "log":
      return handleLog(payload);
    case "stop":
      return handleStop(payload, ctx);
    case "git_push":
      return handleGitPush(payload, ctx);
    default:
      return { success: false, error: `Unknown action: ${(payload as { action: string }).action}` };
  }
}

// ── spawn ──

async function handleSpawn(payload: SpawnPayload, ctx: HandlerContext): Promise<HandlerResult> {
  // Whitelist check
  if (!isAllowedDir(payload.workdir)) {
    return {
      success: false,
      error: `ディレクトリが許可リストにありません: ${payload.workdir}\n許可: ${ALLOWED_DIRS.join(", ")}`,
    };
  }

  // Concurrency check: one session per directory
  for (const [, session] of sessions) {
    if (normalizeDir(session.workdir) === normalizeDir(payload.workdir)) {
      return {
        success: false,
        error: `同一ディレクトリで既にセッション実行中: ${session.id}`,
        sessionId: session.id,
      };
    }
  }

  const sessionId = randomUUID();
  const timeoutMs = Math.min(
    Math.max(payload.timeout ? payload.timeout * 1000 : DEFAULT_TIMEOUT_MS, 1000),
    MAX_TIMEOUT_MS,
  );

  // Notify start
  await ctx.messenger.postMessage(
    ctx.channel,
    `🖥️ Claude Code セッション起動中...\nディレクトリ: ${payload.workdir}\nタスク: ${payload.task}\nセッションID: \`${sessionId}\``,
    ctx.threadTs,
  );

  const startedAt = Date.now();
  const outputLines: string[] = [];

  // Spawn Claude Code with stream-json
  const child = spawn(
    "claude",
    [
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--print",
      payload.task,
    ],
    {
      cwd: payload.workdir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    },
  );

  const session: SessionInfo = {
    id: sessionId,
    process: child,
    workdir: payload.workdir,
    task: payload.task,
    startedAt,
    output: outputLines,
  };
  sessions.set(sessionId, session);

  // Stream-json line buffer + Slack relay
  let lineBuffer = "";
  let lastSlackUpdate = 0;
  let lastAssistantText = "";
  let changedFiles: string[] = [];
  let resultSessionId: string | undefined;
  let costUsd: number | undefined;

  child.stdout?.on("data", (chunk: Buffer) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      outputLines.push(trimmed);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      switch (parsed.type) {
        case "system":
          if (typeof parsed.session_id === "string") {
            resultSessionId = parsed.session_id;
          }
          break;

        case "assistant": {
          const text = extractText(parsed);
          if (text) {
            lastAssistantText = text;
            throttledSlackUpdate(text, ctx, lastSlackUpdate).then((ts) => {
              if (ts) lastSlackUpdate = Date.now();
            });
          }
          break;
        }

        case "tool_use": {
          const toolName = extractToolName(parsed);
          if (toolName) {
            const toolMsg = `🔧 ${toolName}`;
            throttledSlackUpdate(toolMsg, ctx, lastSlackUpdate).then((ts) => {
              if (ts) lastSlackUpdate = Date.now();
            });
          }
          // Track file changes from Edit/Write tool calls
          const filePath = extractFilePath(parsed);
          if (filePath && !changedFiles.includes(filePath)) {
            changedFiles.push(filePath);
          }
          break;
        }

        case "result": {
          if (typeof parsed.result === "string" && parsed.result) {
            lastAssistantText = parsed.result;
          }
          if (typeof parsed.session_id === "string") {
            resultSessionId = parsed.session_id;
          }
          if (typeof parsed.cost_usd === "number") {
            costUsd = parsed.cost_usd;
          }
          break;
        }
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    outputLines.push(`[stderr] ${chunk.toString().trim()}`);
  });

  // Wait for completion or timeout
  const result = await Promise.race([
    new Promise<"completed">((resolve) => {
      child.on("close", () => resolve("completed"));
    }),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);

  // Flush remaining buffer
  if (lineBuffer.trim()) {
    outputLines.push(lineBuffer.trim());
  }

  // Handle timeout
  if (result === "timeout") {
    child.kill("SIGTERM");
    sessions.delete(sessionId);

    await ctx.messenger.postMessage(
      ctx.channel,
      `⏱️ セッションタイムアウト (${Math.round(timeoutMs / 1000)}秒)\nセッションID: \`${sessionId}\``,
      ctx.threadTs,
    );

    return { success: false, error: "Session timed out", sessionId };
  }

  // Session completed
  sessions.delete(sessionId);
  const durationMs = Date.now() - startedAt;
  const durationStr = formatDuration(durationMs);

  // Get git commit info if available
  let commitMessage: string | undefined;
  try {
    const gitLog = await execCommand("git", ["log", "--oneline", "-1"], payload.workdir);
    if (gitLog.trim()) {
      commitMessage = gitLog.trim();
    }
  } catch {
    // No git info available
  }

  // Build completion notification (per SKILL.md format)
  const filesStr =
    changedFiles.length > 0
      ? changedFiles.length <= 3
        ? changedFiles.join(", ")
        : `${changedFiles.slice(0, 2).join(", ")} (+${changedFiles.length - 2} files)`
      : "なし";

  const completionMsg = [
    `✅ Claude Code セッション完了`,
    `ディレクトリ: ${payload.workdir}`,
    `タスク: ${payload.task}`,
    `所要時間: ${durationStr}`,
    `変更ファイル: ${filesStr}`,
    ...(commitMessage ? [`コミット: ${commitMessage}`] : []),
    ...(costUsd != null ? [`コスト: $${costUsd.toFixed(4)}`] : []),
  ].join("\n");

  await ctx.messenger.postMessage(ctx.channel, completionMsg, ctx.threadTs);

  return {
    success: true,
    sessionId: resultSessionId ?? sessionId,
    data: {
      duration: durationMs,
      changedFiles,
      lastOutput: lastAssistantText,
      costUsd,
    },
  };
}

// ── status ──

function handleStatus(payload: StatusPayload): HandlerResult {
  const session = sessions.get(payload.sessionId);
  if (!session) {
    return { success: false, error: `セッションが見つかりません: ${payload.sessionId}` };
  }
  return {
    success: true,
    sessionId: session.id,
    data: {
      workdir: session.workdir,
      task: session.task,
      running: !session.process.killed,
      elapsed: Date.now() - session.startedAt,
      outputLines: session.output.length,
    },
  };
}

// ── log ──

function handleLog(payload: LogPayload): HandlerResult {
  const session = sessions.get(payload.sessionId);
  if (!session) {
    return { success: false, error: `セッションが見つかりません: ${payload.sessionId}` };
  }
  const tail = payload.tail ?? 50;
  const lines = session.output.slice(-tail);
  return {
    success: true,
    sessionId: session.id,
    data: { lines, total: session.output.length },
  };
}

// ── stop ──

async function handleStop(payload: StopPayload, ctx: HandlerContext): Promise<HandlerResult> {
  const session = sessions.get(payload.sessionId);
  if (!session) {
    return { success: false, error: `セッションが見つかりません: ${payload.sessionId}` };
  }
  session.process.kill("SIGTERM");
  sessions.delete(payload.sessionId);

  await ctx.messenger.postMessage(
    ctx.channel,
    `⏹️ セッション停止: \`${payload.sessionId}\``,
    ctx.threadTs,
  );

  return { success: true, sessionId: payload.sessionId };
}

// ── git_push (confirmation required) ──

async function handleGitPush(payload: GitPushPayload, ctx: HandlerContext): Promise<HandlerResult> {
  // Whitelist check
  if (!isAllowedDir(payload.workdir)) {
    return {
      success: false,
      error: `ディレクトリが許可リストにありません: ${payload.workdir}`,
    };
  }

  // Resolve branch
  const branch =
    payload.branch ??
    (await execCommand("git", ["branch", "--show-current"], payload.workdir)).trim();

  if (!branch) {
    return { success: false, error: "ブランチを特定できません" };
  }

  // Gather diff stats for the confirmation prompt
  let diffStat = "";
  try {
    diffStat = (await execCommand("git", ["diff", "--stat", "HEAD~1"], payload.workdir)).trim();
  } catch {
    diffStat = "(diff取得失敗)";
  }

  const changedCount = diffStat.split("\n").filter((l) => l.includes("|")).length;

  // Force push → two-step (irreversible)
  // Normal push → single-step (important)
  const approvalId = randomUUID();

  const confirmBlocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          payload.force ? "🚨 *Git Force Push 確認*" : "🔔 *Git Push 確認*",
          `*リポジトリ*: ${payload.workdir}`,
          `*ブランチ*: ${branch}`,
          `*変更ファイル*: ${changedCount}件`,
          `*Force push*: ${payload.force ? "Yes ⚠️" : "No"}`,
        ].join("\n"),
      },
    },
    {
      type: "actions",
      block_id: `git_push_${approvalId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ 実行" },
          style: "primary",
          action_id: "claude_code_approve_push",
          value: `approve:${approvalId}`,
          ...(payload.force
            ? {
                confirm: {
                  title: { type: "plain_text", text: "最終確認" },
                  text: {
                    type: "mrkdwn",
                    text: "Force pushは不可逆操作です。本当に実行しますか？",
                  },
                  confirm: { type: "plain_text", text: "実行する" },
                  deny: { type: "plain_text", text: "キャンセル" },
                },
              }
            : {}),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ キャンセル" },
          style: "danger",
          action_id: "claude_code_cancel_push",
          value: `cancel:${approvalId}`,
        },
      ],
    },
  ];

  await ctx.messenger.postBlockMessage(ctx.channel, confirmBlocks, ctx.threadTs);

  // Wait for approval (5 minute timeout)
  const approval = await waitForApproval(approvalId, 5 * 60 * 1000);

  if (approval !== "approved") {
    return {
      success: false,
      error: approval === "timeout" ? "承認タイムアウト" : "キャンセルされました",
    };
  }

  // Execute push
  const pushArgs = ["push", ...(payload.force ? ["--force"] : []), "origin", branch];
  try {
    const output = await execCommand("git", pushArgs, payload.workdir);
    await ctx.messenger.postMessage(
      ctx.channel,
      `✅ Git push 完了\nブランチ: ${branch}\n${output.trim()}`,
      ctx.threadTs,
    );
    return { success: true, data: { branch, force: !!payload.force } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Git push 失敗: ${msg}` };
  }
}

// ── Approval Wait ──

const approvalResolvers = new Map<string, (result: string) => void>();

/**
 * Called by the Slack interaction handler when a button is clicked.
 */
export function handleApprovalAction(value: string): void {
  const colonIdx = value.indexOf(":");
  if (colonIdx === -1) return;
  const decision = value.slice(0, colonIdx);
  const approvalId = value.slice(colonIdx + 1);
  const resolver = approvalResolvers.get(approvalId);
  if (resolver) {
    resolver(decision === "approve" ? "approved" : "cancelled");
  }
}

function waitForApproval(approvalId: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    approvalResolvers.set(approvalId, (result) => {
      approvalResolvers.delete(approvalId);
      resolve(result);
    });

    setTimeout(() => {
      if (approvalResolvers.has(approvalId)) {
        approvalResolvers.delete(approvalId);
        resolve("timeout");
      }
    }, timeoutMs);
  });
}

// ── Stream-JSON Helpers ──

function extractText(event: Record<string, unknown>): string {
  const message = isRecord(event.message) ? event.message : event;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => (block as { text: string }).text)
      .join("");
  }
  return "";
}

function extractToolName(event: Record<string, unknown>): string | null {
  const tool = isRecord(event.tool) ? event.tool : event;
  return typeof tool.name === "string" ? tool.name : null;
}

function extractFilePath(event: Record<string, unknown>): string | null {
  const tool = isRecord(event.tool) ? event.tool : event;
  const input = isRecord(tool.input) ? tool.input : null;
  if (!input) return null;
  // Edit, Write, Read tools use file_path
  if (typeof input.file_path === "string") return input.file_path;
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Slack Throttle ──

async function throttledSlackUpdate(
  text: string,
  ctx: HandlerContext,
  lastUpdate: number,
): Promise<boolean> {
  if (Date.now() - lastUpdate < SLACK_UPDATE_INTERVAL_MS) return false;
  const truncated = text.length > 300 ? text.slice(0, 297) + "..." : text;
  try {
    await ctx.messenger.postMessage(ctx.channel, truncated, ctx.threadTs);
    return true;
  } catch {
    return false;
  }
}

// ── Shell Helpers ──

function execCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Process exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
}
