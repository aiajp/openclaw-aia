/**
 * Daily Standup Reporter
 *
 * Generates daily standup report from GitHub Projects state
 * and posts to Slack #claw.
 */

import { getSprintStatus, type ProjectTask } from "./github-projects.js";

// ── Types ──

export interface StandupReport {
  date: string;
  done: ProjectTask[];
  inProgress: ProjectTask[];
  inReview: ProjectTask[];
  ready: ProjectTask[];
  blockers: ProjectTask[];
  totalPoints: number;
  remainingPoints: number;
}

export interface SlackMessenger {
  postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string; channel: string }>;
}

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

// ── Report generation ──

export function generateStandup(): StandupReport {
  const status = getSprintStatus();

  const now = new Date();
  const date = now.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });

  const blockers = status.backlog.filter((t) =>
    t.labels.some((l) => l.toLowerCase().includes("block")),
  );

  const donePoints = sumPoints(status.done);
  const remainingPoints =
    sumPoints(status.ready) + sumPoints(status.inProgress) + sumPoints(status.inReview);

  return {
    date,
    done: status.done,
    inProgress: status.inProgress,
    inReview: status.inReview,
    ready: status.ready,
    blockers,
    totalPoints: donePoints + remainingPoints,
    remainingPoints,
  };
}

// ── Format for Slack ──

export function formatStandupMessage(report: StandupReport): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const sprintDay = dayOfWeek === 0 ? 7 : dayOfWeek;
  const daysLeft = 7 - sprintDay;

  const donePts = sumPoints(report.done);
  const totalPts = report.totalPoints;
  const pct = totalPts > 0 ? Math.round((donePts / totalPts) * 100) : 0;
  const progressBar = buildProgressBar(pct);

  const lines = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 *Daily Standup* — ${report.date}`,
    `Sprint Day ${sprintDay}/7 | 残${daysLeft}日`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `${progressBar}  ${donePts}/${totalPts}pt (${pct}%)`,
    ``,
  ];

  // Status summary line
  const statusParts: string[] = [];
  statusParts.push(`✅ ${report.done.length}`);
  if (report.inProgress.length > 0) statusParts.push(`🔄 ${report.inProgress.length}`);
  if (report.inReview.length > 0) statusParts.push(`👀 ${report.inReview.length}`);
  statusParts.push(`📋 ${report.ready.length}`);
  lines.push(statusParts.join("  |  "));
  lines.push(``);

  // In Progress details
  if (report.inProgress.length > 0) {
    lines.push(`*🔄 In Progress:*`);
    for (const t of report.inProgress) {
      const repo = t.repo.split("/")[1] ?? t.repo;
      lines.push(`>  #${t.issueNumber} ${t.title} (\`${repo}\`)`);
    }
    lines.push(``);
  }

  // In Review details
  if (report.inReview.length > 0) {
    lines.push(`*👀 In Review:*`);
    for (const t of report.inReview) {
      lines.push(`>  #${t.issueNumber} ${t.title}`);
    }
    lines.push(``);
  }

  // Next up
  if (report.ready.length > 0) {
    const next = report.ready[0];
    const repo = next.repo.split("/")[1] ?? next.repo;
    lines.push(`*📋 Next up:* #${next.issueNumber} ${next.title} (\`${repo}\`)`);
    lines.push(``);
  }

  // Blockers
  if (report.blockers.length > 0) {
    lines.push(`*⚠️ Blockers:*`);
    for (const t of report.blockers) {
      lines.push(`>  #${t.issueNumber} ${t.title}`);
    }
    lines.push(``);
  }

  // Issue progress (parent → children)
  const parents = new Map<number, { title: string; done: number; total: number }>();
  const allTasks = [...report.done, ...report.inProgress, ...report.inReview, ...report.ready];
  for (const t of allTasks) {
    if (t.parentIssue) {
      const key = t.parentIssue.number;
      if (!parents.has(key)) parents.set(key, { title: t.parentIssue.title, done: 0, total: 0 });
      const p = parents.get(key)!;
      p.total++;
      if (report.done.includes(t)) p.done++;
    }
  }
  if (parents.size > 0) {
    lines.push(`*📦 Feature進捗:*`);
    for (const [num, p] of parents) {
      const featureBar = buildProgressBar(
        p.total > 0 ? Math.round((p.done / p.total) * 100) : 0,
        8,
      );
      lines.push(`>  #${num} ${featureBar} ${p.done}/${p.total}`);
    }
  }

  if (report.remainingPoints === 0) {
    lines.push(``);
    lines.push(`🎉 *Sprint 完了！*`);
  }

  return lines.join("\n");
}

function buildProgressBar(pct: number, width: number = 16): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

// ── Main entry ──

export async function postStandup(
  messenger: SlackMessenger,
  channel: string,
): Promise<StandupReport> {
  const report = generateStandup();
  const message = formatStandupMessage(report);
  await messenger.postMessage(channel, message);
  return report;
}
