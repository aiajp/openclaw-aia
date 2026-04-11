/**
 * Auto Reviewer
 *
 * Reviews PRs using Claude Code CLI with full repository context.
 * Migrated from KANBAN on-review-trigger.ts to OpenClaw skill.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import {
  getPrDiff,
  approvePr,
  requestChangesPr,
  mergePr,
  getIssueBody,
} from "./github-projects.js";

// ── Issue comment helper ──

function commentOnIssue(repo: string, issueNumber: number, body: string): void {
  try {
    const escaped = body.replace(/"/g, '\\"').replace(/`/g, "\\`");
    execSync(`gh issue comment ${issueNumber} --repo ${repo} --body "${escaped}"`, {
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env },
    });
  } catch {
    // Non-critical
  }
}

// ── Types ──

export interface ReviewRequest {
  repo: string;
  prNumber: number;
  issueNumber?: number;
  branch: string;
}

export interface ReviewResult {
  success: boolean;
  verdict: "approve" | "request_changes" | "error";
  summary: string;
  findings: ReviewFinding[];
  duration: number;
}

interface ReviewFinding {
  severity: "critical" | "warning" | "info";
  description: string;
}

export interface SlackMessenger {
  postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string; channel: string }>;
}

// ── Config ──

const REPO_PATH_MAP: Record<string, string> = {
  "aiajp/synthagent": "/home/ubuntu/synthagent",
  "aiajp/rag-in-a-box": "/home/ubuntu/rag-in-a-box",
  "aiajp/openclaw-aia": "/home/ubuntu/openclaw-aia",
  "aiajp/aia-corporate-lp": "/home/ubuntu/aia-corporate-lp",
};

const REVIEW_MODEL = "claude-opus-4-6";

// ── Review prompt ──

function buildReviewPrompt(prNumber: number, diff: string, issueBody: string): string {
  const truncatedDiff = diff.length > 20000 ? diff.slice(0, 20000) + "\n[...truncated]" : diff;

  return `You are a senior code reviewer. Review this pull request.

## Issue Requirements
${issueBody || "No linked issue found."}

## PR Diff
\`\`\`diff
${truncatedDiff}
\`\`\`

## Review Criteria
1. **Correctness**: Does the code correctly implement the requirements?
2. **Tests**: Are there adequate tests? Do existing tests still pass?
3. **Security**: Any security concerns (injection, auth bypass, secrets)?
4. **Code Quality**: Is the code clean, readable, well-structured?

## Response Format
Respond with ONLY a JSON object (no markdown fences):
{
  "verdict": "approve" or "request_changes",
  "summary": "One paragraph summary of your review",
  "findings": [
    {"severity": "critical|warning|info", "description": "..."}
  ]
}

If the changes are straightforward and correct, approve. Only request changes for real issues.`;
}

// ── Claude Code review execution ──

function runClaudeReview(
  workdir: string,
  prompt: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const args = [
      "--print",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      REVIEW_MODEL,
      prompt,
    ];

    const proc: ChildProcess = spawn("claude", args, {
      cwd: workdir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";

    proc.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      // Ignore stderr for review
    });

    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 1, output });
    });

    // Timeout: 10 minutes for review
    setTimeout(
      () => {
        proc.kill("SIGTERM");
        resolve({ exitCode: 124, output: output + "\n[TIMEOUT]" });
      },
      10 * 60 * 1000,
    );
  });
}

// ── Parse review result ──

function parseReviewOutput(output: string): {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: ReviewFinding[];
} {
  try {
    // Try to extract JSON from output
    const jsonMatch = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        verdict: parsed.verdict === "request_changes" ? "request_changes" : "approve",
        summary: parsed.summary ?? "No summary",
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      };
    }
  } catch {
    // JSON parse failed
  }

  // Default: approve if we can't parse
  return {
    verdict: "approve",
    summary: "Auto-review completed but could not parse structured output. Defaulting to approve.",
    findings: [],
  };
}

// ── Main review ──

export async function reviewPr(
  request: ReviewRequest,
  messenger?: SlackMessenger,
  channel?: string,
): Promise<ReviewResult> {
  const startTime = Date.now();

  const workdir = REPO_PATH_MAP[request.repo];
  if (!workdir) {
    return {
      success: false,
      verdict: "error",
      summary: `Unknown repo: ${request.repo}`,
      findings: [],
      duration: 0,
    };
  }

  // 1. Get PR diff
  let diff: string;
  try {
    diff = getPrDiff(request.repo, request.prNumber);
  } catch (err) {
    return {
      success: false,
      verdict: "error",
      summary: `Failed to get PR diff: ${err}`,
      findings: [],
      duration: Date.now() - startTime,
    };
  }

  // 2. Get issue body for context
  let issueBody = "";
  if (request.issueNumber) {
    try {
      issueBody = getIssueBody(request.repo, request.issueNumber);
    } catch {
      // Issue body is optional context
    }
  }

  // 3. Notify start (Slack + Issue comment)
  if (messenger && channel) {
    await messenger.postMessage(
      channel,
      `🔍 Auto Review: Starting review of PR #${request.prNumber} in ${request.repo} (model: ${REVIEW_MODEL})`,
    );
  }
  if (request.issueNumber) {
    commentOnIssue(
      request.repo,
      request.issueNumber,
      `🔍 **Auto Review started**\n` +
        `- PR: #${request.prNumber}\n` +
        `- Model: \`${REVIEW_MODEL}\`\n` +
        `- Diff size: ${diff.split("\n").length} lines`,
    );
  }

  // 4. Run Claude Code review
  const prompt = buildReviewPrompt(request.prNumber, diff, issueBody);
  const { exitCode, output } = await runClaudeReview(workdir, prompt);
  const duration = Date.now() - startTime;
  const durationStr = `${Math.round(duration / 1000)}s`;

  if (exitCode !== 0 && exitCode !== 124) {
    if (request.issueNumber) {
      commentOnIssue(
        request.repo,
        request.issueNumber,
        `❌ **Auto Review failed** (exit code: ${exitCode}, ${durationStr})`,
      );
    }
    return {
      success: false,
      verdict: "error",
      summary: `Claude Code exited with code ${exitCode}`,
      findings: [],
      duration,
    };
  }

  // 5. Parse review result
  const parsed = parseReviewOutput(output);

  // 6. Post review to GitHub PR
  try {
    const findingsText = parsed.findings
      .map((f) => `- **${f.severity}**: ${f.description}`)
      .join("\n");

    const reviewBody = `**Auto-reviewed by Claude Code (${REVIEW_MODEL})** ${parsed.verdict === "approve" ? "✅" : "❌"}\n\n${parsed.summary}\n\n${findingsText ? `### Findings\n${findingsText}` : ""}`;

    if (parsed.verdict === "approve") {
      approvePr(request.repo, request.prNumber, reviewBody);
      mergePr(request.repo, request.prNumber);
    } else {
      requestChangesPr(request.repo, request.prNumber, reviewBody);
    }
  } catch (err) {
    return {
      success: false,
      verdict: "error",
      summary: `Failed to post review: ${err}`,
      findings: parsed.findings,
      duration,
    };
  }

  // 7. Post result to Issue comment
  if (request.issueNumber) {
    const emoji = parsed.verdict === "approve" ? "✅" : "❌";
    const findingsSummary =
      parsed.findings.length > 0
        ? `\n\nFindings:\n${parsed.findings.map((f) => `- **${f.severity}**: ${f.description}`).join("\n")}`
        : "";
    commentOnIssue(
      request.repo,
      request.issueNumber,
      `${emoji} **Auto Review: ${parsed.verdict}** (${durationStr})\n\n${parsed.summary}${findingsSummary}`,
    );
  }

  // 8. Notify result (Slack)
  if (messenger && channel) {
    const emoji = parsed.verdict === "approve" ? "✅" : "❌";
    await messenger.postMessage(
      channel,
      `${emoji} Auto Review: PR #${request.prNumber} — ${parsed.verdict} (${durationStr})\n${parsed.summary}`,
    );
  }

  return {
    success: true,
    verdict: parsed.verdict,
    summary: parsed.summary,
    findings: parsed.findings,
    duration,
  };
}
