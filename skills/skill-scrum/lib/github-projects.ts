/**
 * GitHub Projects v2 GraphQL API wrapper
 *
 * Provides typed access to the AIA Sprint Board via `gh api graphql`.
 */

import { execSync } from "node:child_process";

// ── Types ──

export interface ProjectTask {
  itemId: string;
  issueNumber: number;
  title: string;
  body: string;
  repo: string;
  status: string;
  priority: string | null;
  storyPoints: string | null;
  model: string | null;
  labels: string[];
  parentIssue: { number: number; title: string; body: string } | null;
}

export interface SprintStatus {
  ready: ProjectTask[];
  inProgress: ProjectTask[];
  inReview: ProjectTask[];
  done: ProjectTask[];
  backlog: ProjectTask[];
}

// ── Config ──

const PROJECT_ID = process.env.PROJECT_ID ?? "PVT_kwHODKzSVM4BB5ON";
const STATUS_FIELD_ID = process.env.STATUS_FIELD_ID ?? "PVTSSF_lAHODKzSVM4BB5ONzg0Q8BE";
const READY_OPTION_ID = process.env.READY_OPTION_ID ?? "c550d719";
const IN_PROGRESS_OPTION_ID = process.env.IN_PROGRESS_OPTION_ID ?? "5920a526";
const IN_REVIEW_OPTION_ID = process.env.IN_REVIEW_OPTION_ID ?? "2f0c9f87";
const DONE_OPTION_ID = process.env.DONE_OPTION_ID ?? "ab6b1837";

// ── GraphQL helper ──

function ghGraphql(query: string): unknown {
  const escaped = query.replace(/'/g, "'\\''");
  const cmd = `gh api graphql -f query='${escaped}'`;
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env },
    }).trim();
    return JSON.parse(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`GitHub GraphQL failed: ${msg}`);
  }
}

function gh(args: string): string {
  try {
    return execSync(`gh ${args}`, {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env },
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gh command failed: ${msg}`);
  }
}

// ── Board queries ──

export function getSprintStatus(): SprintStatus {
  const result = ghGraphql(`
    {
      node(id: "${PROJECT_ID}") {
        ... on ProjectV2 {
          items(first: 100) {
            nodes {
              id
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
              content {
                ... on Issue {
                  number
                  title
                  body
                  labels(first: 10) { nodes { name } }
                  repository { nameWithOwner }
                  parent { number title body }
                }
              }
            }
          }
        }
      }
    }
  `) as { data: { node: { items: { nodes: RawItem[] } } } };

  const items = result.data.node.items.nodes;
  const status: SprintStatus = { ready: [], inProgress: [], inReview: [], done: [], backlog: [] };

  for (const item of items) {
    const content = item.content;
    if (!content?.number) continue;

    const labels = content.labels?.nodes?.map((l: { name: string }) => l.name) ?? [];
    if (labels.includes("Parent")) continue; // Skip parent issues

    const task: ProjectTask = {
      itemId: item.id,
      issueNumber: content.number,
      title: content.title,
      body: content.body ?? "",
      repo: content.repository?.nameWithOwner ?? "",
      status: item.fieldValueByName?.name ?? "Unknown",
      priority: null,
      storyPoints: null,
      model: null,
      labels,
      parentIssue: content.parent
        ? {
            number: content.parent.number,
            title: content.parent.title,
            body: content.parent.body ?? "",
          }
        : null,
    };

    const statusName = task.status;
    if (statusName.includes("Ready")) status.ready.push(task);
    else if (statusName.includes("In Progress")) status.inProgress.push(task);
    else if (statusName.includes("In Review")) status.inReview.push(task);
    else if (statusName.includes("Done")) status.done.push(task);
    else status.backlog.push(task);
  }

  return status;
}

export function getReadyTasks(): ProjectTask[] {
  return getSprintStatus().ready;
}

// ── Board mutations ──

export function moveTaskToStatus(itemId: string, optionId: string): void {
  ghGraphql(`
    mutation {
      updateProjectV2ItemFieldValue(input: {
        projectId: "${PROJECT_ID}"
        itemId: "${itemId}"
        fieldId: "${STATUS_FIELD_ID}"
        value: { singleSelectOptionId: "${optionId}" }
      }) { projectV2Item { id } }
    }
  `);
}

export function moveToInProgress(itemId: string): void {
  moveTaskToStatus(itemId, IN_PROGRESS_OPTION_ID);
}

export function moveToInReview(itemId: string): void {
  moveTaskToStatus(itemId, IN_REVIEW_OPTION_ID);
}

export function moveToDone(itemId: string): void {
  moveTaskToStatus(itemId, DONE_OPTION_ID);
}

export function moveToReady(itemId: string): void {
  moveTaskToStatus(itemId, READY_OPTION_ID);
}

// ── Issue operations ──

export function closeIssue(repo: string, issueNumber: number): void {
  gh(`issue close ${issueNumber} --repo ${repo} --reason completed`);
}

export function getIssueBody(repo: string, issueNumber: number): string {
  return gh(`issue view ${issueNumber} --repo ${repo} --json body -q .body`);
}

// ── PR operations ──

export function getPrDiff(repo: string, prNumber: number): string {
  return gh(`pr diff ${prNumber} --repo ${repo}`);
}

export function approvePr(repo: string, prNumber: number, body: string): void {
  gh(`pr review ${prNumber} --repo ${repo} --approve --body "${body.replace(/"/g, '\\"')}"`);
}

export function requestChangesPr(repo: string, prNumber: number, body: string): void {
  gh(
    `pr review ${prNumber} --repo ${repo} --request-changes --body "${body.replace(/"/g, '\\"')}"`,
  );
}

export function mergePr(repo: string, prNumber: number): void {
  gh(`pr merge ${prNumber} --repo ${repo} --squash --auto`);
}

// ── Internal types ──

interface RawItem {
  id: string;
  fieldValueByName: { name: string } | null;
  content: {
    number: number;
    title: string;
    body: string;
    labels: { nodes: Array<{ name: string }> };
    repository: { nameWithOwner: string };
    parent: { number: number; title: string; body: string } | null;
  } | null;
}
