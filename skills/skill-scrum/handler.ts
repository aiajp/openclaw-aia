/**
 * skill-scrum handler
 *
 * AI-driven Scrum Master for GitHub Projects.
 * Manages Sprint Planning, Task Execution, Auto Review,
 * Daily Standup, and Sprint Review.
 */

import { reviewPr, type ReviewRequest, type ReviewResult } from "./lib/auto-reviewer.js";
import { postStandup } from "./lib/daily-standup.js";
import { getSprintStatus, getReadyTasks, type ProjectTask } from "./lib/github-projects.js";
import { proposePlan, approvePlan, generatePlan, type SprintPlan } from "./lib/sprint-planner.js";
import { postSprintReview } from "./lib/sprint-review.js";
import { executeNextTask, type ExecutionResult } from "./lib/task-executor.js";

// ── Types ──

export interface SlackMessenger {
  postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string; channel: string }>;
}

export type ScrumAction =
  | "status"
  | "plan"
  | "approve-plan"
  | "execute"
  | "review"
  | "standup"
  | "sprint-review"
  | "decompose";

export interface StatusPayload {
  action: "status";
}

export interface PlanPayload {
  action: "plan";
  capacity?: number;
}

export interface ExecutePayload {
  action: "execute";
}

export interface ReviewPayload {
  action: "review";
  repo: string;
  prNumber: number;
  issueNumber?: number;
  branch: string;
}

export interface StandupPayload {
  action: "standup";
}

export interface SprintReviewPayload {
  action: "sprint-review";
}

export interface DecomposePayload {
  action: "decompose";
  repo: string;
  issueNumber: number;
}

export type ScrumPayload =
  | StatusPayload
  | PlanPayload
  | ExecutePayload
  | ReviewPayload
  | StandupPayload
  | SprintReviewPayload
  | DecomposePayload;

export interface HandlerResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface HandlerContext {
  messenger: SlackMessenger;
  channel: string;
  threadTs?: string;
}

// ── Main handler ──

export async function handleScrum(
  payload: ScrumPayload,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  switch (payload.action) {
    case "status":
      return handleStatus(ctx);
    case "plan":
      return handlePlan(payload as PlanPayload, ctx);
    case "approve-plan":
      return handleApprovePlan(ctx);
    case "execute":
      return handleExecute(ctx);
    case "review":
      return handleReview(payload as ReviewPayload, ctx);
    case "standup":
      return handleStandupAction(ctx);
    case "sprint-review":
      return handleSprintReview(ctx);
    default:
      return { success: false, error: `Unknown action: ${(payload as { action: string }).action}` };
  }
}

// ── Action handlers ──

async function handleStatus(ctx: HandlerContext): Promise<HandlerResult> {
  try {
    const status = getSprintStatus();

    const lines = [
      "📊 **Sprint Board Status**",
      "",
      `📋 Backlog: ${status.backlog.length} tasks`,
      `✅ Ready: ${status.ready.length} tasks`,
      `🔄 In Progress: ${status.inProgress.length} tasks`,
      `👀 In Review: ${status.inReview.length} tasks`,
      `✅ Done: ${status.done.length} tasks`,
    ];

    if (status.ready.length > 0) {
      lines.push("", "**Ready tasks:**");
      for (const task of status.ready) {
        lines.push(`  - #${task.issueNumber} ${task.title} (${task.repo})`);
      }
    }

    if (status.inProgress.length > 0) {
      lines.push("", "**In Progress:**");
      for (const task of status.inProgress) {
        lines.push(`  - #${task.issueNumber} ${task.title} (${task.repo})`);
      }
    }

    await ctx.messenger.postMessage(ctx.channel, lines.join("\n"), ctx.threadTs);
    return { success: true, data: status };
  } catch (err) {
    return { success: false, error: `Failed to get status: ${err}` };
  }
}

async function handleExecute(ctx: HandlerContext): Promise<HandlerResult> {
  try {
    const result = await executeNextTask(ctx.messenger, ctx.channel);

    if (!result) {
      await ctx.messenger.postMessage(
        ctx.channel,
        "📋 No Ready tasks found. Sprint Board is empty.",
        ctx.threadTs,
      );
      return { success: true, data: null };
    }

    return { success: result.success, data: result, error: result.error };
  } catch (err) {
    return { success: false, error: `Task execution failed: ${err}` };
  }
}

async function handleReview(payload: ReviewPayload, ctx: HandlerContext): Promise<HandlerResult> {
  try {
    const request: ReviewRequest = {
      repo: payload.repo,
      prNumber: payload.prNumber,
      issueNumber: payload.issueNumber,
      branch: payload.branch,
    };

    const result = await reviewPr(request, ctx.messenger, ctx.channel);
    return {
      success: result.success,
      data: result,
      error: result.verdict === "error" ? result.summary : undefined,
    };
  } catch (err) {
    return { success: false, error: `Review failed: ${err}` };
  }
}

// ── Sprint Planning ──

let pendingPlan: SprintPlan | null = null;

async function handlePlan(payload: PlanPayload, ctx: HandlerContext): Promise<HandlerResult> {
  try {
    pendingPlan = await proposePlan(ctx.messenger, ctx.channel, payload.capacity);
    return { success: true, data: pendingPlan };
  } catch (err) {
    return { success: false, error: `Sprint planning failed: ${err}` };
  }
}

async function handleApprovePlan(ctx: HandlerContext): Promise<HandlerResult> {
  if (!pendingPlan) {
    await ctx.messenger.postMessage(
      ctx.channel,
      "⚠️ 承認待ちのSprint計画がありません。先に `plan` を実行してください。",
      ctx.threadTs,
    );
    return { success: false, error: "No pending plan" };
  }

  try {
    const moved = approvePlan(pendingPlan);
    await ctx.messenger.postMessage(
      ctx.channel,
      `✅ ${pendingPlan.sprintName} 承認完了。${moved} tasks を Ready に移動しました。`,
      ctx.threadTs,
    );
    pendingPlan = null;
    return { success: true, data: { moved } };
  } catch (err) {
    return { success: false, error: `Plan approval failed: ${err}` };
  }
}

// ── Daily Standup ──

async function handleStandupAction(ctx: HandlerContext): Promise<HandlerResult> {
  try {
    const report = await postStandup(ctx.messenger, ctx.channel);
    return { success: true, data: report };
  } catch (err) {
    return { success: false, error: `Standup generation failed: ${err}` };
  }
}

// ── Sprint Review ──

async function handleSprintReview(ctx: HandlerContext): Promise<HandlerResult> {
  try {
    const report = await postSprintReview(ctx.messenger, ctx.channel);
    return { success: true, data: report };
  } catch (err) {
    return { success: false, error: `Sprint review failed: ${err}` };
  }
}
