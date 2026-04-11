/**
 * Sprint Planner
 *
 * Analyzes backlog, selects tasks by priority, and proposes
 * a sprint plan for Akkey's approval via Slack.
 */

import { getSprintStatus, moveToReady, type ProjectTask } from "./github-projects.js";

// ── Types ──

export interface SprintPlan {
  sprintName: string;
  capacity: number;
  selectedTasks: SelectedTask[];
  totalPoints: number;
  carryOver: ProjectTask[];
}

interface SelectedTask {
  task: ProjectTask;
  points: number;
}

export interface SlackMessenger {
  postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string; channel: string }>;
}

// ── Config ──

const DEFAULT_CAPACITY = 28; // SP per sprint
const BUFFER = 2; // SP buffer for interruptions

// ── Sprint number ──

function currentSprintName(): string {
  const now = new Date();
  const weekNum = Math.ceil(
    (now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000),
  );
  return `Sprint ${weekNum}`;
}

function sprintDateRange(): string {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - now.getDay() + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `${fmt(monday)}-${fmt(sunday)}`;
}

// ── Story points parsing ──

function getTaskPoints(task: ProjectTask): number {
  if (task.storyPoints) {
    const parsed = parseInt(task.storyPoints);
    if (!isNaN(parsed)) return parsed;
  }
  // Default: estimate from labels
  const spLabel = task.labels.find((l) => l.startsWith("SP: "));
  if (spLabel) {
    const parsed = parseInt(spLabel.replace("SP: ", ""));
    if (!isNaN(parsed)) return parsed;
  }
  return 3; // Default estimate
}

// ── Task prioritization ──

function prioritizeTasks(tasks: ProjectTask[]): ProjectTask[] {
  const priorityOrder: Record<string, number> = {
    Critical: 4,
    High: 3,
    Medium: 2,
    Low: 1,
  };

  return [...tasks].sort((a, b) => {
    const pa = priorityOrder[a.priority ?? "Medium"] ?? 2;
    const pb = priorityOrder[b.priority ?? "Medium"] ?? 2;
    if (pb !== pa) return pb - pa;
    // Secondary sort: smaller tasks first (fill capacity efficiently)
    return getTaskPoints(a) - getTaskPoints(b);
  });
}

// ── Plan generation ──

export function generatePlan(capacity?: number): SprintPlan {
  const status = getSprintStatus();
  const effectiveCapacity = (capacity ?? DEFAULT_CAPACITY) - BUFFER;

  // Carry-over: tasks still in progress from previous sprint
  const carryOver = [...status.inProgress, ...status.inReview];

  // Available backlog tasks
  const backlog = prioritizeTasks(status.backlog);

  // Select tasks up to capacity
  const selectedTasks: SelectedTask[] = [];
  let totalPoints = 0;

  // First, account for carry-over points
  for (const task of carryOver) {
    totalPoints += getTaskPoints(task);
  }

  // Then fill with backlog
  for (const task of backlog) {
    const points = getTaskPoints(task);
    if (totalPoints + points > effectiveCapacity) continue;
    selectedTasks.push({ task, points });
    totalPoints += points;
  }

  return {
    sprintName: currentSprintName(),
    capacity: effectiveCapacity,
    selectedTasks,
    totalPoints,
    carryOver,
  };
}

// ── Format plan for Slack ──

export function formatPlanMessage(plan: SprintPlan): string {
  const lines = [
    `🗓️ **${plan.sprintName} 計画**（${sprintDateRange()}）`,
    `🎯 容量: ${plan.totalPoints}pt / ${plan.capacity}pt`,
    "",
  ];

  if (plan.carryOver.length > 0) {
    lines.push("**🔄 キャリーオーバー:**");
    for (const task of plan.carryOver) {
      lines.push(
        `  - #${task.issueNumber} [${getTaskPoints(task)}pt] ${task.title} (${task.repo})`,
      );
    }
    lines.push("");
  }

  if (plan.selectedTasks.length > 0) {
    // Group by parent issue
    const grouped = new Map<string, SelectedTask[]>();
    const noParent: SelectedTask[] = [];

    for (const st of plan.selectedTasks) {
      if (st.task.parentIssue) {
        const key = `#${st.task.parentIssue.number}: ${st.task.parentIssue.title}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(st);
      } else {
        noParent.push(st);
      }
    }

    lines.push("**📋 選択Task:**");

    for (const [parent, tasks] of grouped) {
      lines.push(`── Issue ${parent}`);
      for (const st of tasks) {
        lines.push(`  - #${st.task.issueNumber} [${st.points}pt] ${st.task.title}`);
      }
    }

    for (const st of noParent) {
      lines.push(`  - #${st.task.issueNumber} [${st.points}pt] ${st.task.title} (${st.task.repo})`);
    }
  }

  lines.push("");
  lines.push(`合計: ${plan.totalPoints}pt / 容量: ${plan.capacity}pt`);
  lines.push("承認しますか？ ✅ / ❌ / 変更あり");

  return lines.join("\n");
}

// ── Approve plan ──

export function approvePlan(plan: SprintPlan): number {
  let moved = 0;
  for (const st of plan.selectedTasks) {
    moveToReady(st.task.itemId);
    moved++;
  }
  return moved;
}

// ── Main entry ──

export async function proposePlan(
  messenger: SlackMessenger,
  channel: string,
  capacity?: number,
): Promise<SprintPlan> {
  const plan = generatePlan(capacity);
  const message = formatPlanMessage(plan);
  await messenger.postMessage(channel, message);
  return plan;
}
