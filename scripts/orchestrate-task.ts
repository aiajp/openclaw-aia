#!/usr/bin/env npx tsx
/**
 * orchestrate-task.ts — Two-phase task orchestrator
 *
 * Splits a Kanban task into:
 *   Phase 1 (Plan):   Opus creates implementation plan (no code changes)
 *   Phase 2 (Execute): Sonnet executes the plan
 *
 * This replaces direct `startTaskSession` calls when model separation is desired.
 * Can be used from skill-kanban or as a standalone CLI.
 *
 * Usage:
 *   npx tsx scripts/orchestrate-task.ts <workspaceId> <taskId> [--plan-only]
 *
 * Environment:
 *   KANBAN_BASE        — Kanban tRPC endpoint (default: http://localhost:3484/api/trpc)
 *   PLAN_MODEL         — Model for planning phase (default: opus)
 *   EXECUTE_MODEL      — Model for execution phase (default: sonnet)
 *   PLAN_TIMEOUT_MS    — Planning phase timeout (default: 300000 = 5min)
 *   EXECUTE_TIMEOUT_MS — Execution phase timeout (default: 600000 = 10min)
 *   POLL_INTERVAL_MS   — Session polling interval (default: 10000 = 10s)
 */

import { execSync } from "node:child_process";

// ── Config ──

const KANBAN_BASE = process.env.KANBAN_BASE ?? "http://localhost:3484/api/trpc";
const PLAN_MODEL = process.env.PLAN_MODEL ?? "opus";
const EXECUTE_MODEL = process.env.EXECUTE_MODEL ?? "sonnet";
const PLAN_TIMEOUT_MS = parseInt(process.env.PLAN_TIMEOUT_MS ?? "300000", 10);
// Available for future use when execute phase needs polling
const _EXECUTE_TIMEOUT_MS = parseInt(process.env.EXECUTE_TIMEOUT_MS ?? "600000", 10);
void _EXECUTE_TIMEOUT_MS;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "10000", 10);
const LOG_FILE = "/tmp/orchestrate-task.log";

// ── Logging ──

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  try {
    execSync(`echo ${JSON.stringify(line)} >> ${LOG_FILE}`, { stdio: "ignore" });
  } catch {
    // best-effort
  }
  process.stderr.write(line + "\n");
}

// ── Types ──

interface TaskSession {
  taskId: string;
  state: string;
  agentId: string;
  latestHookActivity?: {
    finalMessage?: string;
    activityText?: string;
  } | null;
}

interface BoardCard {
  id: string;
  prompt: string;
}

interface BoardColumn {
  id: string;
  cards: BoardCard[];
}

interface KanbanState {
  board: { columns: BoardColumn[] };
  sessions: Record<string, TaskSession>;
}

// ── Kanban tRPC helpers ──

