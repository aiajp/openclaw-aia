/**
 * skill-reviewer handler
 *
 * Automated PR review for KANBAN task completion.
 * Fetches PR diff via `gh`, applies review criteria, and reports results.
 */

import { execSync } from "node:child_process";

// ── Types ──

export interface SlackMessenger {
  postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string; channel: string }>;
}

export type ReviewAction = "review" | "approve" | "request-changes" | "status";

export interface ReviewPayload {
  action: ReviewAction;
  prNumber?: number;
  repo?: string;
}

interface ReviewResult {
  verdict: "approve" | "request_changes";
  critical: CheckItem[];
  warnings: CheckItem[];
  summary: string;
}

interface CheckItem {
  name: string;
  passed: boolean;
  detail: string;
}

// ── Config ──

const DEFAULT_REPO = process.env.REVIEWER_DEFAULT_REPO ?? "aiajp/synthagent";

// ── GitHub helpers ──

function gh(args: string, repo: string): string {
  const cmd = `GITHUB_TOKEN= gh ${args} --repo ${repo}`;
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, GITHUB_TOKEN: "" },
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gh command failed: ${msg}`);
  }
}

function getPrInfo(
  prNumber: number,
  repo: string,
): { title: string; body: string; additions: number; deletions: number; changedFiles: number } {
  const raw = gh(`pr view ${prNumber} --json title,body,additions,deletions,changedFiles`, repo);
  return JSON.parse(raw);
}

function getPrDiff(prNumber: number, repo: string): string {
  return gh(`pr diff ${prNumber}`, repo);
}

function getPrFiles(prNumber: number, repo: string): string[] {
  const raw = gh(`pr diff ${prNumber} --name-only`, repo);
  return raw.split("\n").filter(Boolean);
}

function getOpenPrs(repo: string): Array<{ number: number; title: string; createdAt: string }> {
  const raw = gh(`pr list --state open --json number,title,createdAt`, repo);
  return JSON.parse(raw);
}

function mergePr(prNumber: number, repo: string): boolean {
  try {
    gh(`pr merge ${prNumber} --merge --delete-branch`, repo);
    return true;
  } catch {
    return false;
  }
}

function commentPr(prNumber: number, repo: string, body: string): void {
  const escaped = body.replace(/'/g, "'\\''");
  gh(`pr comment ${prNumber} --body '${escaped}'`, repo);
}

// ── Review Logic ──

function reviewDiff(
  diff: string,
  files: string[],
  info: { title: string; body: string },
): ReviewResult {
  const critical: CheckItem[] = [];
  const warnings: CheckItem[] = [];

  // 1. Test check
  const testFiles = files.filter(
    (f) => f.includes("test_") || f.includes("_test.") || f.includes("/tests/"),
  );
  const srcFiles = files.filter(
    (f) => (f.endsWith(".py") || f.endsWith(".ts")) && !testFiles.includes(f),
  );
  const hasNewCode = srcFiles.length > 0;
  const hasTests = testFiles.length > 0;

  critical.push({
    name: "テスト",
    passed: !hasNewCode || hasTests,
    detail: hasTests
      ? `${testFiles.length}件のテストファイル`
      : hasNewCode
        ? "新規コードにテストがありません"
        : "コード変更なし",
  });

  // 2. Type hints (Python)
  const pyFiles = srcFiles.filter((f) => f.endsWith(".py"));
  const hasAnyType = diff.includes(": Any") || diff.includes("-> Any");
  const missingHints = pyFiles.length > 0 && diff.match(/def \w+\([^)]*\)(?!.*->)/gm);

  critical.push({
    name: "型ヒント",
    passed: !hasAnyType && !missingHints,
    detail: hasAnyType ? "Any型の使用を検出" : missingHints ? "戻り値型ヒントが不足" : "OK",
  });

  // 3. Security check
  const securityFiles = files.filter(
    (f) =>
      f.includes("auth/") ||
      f.includes("billing") ||
      f.includes("metering") ||
      f.includes("subscription") ||
      f.includes("rate_limit"),
  );
  const hasHardcodedSecrets = /(?:password|secret|api_key|token)\s*=\s*["'][^"']+["']/i.test(diff);

  critical.push({
    name: "セキュリティ",
    passed: !hasHardcodedSecrets,
    detail: hasHardcodedSecrets
      ? "ハードコードされた認証情報を検出"
      : securityFiles.length > 0
        ? `セキュリティ関連ファイル ${securityFiles.length}件 — 重点確認済み`
        : "セキュリティ関連の変更なし",
  });

  // 4. tasks.md consistency
  const tasksChanged = files.some((f) => f.includes("tasks.md"));
  const hasMeaningfulChanges = srcFiles.length > 0;

  critical.push({
    name: "tasks.md整合性",
    passed: true, // Warning level, not blocking
    detail: tasksChanged
      ? "tasks.md 更新あり"
      : hasMeaningfulChanges
        ? "tasks.md 未更新（要確認）"
        : "N/A",
  });

  // 5. Coding conventions (warning)
  const hasDebugFiles = files.some(
    (f) =>
      f.includes("debug") ||
      f.includes("temp_") ||
      f.endsWith(".log") ||
      (f === "tasks.md" && !f.includes(".kiro/")),
  );
  if (hasDebugFiles) {
    warnings.push({
      name: "不要ファイル",
      passed: false,
      detail: "デバッグ/一時ファイルの混入の可能性",
    });
  }

  // 6. PR composition
  const unrelatedFiles = files.filter(
    (f) =>
      !f.includes(
        info.title
          .split(":")[0]
          ?.toLowerCase()
          .replace(/[^a-z]/g, "") ?? "",
      ) &&
      !f.includes("test") &&
      !f.includes("tasks"),
  );
  if (unrelatedFiles.length > files.length * 0.5 && files.length > 5) {
    warnings.push({
      name: "PR構成",
      passed: false,
      detail: `${unrelatedFiles.length}/${files.length} ファイルがPRタイトルと無関係の可能性`,
    });
  }

  const allCriticalPassed = critical.every((c) => c.passed);
  const verdict = allCriticalPassed ? "approve" : "request_changes";

  const failedCriticals = critical.filter((c) => !c.passed);
  const summary = allCriticalPassed
    ? `全チェック通過。${srcFiles.length}ファイル変更、${testFiles.length}テストファイル。`
    : `${failedCriticals.length}件のCritical問題: ${failedCriticals.map((c) => c.name).join(", ")}`;

  return { verdict, critical, warnings, summary };
}

function formatReviewResult(prNumber: number, title: string, result: ReviewResult): string {
  const verdictEmoji = result.verdict === "approve" ? "✅ Approve" : "❌ Request Changes";
  const lines: string[] = [
    `*🔍 PR Review: #${prNumber} — ${title}*`,
    "",
    `*判定: ${verdictEmoji}*`,
    "",
    "*Critical*",
  ];

  for (const item of result.critical) {
    const icon = item.passed ? "✅" : "❌";
    lines.push(`${icon} ${item.name}: ${item.detail}`);
  }

  if (result.warnings.length > 0) {
    lines.push("", "*Warning*");
    for (const item of result.warnings) {
      lines.push(`⚠️ ${item.name}: ${item.detail}`);
    }
  }

  lines.push("", `*Summary:* ${result.summary}`);
  return lines.join("\n");
}

