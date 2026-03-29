/**
 * skill-kanban handler
 *
 * Queries the Kanban board tRPC API running on localhost:3484
 * and returns board/task status to Slack.
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ──

export interface SlackMessenger {
  postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string; channel: string }>;
}

export type KanbanAction = "status" | "task" | "start" | "stop" | "orchestrate";

export interface StatusPayload {
  action: "status";
  workspaceId?: string;
}

export interface TaskPayload {
  action: "task";
  taskId: string;
  workspaceId?: string;
}

export interface StartPayload {
  action: "start";
  taskId: string;
  workspaceId?: string;
}

export interface StopPayload {
  action: "stop";
  taskId: string;
  workspaceId?: string;
}

export interface OrchestratePayload {
  action: "orchestrate";
  taskId: string;
  workspaceId?: string;
  planOnly?: boolean;
}

export type KanbanPayload =
  | StatusPayload
  | TaskPayload
  | StartPayload
  | StopPayload
  | OrchestratePayload;

// ── Config ──

const KANBAN_BASE_URL = process.env.KANBAN_BASE_URL ?? "http://localhost:3484";
const DEFAULT_WORKSPACE_ID = process.env.KANBAN_DEFAULT_WORKSPACE_ID ?? "synthagent";

// ── tRPC helpers ──

async function trpcQuery(
  procedure: string,
  workspaceId: string,
  input: unknown = null,
): Promise<unknown> {
  const inputParam =
    input !== null
      ? encodeURIComponent(JSON.stringify({ json: input }))
      : encodeURIComponent(JSON.stringify({ json: null }));
  const url = `${KANBAN_BASE_URL}/api/trpc/${procedure}?input=${inputParam}`;
  const res = await fetch(url, {
    headers: {
      "x-kanban-workspace-id": workspaceId,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Kanban API ${procedure}: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { result?: { data?: unknown } };
  return data.result?.data;
}

async function trpcMutation(
  procedure: string,
  workspaceId: string,
  input: unknown,
): Promise<unknown> {
  const url = `${KANBAN_BASE_URL}/api/trpc/${procedure}`;
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
    throw new Error(`Kanban API ${procedure}: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { result?: { data?: unknown } };
  return data.result?.data;
}

// ── Column name map ──

const COLUMN_EMOJI: Record<string, string> = {
  backlog: "📋",
  in_progress: "🔄",
  review: "👀",
  trash: "🗑️",
};

const COLUMN_NAME: Record<string, string> = {
  backlog: "バックログ",
  in_progress: "進行中",
  review: "レビュー",
  trash: "ゴミ箱",
};

// ── Formatters ──

interface BoardColumn {
  id: string;
  title: string;
  cards: Array<{ id: string; prompt: string; createdAt: number; updatedAt: number }>;
}

interface TaskSession {
  taskId: string;
  state: string;
  agentId: string;
  workspacePath: string;
  pid: number | null;
  startedAt: number | null;
  lastOutputAt: number | null;
  latestHookActivity: {
    activityText?: string;
    toolName?: string;
    source?: string;
  } | null;
}

function formatBoardStatus(
  board: { columns: BoardColumn[] },
  sessions: Record<string, TaskSession>,
): string {
  const lines: string[] = ["*📋 Kanban ボード状態*\n"];

  for (const col of board.columns) {
    const emoji = COLUMN_EMOJI[col.id] ?? "▪️";
    const name = COLUMN_NAME[col.id] ?? col.title;
    lines.push(`${emoji} *${name}* (${col.cards.length})`);

    for (const card of col.cards) {
      const sess = sessions[card.id];
      const state = sess ? `\`${sess.state}\`` : "";
      const activity = sess?.latestHookActivity?.activityText;
      const title = card.prompt.split("\n")[0].slice(0, 60);
      let line = `  • ${title} ${state}`;
      if (activity) {
        line += `\n    _${activity.slice(0, 80)}_`;
      }
      lines.push(line);
    }

    if (col.cards.length === 0) {
      lines.push("  _（なし）_");
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatTaskDetail(
  taskId: string,
  card: { id: string; prompt: string; createdAt: number } | null,
  session: TaskSession | null,
): string {
  if (!card) {
    return `タスク \`${taskId}\` が見つかりません。`;
  }

  const lines: string[] = [
    `*📌 タスク: ${card.id}*`,
    "",
    `\`\`\`${card.prompt.slice(0, 500)}\`\`\``,
    "",
  ];

  if (session) {
    lines.push(`*状態:* \`${session.state}\``);
    lines.push(`*エージェント:* ${session.agentId}`);
    lines.push(`*Worktree:* \`${session.workspacePath}\``);
    if (session.pid) lines.push(`*PID:* ${session.pid}`);
    if (session.startedAt) {
      const elapsed = Math.round((Date.now() - session.startedAt) / 60_000);
      lines.push(`*経過:* ${elapsed}分`);
    }
    if (session.latestHookActivity?.activityText) {
      lines.push(`*最新アクティビティ:* _${session.latestHookActivity.activityText}_`);
    }
  } else {
    lines.push("_セッション未起動_");
  }

  return lines.join("\n");
}

// ── Main handler ──

export async function handleKanban(
  payload: KanbanPayload,
  slack: SlackMessenger,
  channel: string,
  threadTs?: string,
): Promise<void> {
  const workspaceId = payload.workspaceId ?? DEFAULT_WORKSPACE_ID;

  try {
    switch (payload.action) {
      case "status": {
        const state = (await trpcQuery("workspace.getState", workspaceId)) as {
          board: { columns: BoardColumn[] };
          sessions: Record<string, TaskSession>;
        };
        const text = formatBoardStatus(state.board, state.sessions);
        await slack.postMessage(channel, text, threadTs);
        break;
      }

      case "task": {
        const state = (await trpcQuery("workspace.getState", workspaceId)) as {
          board: { columns: BoardColumn[] };
          sessions: Record<string, TaskSession>;
        };
        let foundCard = null;
        for (const col of state.board.columns) {
          const card = col.cards.find((c) => c.id === payload.taskId);
          if (card) {
            foundCard = card;
            break;
          }
        }
        const session = state.sessions[payload.taskId] ?? null;
        const text = formatTaskDetail(payload.taskId, foundCard, session);
        await slack.postMessage(channel, text, threadTs);
        break;
      }

      case "start": {
        const state = (await trpcQuery("workspace.getState", workspaceId)) as {
          board: { columns: BoardColumn[] };
        };
        let foundCard = null;
        for (const col of state.board.columns) {
          const card = col.cards.find((c) => c.id === payload.taskId);
          if (card) {
            foundCard = card;
            break;
          }
        }
        if (!foundCard) {
          await slack.postMessage(
            channel,
            `タスク \`${payload.taskId}\` が見つかりません。`,
            threadTs,
          );
          return;
        }
        const baseRef = (foundCard as { baseRef?: string }).baseRef ?? "HEAD";
        const result = (await trpcMutation("runtime.startTaskSession", workspaceId, {
          taskId: payload.taskId,
          prompt: foundCard.prompt,
          startInPlanMode: true,
          baseRef,
        })) as { ok: boolean; error?: string };

        if (result.ok) {
          await slack.postMessage(
            channel,
            `✅ タスク \`${payload.taskId}\` を開始しました。`,
            threadTs,
          );
        } else {
          await slack.postMessage(
            channel,
            `❌ タスク開始失敗: ${result.error ?? "不明なエラー"}`,
            threadTs,
          );
        }
        break;
      }

      case "stop": {
        const result = (await trpcMutation("runtime.stopTaskSession", workspaceId, {
          taskId: payload.taskId,
        })) as { ok: boolean; error?: string };

        if (result.ok) {
          await slack.postMessage(
            channel,
            `⏹️ タスク \`${payload.taskId}\` を停止しました。`,
            threadTs,
          );
        } else {
          await slack.postMessage(
            channel,
            `❌ タスク停止失敗: ${result.error ?? "不明なエラー"}`,
            threadTs,
          );
        }
        break;
      }

      case "orchestrate": {
        const scriptPath = resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../scripts/orchestrate-task.ts",
        );
        const args = [scriptPath, workspaceId, payload.taskId];
        if ((payload as OrchestratePayload).planOnly) args.push("--plan-only");

        await slack.postMessage(
          channel,
          `🎭 タスク \`${payload.taskId}\` を2フェーズ実行で開始します\n` +
            `Phase 1: Plan (Opus) → Phase 2: Execute (Sonnet)`,
          threadTs,
        );

        // Fire and forget — orchestrator runs in background
        const child = spawn("npx", ["tsx", ...args], {
          stdio: "ignore",
          detached: true,
          env: { ...process.env, KANBAN_BASE: `${KANBAN_BASE_URL}/api/trpc` },
        });
        child.unref();
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await slack.postMessage(channel, `❌ Kanban API エラー: ${msg}`, threadTs);
  }
}