async function trpcQuery(procedure: string, workspaceId: string): Promise<unknown> {
  const inputParam = encodeURIComponent(JSON.stringify({ json: null }));
  const url = `${KANBAN_BASE}/${procedure}?input=${inputParam}`;
  const res = await fetch(url, {
    headers: { "x-kanban-workspace-id": workspaceId },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Kanban ${procedure}: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { result?: { data?: unknown } };
  return data.result?.data;
}

async function trpcMutation(
  procedure: string,
  workspaceId: string,
  input: unknown,
): Promise<unknown> {
  const url = `${KANBAN_BASE}/${procedure}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kanban-workspace-id": workspaceId,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Kanban ${procedure}: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { result?: { data?: unknown } };
  return data.result?.data;
}

// ── Session polling ──

async function waitForSessionComplete(
  workspaceId: string,
  taskId: string,
  timeoutMs: number,
): Promise<{ completed: boolean; session: TaskSession | null }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    try {
      const state = (await trpcQuery("workspace.getState", workspaceId)) as KanbanState;
      const session = state.sessions[taskId];

      if (!session) {
        // Session doesn't exist — might have completed and been cleaned up
        log(`Session for ${taskId} not found (may have completed)`);
        return { completed: true, session: null };
      }

      // Check if session is in a terminal state
      if (session.state === "idle" || session.state === "completed" || session.state === "error") {
        log(`Session ${taskId} reached state: ${session.state}`);
        return { completed: true, session };
      }

      // Check if task moved to review column (plan complete or execute complete)
      const reviewCol = state.board.columns.find((c) => c.id === "review");
      if (reviewCol?.cards.some((c) => c.id === taskId)) {
        log(`Task ${taskId} moved to review column`);
        return { completed: true, session };
      }

      const activity = session.latestHookActivity?.activityText ?? "";
      if (activity) {
        log(`  polling: state=${session.state} activity="${activity.slice(0, 80)}"`);
      }
    } catch (err) {
      log(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(`Timeout waiting for session ${taskId} (${timeoutMs}ms)`);
  return { completed: false, session: null };
}

// ── Plan extraction ──

function buildPlanPrompt(sddSpec: string): string {
  return `あなたは実装計画の専門家です。以下のタスク仕様を分析し、実装計画のみを作成してください。

## 重要な制約
- コードの変更は一切行わないでください
- ファイルの編集・作成は行わないでください
- 調査（ファイル読み取り、grep、コードベースの探索）のみ行ってください

## タスク仕様
${sddSpec}

## 出力形式
以下の形式で実装計画を出力してください:

### 実装計画

#### 現状分析
- 関連ファイルの構造と依存関係

#### 変更箇所
1. [ファイルパス]: 何をどう変更するか
2. [ファイルパス]: 何をどう変更するか
...

#### 実装順序
1. 最初に行うべき変更とその理由
2. 次に行うべき変更
...

#### テスト計画
- 必要なテストケース

#### リスクと注意点
- 既存機能への影響
- エッジケース`;
}

function buildExecutePrompt(sddSpec: string, planOutput: string): string {
  return `以下の実装計画に従って、タスクを実装してください。

## 元のタスク仕様
${sddSpec}

## 実装計画（Opusが作成）
${planOutput}

## 指示
- 上記の計画に忠実に従って実装してください
- 計画にある変更箇所を順番に実装してください
- テスト計画に記載されたテストも作成してください
- 完了後、変更をコミットしてPRを作成してください`;
}

// ── Get session output (via Kanban activity text) ──

async function getSessionOutput(workspaceId: string, taskId: string): Promise<string> {
  const state = (await trpcQuery("workspace.getState", workspaceId)) as KanbanState;
  const session = state.sessions[taskId];

  if (!session) {
    return "";
  }

  // The session's finalMessage contains the agent's last output
  const finalMessage = session.latestHookActivity?.finalMessage ?? "";
  const activityText = session.latestHookActivity?.activityText ?? "";

  return finalMessage || activityText;
}

// ── Main ──

async function main(): Promise<void> {
  const workspaceId = process.argv[2];
  const taskId = process.argv[3];
  const planOnly = process.argv.includes("--plan-only");

  if (!workspaceId || !taskId) {
    console.error("Usage: orchestrate-task.ts <workspaceId> <taskId> [--plan-only]");
    process.exit(1);
  }

  log(`=== Orchestrate task: workspace=${workspaceId} task=${taskId} ===`);
  log(`Models: plan=${PLAN_MODEL} execute=${EXECUTE_MODEL}`);

  // 1. Get task card (SDD spec)
  const state = (await trpcQuery("workspace.getState", workspaceId)) as KanbanState;
  let sddSpec = "";
  for (const col of state.board.columns) {
    const card = col.cards.find((c) => c.id === taskId);
    if (card) {
      sddSpec = card.prompt;
      break;
    }
  }

  if (!sddSpec) {
    log(`ERROR: Task ${taskId} not found on board`);
    process.exit(1);
  }

  // ── Phase 1: Plan (Opus) ──
  log("=== Phase 1: Planning with Opus ===");

  const planPrompt = buildPlanPrompt(sddSpec);

  // Start plan session — no plan mode, just a prompt that instructs read-only
  const planResult = (await trpcMutation("runtime.startTaskSession", workspaceId, {
    taskId,
    prompt: planPrompt,
    startInPlanMode: true, // Use plan mode's read-only restrictions
    model: PLAN_MODEL,
  })) as { ok: boolean; error?: string };

  if (!planResult.ok) {
    log(`ERROR: Failed to start plan session: ${planResult.error}`);
    process.exit(1);
  }

  log("Plan session started, waiting for completion...");

  // Wait for plan to complete
  const planCompletion = await waitForSessionComplete(workspaceId, taskId, PLAN_TIMEOUT_MS);

  if (!planCompletion.completed) {
    log("ERROR: Plan phase timed out");
    // Stop the session
    try {
      await trpcMutation("runtime.stopTaskSession", workspaceId, { taskId });
    } catch {
      // best-effort
    }
    process.exit(1);
  }

  // Get plan output
  const planOutput = await getSessionOutput(workspaceId, taskId);
  log(`Plan output length: ${planOutput.length} chars`);

  if (planOnly) {
    log("=== Plan-only mode, stopping ===");
    console.log(planOutput);
    process.exit(0);
  }

  // ── Phase 2: Execute (Sonnet) ──
  log("=== Phase 2: Executing with Sonnet ===");

  // Stop the plan session first
  try {
    await trpcMutation("runtime.stopTaskSession", workspaceId, { taskId });
    log("Plan session stopped");
  } catch (err) {
    log(`Stop plan session: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Wait briefly for cleanup
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Start execute session with Sonnet
  const executePrompt = buildExecutePrompt(sddSpec, planOutput);

  const executeResult = (await trpcMutation("runtime.startTaskSession", workspaceId, {
    taskId,
    prompt: executePrompt,
    startInPlanMode: false, // Direct execution, no plan mode
    model: EXECUTE_MODEL,
  })) as { ok: boolean; error?: string };

  if (!executeResult.ok) {
    log(`ERROR: Failed to start execute session: ${executeResult.error}`);
    process.exit(1);
  }

  log("Execute session started with Sonnet");
  log("=== Orchestration handoff complete ===");
  log("Execution will proceed autonomously. Review trigger will handle PR review.");
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
