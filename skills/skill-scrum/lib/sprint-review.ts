/**
 * Sprint Review Generator
 *
 * Calculates velocity, generates burndown data, quality metrics,
 * and writes sprint review to Weekly note.
 */

import { execSync } from "node:child_process";
import { getSprintStatus, type ProjectTask } from "./github-projects.js";

// ── Types ──

export interface SprintReviewReport {
  sprintName: string;
  dateRange: string;
  velocity: VelocityMetrics;
  quality: QualityMetrics;
  completedTasks: ProjectTask[];
  incompleteTasks: ProjectTask[];
  nextCapacityRecommendation: number;
}

interface VelocityMetrics {
  planned: number;
  completed: number;
  achievementRate: number;
}

interface QualityMetrics {
  totalPrs: number;
  mergedPrs: number;
  rejectCount: number;
  rejectRate: number;
}

export interface SlackMessenger {
  postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string; channel: string }>;
}

// ── Config ──

const TARGET_REPOS = [
  "aiajp/synthagent",
  "aiajp/rag-in-a-box",
  "aiajp/openclaw-aia",
  "aiajp/aia-corporate-lp",
];

// ── Points helper ──

function getTaskPoints(task: ProjectTask): number {
  if (task.storyPoints) {
    const parsed = parseInt(task.storyPoints);
    if (!isNaN(parsed)) return parsed;
  }
  const spLabel = task.labels.find((l) => l.startsWith("SP: "));
  if (spLabel) {
    const parsed = parseInt(spLabel.replace("SP: ", ""));
    if (!isNaN(parsed)) return parsed;
  }
  return 3;
}

function sumPoints(tasks: ProjectTask[]): number {
  return tasks.reduce((sum, t) => sum + getTaskPoints(t), 0);
}

// ── Sprint metadata ──

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
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${fmt(monday)} 〜 ${fmt(sunday)}`;
}

// ── PR metrics from GitHub ──

function getPrMetrics(): QualityMetrics {
  let totalPrs = 0;
  let mergedPrs = 0;
  let rejectCount = 0;

  for (const repo of TARGET_REPOS) {
    try {
      const raw = execSync(
        `gh pr list --repo ${repo} --state all --json number,state,reviews,mergedAt --limit 50`,
        { encoding: "utf-8", timeout: 15_000, env: { ...process.env } },
      ).trim();

      const prs = JSON.parse(raw) as Array<{
        number: number;
        state: string;
        reviews: Array<{ state: string }>;
        mergedAt: string | null;
      }>;

      // Filter to this week
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      for (const pr of prs) {
        if (pr.mergedAt && new Date(pr.mergedAt) > weekAgo) {
          totalPrs++;
          mergedPrs++;
        }
        const rejects = pr.reviews?.filter((r) => r.state === "CHANGES_REQUESTED") ?? [];
        rejectCount += rejects.length;
      }
    } catch {
      // Skip repos that fail
    }
  }

  return {
    totalPrs,
    mergedPrs,
    rejectCount,
    rejectRate: totalPrs > 0 ? rejectCount / totalPrs : 0,
  };
}

// ── Report generation ──

export function generateSprintReview(): SprintReviewReport {
  const status = getSprintStatus();

  const completedTasks = status.done;
  const incompleteTasks = [...status.ready, ...status.inProgress, ...status.inReview];

  const completedPoints = sumPoints(completedTasks);
  const plannedPoints = completedPoints + sumPoints(incompleteTasks);

  const achievementRate = plannedPoints > 0 ? completedPoints / plannedPoints : 1;

  const quality = getPrMetrics();

  // Next capacity recommendation: moving average adjustment
  let nextCapacity = completedPoints; // Base: actual velocity
  if (achievementRate < 0.8) {
    nextCapacity = Math.round(completedPoints * 0.9); // Reduce 10%
  } else if (achievementRate > 1.0) {
    nextCapacity = Math.round(completedPoints * 1.1); // Increase 10%
  }

  return {
    sprintName: currentSprintName(),
    dateRange: sprintDateRange(),
    velocity: {
      planned: plannedPoints,
      completed: completedPoints,
      achievementRate,
    },
    quality,
    completedTasks,
    incompleteTasks,
    nextCapacityRecommendation: nextCapacity,
  };
}

// ── Format for Slack / Weekly note ──

export function formatSprintReviewMessage(report: SprintReviewReport): string {
  const pct = Math.round(report.velocity.achievementRate * 100);

  const lines = [
    `📈 **${report.sprintName} Review**（${report.dateRange}）`,
    "",
    "### 📊 進捗",
    `- ベロシティ: ${report.velocity.completed}pt（計画${report.velocity.planned}pt、達成率${pct}%）`,
    `- 完了: ${report.completedTasks.length} tasks`,
  ];

  for (const t of report.completedTasks) {
    lines.push(`  - #${t.issueNumber} ${t.title}`);
  }

  if (report.incompleteTasks.length > 0) {
    lines.push(`- 未完了: ${report.incompleteTasks.length} tasks → 次Sprint carry-over`);
    for (const t of report.incompleteTasks) {
      lines.push(`  - #${t.issueNumber} ${t.title} (${t.status})`);
    }
  }

  lines.push("");
  lines.push("### 🔍 品質レポート");
  lines.push(`- PR統計: ${report.quality.mergedPrs}本マージ`);
  lines.push(
    `- reject率: ${Math.round(report.quality.rejectRate * 100)}%（${report.quality.rejectCount}/${report.quality.totalPrs}）`,
  );

  if (report.quality.rejectRate > 0.3) {
    lines.push("- ⚠️ reject率30%超: レビュー基準またはタスク粒度の見直しを推奨");
  }

  lines.push("");
  lines.push("### 🎯 次Sprint推奨");
  lines.push(`- 推奨容量: ${report.nextCapacityRecommendation}pt`);

  if (report.velocity.achievementRate < 0.8) {
    lines.push("- 📉 達成率80%未満: 容量を10%減で調整");
  } else if (report.velocity.achievementRate > 1.0) {
    lines.push("- 📈 達成率100%超: 容量を10%増で調整");
  }

  return lines.join("\n");
}

// ── Main entry ──

export async function postSprintReview(
  messenger: SlackMessenger,
  channel: string,
): Promise<SprintReviewReport> {
  const report = generateSprintReview();
  const message = formatSprintReviewMessage(report);
  await messenger.postMessage(channel, message);
  return report;
}