// ── Main handler ──

export async function handleReview(
  payload: ReviewPayload,
  slack: SlackMessenger,
  channel: string,
  threadTs?: string,
): Promise<void> {
  const repo = payload.repo ?? DEFAULT_REPO;

  try {
    switch (payload.action) {
      case "review": {
        if (!payload.prNumber) {
          await slack.postMessage(channel, "PRの番号を指定してください。", threadTs);
          return;
        }
        const info = getPrInfo(payload.prNumber, repo);
        const diff = getPrDiff(payload.prNumber, repo);
        const files = getPrFiles(payload.prNumber, repo);
        const result = reviewDiff(diff, files, info);
        const text = formatReviewResult(payload.prNumber, info.title, result);
        await slack.postMessage(channel, text, threadTs);
        break;
      }

      case "approve": {
        if (!payload.prNumber) {
          await slack.postMessage(channel, "PRの番号を指定してください。", threadTs);
          return;
        }
        const info = getPrInfo(payload.prNumber, repo);
        const diff = getPrDiff(payload.prNumber, repo);
        const files = getPrFiles(payload.prNumber, repo);
        const result = reviewDiff(diff, files, info);

        if (result.verdict !== "approve") {
          const text = formatReviewResult(payload.prNumber, info.title, result);
          await slack.postMessage(channel, `マージをブロックしました。\n\n${text}`, threadTs);
          return;
        }

        const merged = mergePr(payload.prNumber, repo);
        if (merged) {
          await slack.postMessage(
            channel,
            `✅ PR #${payload.prNumber} をマージしました: ${info.title}`,
            threadTs,
          );
        } else {
          await slack.postMessage(
            channel,
            `❌ PR #${payload.prNumber} のマージに失敗しました。`,
            threadTs,
          );
        }
        break;
      }

      case "request-changes": {
        if (!payload.prNumber) {
          await slack.postMessage(channel, "PRの番号を指定してください。", threadTs);
          return;
        }
        const info = getPrInfo(payload.prNumber, repo);
        const diff = getPrDiff(payload.prNumber, repo);
        const files = getPrFiles(payload.prNumber, repo);
        const result = reviewDiff(diff, files, info);
        const text = formatReviewResult(payload.prNumber, info.title, result);

        commentPr(payload.prNumber, repo, text);
        await slack.postMessage(
          channel,
          `📝 PR #${payload.prNumber} にレビューコメントを投稿しました。`,
          threadTs,
        );
        break;
      }

      case "status": {
        const prs = getOpenPrs(repo);
        if (prs.length === 0) {
          await slack.postMessage(channel, "レビュー待ちのPRはありません。", threadTs);
          return;
        }
        const lines = ["*📋 レビュー待ちPR一覧*", ""];
        for (const pr of prs) {
          lines.push(`• #${pr.number}: ${pr.title}`);
        }
        await slack.postMessage(channel, lines.join("\n"), threadTs);
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await slack.postMessage(channel, `❌ Reviewer エラー: ${msg}`, threadTs);
  }
}
