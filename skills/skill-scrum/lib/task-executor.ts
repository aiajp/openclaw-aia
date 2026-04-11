/**
 * Task Executor
 *
 * Picks the highest-priority "Ready" Task from GitHub Projects
 * and executes it via Claude Code CLI.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import {
  getReadyTasks,
  moveToInProgress,
  moveToInReview,
  type ProjectTask,
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
    // Non-critical: don't fail task execution if comment fails
  }
}

// ── Types ──

export interface ExecutionResult {
  success: boolean;
  task: ProjectTask;
  prNumber?: number;
  model: string;
  duration: number;
  error?: string;
}

export interface SlackMessenger {
  postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string; channel: string }>;
}

// ── Config ──

const IS_MAC = process.platform === "darwin";

const REPO_PATH_MAP: Record<string, string> = IS_MAC
  ? {
      "aiajp/synthagent": "/Volumes/Dev_SSD/synthagent",
      "aiajp/rag-in-a-box": "/Volumes/Dev_SSD/rag-in-a-box",
      "aiajp/openclaw-aia": "/Volumes/Dev_SSD/openclaw-aia",
      "aiajp/aia-corporate-lp": "/Volumes/Dev_SSD/aia-corporate-lp",
      "aiajp/hibi": "/Volumes/Dev_SSD/hibi",
    }
  : {
      "aiajp/synthagent": "/home/ubuntu/synthagent",
      "aiajp/rag-in-a-box": "/home/ubuntu/rag-in-a-box",
      "aiajp/openclaw-aia": "/home/ubuntu/openclaw-aia",
      "aiajp/aia-corporate-lp": "/home/ubuntu/aia-corporate-lp",
    };

// iOS repos require macOS + xcodebuild for build verification
const IOS_REPOS = new Set(["aiajp/hibi"]);

// ── Model resolution ──

function resolveModel(task: ProjectTask, phase: "plan" | "execute"): string {
  // 1. Task に明示指定があればそれを使う
  if (task.model) {
    const modelMap: Record<string, string> = {
      opus: "claude-opus-4-6",
      sonnet: "claude-sonnet-4-6",
      haiku: "claude-haiku-4-5",
    };
    return modelMap[task.model] ?? `claude-${task.model}`;
  }

  // 2. 2フェーズ実行
  if (phase === "plan") return "claude-opus-4-6";
  return "claude-sonnet-4-6";
}

// ── Task selection ──

function selectHighestPriority(tasks: ProjectTask[]): ProjectTask | null {
  if (tasks.length === 0) return null;

  const priorityOrder: Record<string, number> = {
    Critical: 4,
    High: 3,
    Medium: 2,
    Low: 1,
  };

  return tasks.sort((a, b) => {
    const pa = priorityOrder[a.priority ?? "Medium"] ?? 2;
    const pb = priorityOrder[b.priority ?? "Medium"] ?? 2;
    return pb - pa;
  })[0];
}

// ── Build prompt ──

function buildPrompt(task: ProjectTask): string {
  let prompt = `## Task: ${task.title}\n\n${task.body}`;

  if (task.parentIssue) {
    prompt += `\n\n## Parent Issue Context: ${task.parentIssue.title}\n${task.parentIssue.body}`;
  }

  prompt += `\n\n## Instructions
- Create a feature branch: feature/${task.issueNumber}-<short-description>
- Implement the task as described above`;

  if (IOS_REPOS.has(task.repo)) {
    prompt += `
- Verify the build succeeds: xcodebuild -scheme Hibi -destination 'platform=iOS Simulator,name=iPhone 16' build
- If tests exist, run: xcodebuild test -scheme HibiTests -destination 'platform=iOS Simulator,name=iPhone 16'
- Fix any build errors before creating the PR`;
  } else {
    prompt += `
- Run tests to verify`;
  }

  prompt += `
- Create a PR with "Closes #${task.issueNumber}" in the body
- Keep changes focused on this task only`;

  return prompt;
}

// ── Claude Code execution ──

function spawnClaudeCode(
  workdir: string,
  prompt: string,
  model: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      model,
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
      output += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 1, output });
    });

    // Timeout: 30 minutes
    setTimeout(
      () => {
        proc.kill("SIGTERM");
        resolve({ exitCode: 124, output: output + "\n[TIMEOUT after 30 minutes]" });
      },
      30 * 60 * 1000,
    );
  });
}

// ── Format helpers ──

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  return remainSec > 0 ? `${min}m ${remainSec}s` : `${min}m`;
}

// ── Output parsing helpers ──

function extractPrNumber(output: string): number | undefined {
  const match = output.match(/pull\/(\d+)/) ?? output.match(/pull request #(\d+)/i);
  return match ? parseInt(match[1]) : undefined;
}

function extractFilesChanged(output: string): string[] {
  const files: string[] = [];
  // Match common patterns: "Created file.ts", "Modified file.ts", "- file.ts (new)"
  const patterns = [
    /(?:creat|modif|updat|writ|edit)(?:ed|ing)\s+[`"]?([^\s`"]+\.\w+)/gi,
    /^\s*[-+]\s+`?([^\s`]+\.\w+)`?/gm,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output)) !== null) {
      const file = match[1];
      if (!files.includes(file) && !file.startsWith("http")) {
        files.push(file);
      }
    }
  }
  return files.slice(0, 20); // Cap at 20 files
}

function extractCommits(output: string): string[] {
  const commits: string[] = [];
  // Match git commit output: "abc1234 commit message"
  const pattern = /([0-9a-f]{7,}) (.+)/g;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    const msg = `\`${match[1]}\` ${match[2]}`;
    if (!commits.includes(msg)) commits.push(msg);
  }
  return commits.slice(0, 10);
}

// ── Main execution ──

export async function executeNextTask(
  messenger?: SlackMessenger,
  channel?: string,
): Promise<ExecutionResult | null> {
  // 1. Get ready tasks
  const readyTasks = getReadyTasks();
  if (readyTasks.length === 0) {
    return null; // No tasks to execute
  }

  // 2. Select highest priority
  const task = selectHighestPriority(readyTasks);
  if (!task) return null;

  const workdir = REPO_PATH_MAP[task.repo];
  if (!workdir) {
    return {
      success: false,
      task,
      model: "none",
      duration: 0,
      error: `Unknown repo: ${task.repo}`,
    };
  }

  const startTime = Date.now();
  const model = resolveModel(task, "execute");

  // 3. Notify start (Slack + Issue comment)
  const repoShort = task.repo.split("/")[1] ?? task.repo;
  const spLabel = task.labels.find((l) => l.startsWith("SP: "));
  const sp = spLabel ? spLabel.replace("SP: ", "") + "pt" : "";
  const priorityLabel = task.priority ?? "";

  if (messenger && channel) {
    await messenger.postMessage(
      channel,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🔨 *Task Executor — Started*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `*#${task.issueNumber}* ${task.title}\n` +
        `> Repo: \`${repoShort}\` | Model: \`${model}\` | ${sp} ${priorityLabel}\n` +
        `> Branch: \`feature/${task.issueNumber}-*\``,
    );
  }
  commentOnIssue(
    task.repo,
    task.issueNumber,
    `🔨 **Task Executor started**\n` +
      `- Model: \`${model}\`\n` +
      `- Working dir: \`${workdir}\`\n` +
      `- Branch: \`feature/${task.issueNumber}-*\``,
  );

  // 4. Move to In Progress
  moveToInProgress(task.itemId);

  // 5. Execute Claude Code
  const prompt = buildPrompt(task);
  const { exitCode, output } = await spawnClaudeCode(workdir, prompt, model);
  const duration = Date.now() - startTime;
  const durationStr = formatDuration(duration);

  if (exitCode !== 0) {
    if (messenger && channel) {
      await messenger.postMessage(
        channel,
        `❌ *Task #${task.issueNumber} — Failed*\n` +
          `> Exit code: ${exitCode} | ${durationStr}\n` +
          `> \`\`\`${output.slice(-200)}\`\`\``,
      );
    }
    commentOnIssue(
      task.repo,
      task.issueNumber,
      `❌ **Task failed** (exit code: ${exitCode}, ${durationStr})\n` +
        `\`\`\`\n${output.slice(-500)}\n\`\`\``,
    );
    return {
      success: false,
      task,
      model,
      duration,
      error: `Claude Code exited with code ${exitCode}`,
    };
  }

  // 6. Post-execution iOS build verification (safety net)
  if (IOS_REPOS.has(task.repo)) {
    try {
      const scheme = "Hibi"; // TODO: derive from xcodeproj if multiple iOS repos
      execSync(
        `xcodebuild -scheme ${scheme} -destination 'platform=iOS Simulator,name=iPhone 16' build 2>&1 | tail -5`,
        { cwd: workdir, encoding: "utf-8", timeout: 300_000 },
      );
    } catch (buildErr) {
      if (messenger && channel) {
        await messenger.postMessage(
          channel,
          `⚠️ *Task #${task.issueNumber} — xcodebuild failed (post-check)*\n` +
            `> Claude Code completed but build verification failed.\n` +
            `> \`\`\`${String(buildErr).slice(-300)}\`\`\``,
        );
      }
      commentOnIssue(
        task.repo,
        task.issueNumber,
        `⚠️ **Post-execution build check failed**\n` +
          `Claude Code completed but \`xcodebuild\` reports errors.`,
      );
    }
  }

  // 7. Extract changed files from output
  const filesChanged = extractFilesChanged(output);
  const commits = extractCommits(output);

  // 8. Post progress (Issue comment)
  commentOnIssue(
    task.repo,
    task.issueNumber,
    `📝 **Implementation complete** (${durationStr})\n` +
      (filesChanged.length > 0
        ? `\nFiles changed:\n${filesChanged.map((f) => `- \`${f}\``).join("\n")}\n`
        : "") +
      (commits.length > 0 ? `\nCommits:\n${commits.map((c) => `- ${c}`).join("\n")}\n` : ""),
  );

  // 9. Extract PR number and move to In Review
  const prNumber = extractPrNumber(output);
  if (prNumber) {
    moveToInReview(task.itemId);
    commentOnIssue(
      task.repo,
      task.issueNumber,
      `✅ **PR #${prNumber} created** → Auto Review requested`,
    );
  }

  // 10. Notify completion (Slack)
  if (messenger && channel) {
    const filesSummary =
      filesChanged.length > 0
        ? filesChanged
            .slice(0, 5)
            .map((f) => `\`${f}\``)
            .join(", ") + (filesChanged.length > 5 ? ` +${filesChanged.length - 5} more` : "")
        : "no files detected";

    if (prNumber) {
      await messenger.postMessage(
        channel,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `✅ *Task #${task.issueNumber} — Complete*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `*#${task.issueNumber}* ${task.title}\n` +
          `> PR: *#${prNumber}* | ${durationStr} | \`${model}\`\n` +
          `> Files: ${filesSummary}\n` +
          `> Status: Ready → In Progress → *In Review* 🔍`,
      );
    } else {
      await messenger.postMessage(
        channel,
        `⚠️ *Task #${task.issueNumber} — Completed (no PR)*\n` +
          `> ${durationStr} | \`${model}\`\n` +
          `> Files: ${filesSummary}`,
      );
    }
  }

  return {
    success: true,
    task,
    prNumber,
    model,
    duration,
  };
}
