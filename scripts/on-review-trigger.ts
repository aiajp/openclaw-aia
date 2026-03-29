#!/usr/bin/env npx tsx
/**
 * on-review-trigger.ts — Claude Code CLI-based PR review for Kanban tasks
 *
 * Replaces the grep-based on-review-trigger.sh with semantic code review
 * using Claude Code CLI (--print --model opus). Uses browser/subscription auth.
 *
 * Called by Kanban runtime when a task enters awaiting_review.
 * Args: argv[1] = workspaceId, argv[2] = taskId
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

// ── Config ──

const KANBAN_BASE = process.env.KANBAN_BASE ?? "http://localhost:3484/api/trpc";
const REVIEW_MODEL = process.env.REVIEW_MODEL ?? "opus";
const DEFAULT_REPO = process.env.REVIEWER_DEFAULT_REPO ?? "aiajp/synthagent";
const MAX_RETRIES = parseInt(process.env.REVIEW_MAX_RETRIES ?? "2", 10);
const LOG_FILE = "/tmp/review-trigger.log";

// ── Logging ──

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    execSync(`echo ${JSON.stringify(line)} >> ${LOG_FILE}`, { stdio: "ignore" });
  } catch {
    // best-effort logging
  }
  process.stderr.write(line);
}

// ── Types ──

interface ReviewFinding {
  severity: "critical" | "warning" | "info";
  category: "spec_compliance" | "code_quality" | "security" | "architecture";
  file?: string;
  detail: string;
  suggestion?: string;
}

interface ReviewResult {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: ReviewFinding[];
}

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

// ── GitHub helpers ──

function gh(args: string, repo: string): string {
  try {
    return execSync(`gh ${args} --repo ${repo}`, {
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();
  } catch (err) {
    throw new Error(`gh failed: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

function extractPrNumber(text: string): string | null {
  const match = text.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  return match ? match[1] : null;
}

// ── Claude Code CLI Review ──

function callOpusReview(
  sddSpec: string,
  prDiff: string,
  prTitle: string,
  repo: string,
): ReviewResult {
  const reviewPrompt = `You are a senior code reviewer for AIA's projects (repo: ${repo}).

Review this PR against the SDD specification and return ONLY a valid JSON object (no markdown, no code fences).

## SDD Specification (Task Card)
${sddSpec}

## PR Title
${prTitle}

## PR Diff
\`\`\`diff
${prDiff.slice(0, 50_000)}
\`\`\`

## Review Criteria

1. **Spec Compliance** (Critical): Does the code implement what the spec describes? Missing requirements or scope creep?

2. **Code Quality** (Critical):
   - Tests present for new code (Python/TypeScript)
   - Type hints (Python: no bare \`Any\`; TypeScript: no \`any\`)
   - No debug/temp files committed
   - No TODO placeholders in core logic

3. **Security** (4-tier classification per SPEC.md):
   - Tier 1 BLOCK: Hardcoded secrets, SQL injection, command injection
   - Tier 2 BLOCK: Missing auth checks, SSRF vectors
   - Tier 3 WARN: Overly permissive permissions, missing rate limiting
   - Tier 4 INFO: Security-adjacent files changed (auth/, billing/)

4. **Architecture Alignment** (Warning):
   - Follows existing project patterns
   - No unnecessary dependencies
   - File organization matches conventions

Return JSON with this exact structure:
{
  "verdict": "approve" or "request_changes",
  "summary": "1-2 sentence overall assessment",
  "findings": [
    {
      "severity": "critical" or "warning" or "info",
      "category": "spec_compliance" or "code_quality" or "security" or "architecture",
      "file": "path/to/file (optional)",
      "detail": "description of the issue",
      "suggestion": "how to fix (optional)"
    }
  ]
}

If everything looks good, return verdict "approve" with an empty findings array.`;

  // Use Claude Code CLI with --print (non-interactive, subscription auth)
  const output = execSync(`claude --print --model ${REVIEW_MODEL} --output-format text`, {
    input: reviewPrompt,
    encoding: "utf-8",
    timeout: 180_000, // 3 minutes
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0" },
  }).trim();

  // Parse JSON from response (handle potential markdown fences)
  let jsonStr = output;
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }
  // Also handle case where response has text before/after JSON
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  return JSON.parse(jsonStr) as ReviewResult;
}

// ── Retry management ──

function getRetryCount(taskId: string): number {
  const retryFile = `/tmp/review-retry-${taskId}.count`;
  if (!existsSync(retryFile)) {
    return 0;
  }
  return parseInt(readFileSync(retryFile, "utf-8").trim(), 10) || 0;
}

function incrementRetryCount(taskId: string): number {
  const retryFile = `/tmp/review-retry-${taskId}.count`;
  const count = getRetryCount(taskId) + 1;
  writeFileSync(retryFile, String(count), "utf-8");
  return count;
}

function clearRetryCount(taskId: string): void {
  const retryFile = `/tmp/review-retry-${taskId}.count`;
  if (existsSync(retryFile)) {
    unlinkSync(retryFile);
  }
}

// ── Format review for PR comment ──

function formatReviewComment(result: ReviewResult, retryCount: number, maxRetries: number): string {
  const verdictEmoji = result.verdict === "approve" ? "✅" : "❌";
  const lines: string[] = [
    `## 🔍 Opus AI Review`,
    "",
    `**${verdictEmoji} ${result.verdict === "approve" ? "Approved" : "Request Changes"}**`,
    "",
    result.summary,
    "",
  ];

  const criticals = result.findings.filter((f) => f.severity === "critical");
  const warnings = result.findings.filter((f) => f.severity === "warning");
  const infos = result.findings.filter((f) => f.severity === "info");

  if (criticals.length > 0) {
    lines.push("### ❌ Critical");
    for (const f of criticals) {
      lines.push(`- **[${f.category}]** ${f.detail}${f.file ? ` (\`${f.file}\`)` : ""}`);
      if (f.suggestion) {
        lines.push(`  → ${f.suggestion}`);
      }
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("### ⚠️ Warning");
    for (const f of warnings) {
      lines.push(`- **[${f.category}]** ${f.detail}${f.file ? ` (\`${f.file}\`)` : ""}`);
      if (f.suggestion) {
        lines.push(`  → ${f.suggestion}`);
      }
    }
    lines.push("");
  }

  if (infos.length > 0) {
    lines.push("### ℹ️ Info");
    for (const f of infos) {
      lines.push(`- **[${f.category}]** ${f.detail}${f.file ? ` (\`${f.file}\`)` : ""}`);
    }
    lines.push("");
  }

  if (result.verdict === "request_changes") {
    lines.push(`---`);
    lines.push(`_Auto-retry: ${retryCount}/${maxRetries}_`);
  }

  return lines.join("\n");
}

// ── Format fix prompt for retry ──

function buildFixPrompt(sddSpec: string, findings: ReviewFinding[]): string {
  const findingsText = findings
    .filter((f) => f.severity === "critical" || f.severity === "warning")
    .map((f) => {
      let line = `- [${f.severity.toUpperCase()}] [${f.category}] ${f.detail}`;
      if (f.file) {
        line += ` (${f.file})`;
      }
      if (f.suggestion) {
        line += `\n  修正方法: ${f.suggestion}`;
      }
      return line;
    })
    .join("\n");

  return `## 元のタスク仕様
${sddSpec}

## レビュー指摘（修正必須）
${findingsText}

上記の指摘事項をすべて修正してください。修正後にコミットしてPRを更新してください。
テストが不足している場合は追加してください。`;
}

// ── Main ──

async function main(): Promise<void> {
  const workspaceId = process.argv[2];
  const taskId = process.argv[3];

  log(`=== Review trigger: workspace=${workspaceId} task=${taskId} ===`);

  if (!taskId) {
    log("ERROR: No taskId provided");
    process.exit(1);
  }

  // 1. Get task state from Kanban
  const state = (await trpcQuery("workspace.getState", workspaceId)) as {
    board: { columns: BoardColumn[] };
    sessions: Record<string, TaskSession>;
  };

  // 2. Find card prompt (SDD spec)
  let cardPrompt = "";
  for (const col of state.board.columns) {
    const card = col.cards.find((c) => c.id === taskId);
    if (card) {
      cardPrompt = card.prompt;
      break;
    }
  }

  // 3. Extract PR number from session activity
  const session = state.sessions[taskId];
  const activityMsg =
    session?.latestHookActivity?.finalMessage ?? session?.latestHookActivity?.activityText ?? "";

  const prNumber = extractPrNumber(activityMsg);
  if (!prNumber) {
    log(`No PR number found in task activity for ${taskId}`);
    process.exit(0);
  }

  log(`Found PR #${prNumber} for task ${taskId}`);

  // 4. Get PR info and diff
  const prInfoRaw = gh(
    `pr view ${prNumber} --json title,additions,deletions,changedFiles`,
    DEFAULT_REPO,
  );
  const prInfo = JSON.parse(prInfoRaw) as {
    title: string;
    additions: number;
    deletions: number;
    changedFiles: number;
  };
  const prDiff = gh(`pr diff ${prNumber}`, DEFAULT_REPO);

  log(
    `PR #${prNumber}: ${prInfo.title} (+${prInfo.additions}/-${prInfo.deletions}, ${prInfo.changedFiles} files)`,
  );

  // 5. Call Claude Code CLI for review
  log("Calling Claude Code CLI for review (model: " + REVIEW_MODEL + ")...");
  let reviewResult: ReviewResult;
  try {
    reviewResult = callOpusReview(cardPrompt, prDiff, prInfo.title, DEFAULT_REPO);
  } catch (err) {
    log(`Claude Code review error: ${err instanceof Error ? err.message : String(err)}`);
    // Fallback: don't block, leave for manual review
    log("Falling back to manual review (leaving task in awaiting_review)");
    process.exit(0);
  }

  log(`Review verdict: ${reviewResult.verdict} (${reviewResult.findings.length} findings)`);

  // 6. Decision
  if (reviewResult.verdict === "approve") {
    // Approve and merge
    clearRetryCount(taskId);
    log(`APPROVE PR #${prNumber} — merging`);

    try {
      gh(`pr merge ${prNumber} --merge --delete-branch`, DEFAULT_REPO);
      log(`Merged PR #${prNumber}`);
    } catch (err) {
      log(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    // Request changes
    const retryCount = getRetryCount(taskId);
    const commentBody = formatReviewComment(reviewResult, retryCount, MAX_RETRIES);

    // Post review comment to PR
    log(`REJECT PR #${prNumber}: posting review comment`);
    try {
      const escaped = commentBody.replace(/'/g, "'\\''");
      gh(`pr comment ${prNumber} --body '${escaped}'`, DEFAULT_REPO);
    } catch (err) {
      log(`Failed to post comment: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Auto-retry if within budget
    if (retryCount < MAX_RETRIES) {
      const newCount = incrementRetryCount(taskId);
      log(`Auto-retry ${newCount}/${MAX_RETRIES} for task ${taskId}`);

      const fixPrompt = buildFixPrompt(cardPrompt, reviewResult.findings);

      // Stop current session, restart with fix prompt
      try {
        await trpcMutation("runtime.stopTaskSession", workspaceId, { taskId });
        log("Stopped current session");
      } catch (err) {
        log(
          `Stop session failed (may already be stopped): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        await trpcMutation("runtime.startTaskSession", workspaceId, {
          taskId,
          prompt: fixPrompt,
          startInPlanMode: false,
          baseRef: "HEAD",
        });
        log(`Started fix session for task ${taskId}`);
      } catch (err) {
        log(`Start fix session failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // Max retries exceeded — leave for manual intervention
      clearRetryCount(taskId);
      log(
        `Max retries (${MAX_RETRIES}) exceeded for task ${taskId}. Manual intervention required.`,
      );

      // Post final comment
      try {
        const finalComment = `## 🛑 Auto-retry limit reached\n\nThis PR has been reviewed ${MAX_RETRIES} times and still has issues. Manual review required.\n\nLatest issues:\n${reviewResult.findings.map((f) => `- [${f.severity}] ${f.detail}`).join("\n")}`;
        const escaped = finalComment.replace(/'/g, "'\\''");
        gh(`pr comment ${prNumber} --body '${escaped}'`, DEFAULT_REPO);
      } catch {
        // best-effort
      }
    }
  }

  log("=== Review trigger complete ===");
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
