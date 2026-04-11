#!/usr/bin/env bash
# on-review-trigger.sh — gstack-inspired auto-review with 6 decision principles
# Args: $1 = workspaceId, $2 = taskId
#
# Decision Principles (from gstack autoplan):
# 1. Clearly Yes/No → auto-decide
# 2. Clear trade-off → choose minimum cost
# 3. Matches existing pattern → follow pattern
# 4. Reversible → approve (try it)
# 5. Irreversible → reject (ask human)
# 6. Taste/judgment → reject (ask human)

set -euo pipefail

WORKSPACE_ID="${1:-}"
TASK_ID="${2:-}"
REPO="aiajp/synthagent"
KANBAN_BASE="http://localhost:3484/api/trpc"
LOG_FILE="/tmp/review-trigger.log"
SESSION_DIR="/tmp/kanban-sessions"
MAX_CONCURRENT=3

log() {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

# --- Session tracking (gstack-inspired) ---
mkdir -p "$SESSION_DIR"
touch "$SESSION_DIR/$TASK_ID"
ACTIVE_SESSIONS=$(find "$SESSION_DIR" -mmin -30 -type f 2>/dev/null | wc -l | tr -d ' ')
find "$SESSION_DIR" -mmin +30 -type f -exec rm {} + 2>/dev/null || true
log "=== Review trigger: workspace=$WORKSPACE_ID task=$TASK_ID (active=$ACTIVE_SESSIONS) ==="

if [[ -z "$TASK_ID" ]]; then
    log "ERROR: No taskId provided"
    exit 1
fi

# --- 1. Get task session info ---
TASK_STATE=$(curl -s "$KANBAN_BASE/workspace.getState?input=%7B%22json%22%3Anull%7D" \
    -H "x-kanban-workspace-id: $WORKSPACE_ID" 2>/dev/null)

# --- 2. Extract PR number ---
PR_NUMBER=$(echo "$TASK_STATE" | python3 -c "
import sys, json, re
state = json.loads(sys.stdin.read())['result']['data']
session = state['sessions'].get('$TASK_ID', {})
activity = session.get('latestHookActivity', {}) or {}
msg = activity.get('finalMessage', '') or activity.get('activityText', '') or ''
match = re.search(r'https://github\.com/[^/]+/[^/]+/pull/(\d+)', msg)
if match:
    print(match.group(1))
" 2>/dev/null)

if [[ -z "$PR_NUMBER" ]]; then
    log "No PR number found in task activity for $TASK_ID"
    rm -f "$SESSION_DIR/$TASK_ID"
    exit 0
fi

log "Found PR #$PR_NUMBER for task $TASK_ID"

# --- 3. Fetch PR info ---
PR_INFO=$(GITHUB_TOKEN= gh pr view "$PR_NUMBER" --repo "$REPO" --json title,body,additions,deletions,changedFiles 2>/dev/null || true)
if [[ -z "$PR_INFO" ]]; then
    log "ERROR: Could not fetch PR #$PR_NUMBER"
    rm -f "$SESSION_DIR/$TASK_ID"
    exit 1
fi

PR_TITLE=$(echo "$PR_INFO" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['title'])")
PR_ADDITIONS=$(echo "$PR_INFO" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['additions'])")
PR_DELETIONS=$(echo "$PR_INFO" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['deletions'])")
PR_FILES=$(echo "$PR_INFO" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['changedFiles'])")
PR_BODY=$(echo "$PR_INFO" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('body',''))")

log "PR #$PR_NUMBER: $PR_TITLE (+$PR_ADDITIONS/-$PR_DELETIONS, $PR_FILES files)"

# --- 4. Get diff ---
PR_DIFF=$(GITHUB_TOKEN= gh pr diff "$PR_NUMBER" --repo "$REPO" 2>/dev/null || true)
PR_FILE_LIST=$(echo "$PR_DIFF" | grep "^diff --git" | sed 's/diff --git a\///' | sed 's/ b\/.*//' || true)

# --- 5. Apply 6 Decision Principles ---

CRITICAL=""
WARNINGS=""
DECISION="approve"  # Default: approve (Principle 4: reversible → try it)

# === CRITICAL checks (Principle 1: Clearly No → reject) ===

# C1: Hardcoded secrets
if echo "$PR_DIFF" | grep -qiE '(password|secret|api_key|token)\s*=\s*"[^"]{8,}"'; then
    CRITICAL="${CRITICAL}C1: ハードコードされた認証情報を検出\n"
    DECISION="reject"
fi

# C2: .env or credential files committed
if echo "$PR_FILE_LIST" | grep -qiE '\.env$|credentials|\.pem$|\.key$'; then
    CRITICAL="${CRITICAL}C2: 認証ファイルがコミットされています\n"
    DECISION="reject"
fi

# C3: Irreversible infrastructure changes without plan (Principle 5)
if echo "$PR_FILE_LIST" | grep -qiE '\.tf$'; then
    HAS_DESTROY=$(echo "$PR_DIFF" | grep -c "resource.*\"aws_" | head -1 || echo "0")
    if [[ "$HAS_DESTROY" -gt 5 ]]; then
        WARNINGS="${WARNINGS}W-INFRA: Terraform変更が大きい（${HAS_DESTROY}リソース） — 要手動確認\n"
    fi
fi

# === PATTERN checks (Principle 3: Matches pattern → follow) ===

# P1: New Python code should have tests
HAS_NEW_PY=$(echo "$PR_FILE_LIST" | grep -E '\.py$' | grep -v test | grep -v __pycache__ | grep -v __init__ | head -1 || true)
HAS_TESTS=$(echo "$PR_FILE_LIST" | grep -iE 'test' | head -1 || true)
if [[ -n "$HAS_NEW_PY" && -z "$HAS_TESTS" ]]; then
    # Check if it's docs-only or config-only (Principle 4: reversible)
    ONLY_DOCS=$(echo "$PR_FILE_LIST" | grep -v -E '\.md$|\.json$|\.yaml$|\.yml$|\.toml$|\.txt$|\.cfg$' | grep -v test | head -1 || true)
    if [[ -n "$ONLY_DOCS" ]]; then
        WARNINGS="${WARNINGS}W-TEST: 新規Pythonコードにテストファイルなし\n"
    fi
fi

# P2: PR should have description
if [[ -z "$PR_BODY" || ${#PR_BODY} -lt 20 ]]; then
    WARNINGS="${WARNINGS}W-DESC: PR説明が不足しています\n"
fi

# P3: tasks.md should be updated for feature PRs
if echo "$PR_TITLE" | grep -qiE 'feat|fix|phase|task|launch'; then
    if ! echo "$PR_FILE_LIST" | grep -q "tasks.md"; then
        WARNINGS="${WARNINGS}W-TASKS: tasks.md が未更新\n"
    fi
fi

# === SIZE check (Principle 2: Trade-off → minimum cost) ===

# Large PRs get warning but not rejection (reversible via revert)
if [[ "$PR_ADDITIONS" -gt 2000 ]]; then
    WARNINGS="${WARNINGS}W-SIZE: 大きなPR (+$PR_ADDITIONS行) — レビュー負荷が高い\n"
fi

# === JUDGMENT check (Principle 6: Taste → ask human) ===

# Security-sensitive files need extra attention
SECURITY_FILES=$(echo "$PR_FILE_LIST" | grep -iE 'auth|billing|metering|subscription|rate_limit|secret|iam' || true)
if [[ -n "$SECURITY_FILES" ]]; then
    SEC_COUNT=$(echo "$SECURITY_FILES" | wc -l | tr -d ' ')
    WARNINGS="${WARNINGS}W-SEC: セキュリティ関連ファイル ${SEC_COUNT}件 — 重点確認済み\n"
fi

# --- 6. Build review report ---
REPORT="## 🔍 Auto Review: PR #$PR_NUMBER — $PR_TITLE\n\n"
REPORT+="**サイズ:** +$PR_ADDITIONS/-$PR_DELETIONS ($PR_FILES files)\n"
REPORT+="**並列セッション:** $ACTIVE_SESSIONS\n\n"

if [[ -n "$CRITICAL" ]]; then
    REPORT+="### ❌ Critical (自動拒否)\n$CRITICAL\n"
fi

if [[ -n "$WARNINGS" ]]; then
    REPORT+="### ⚠️ Warning\n$WARNINGS\n"
fi

if [[ "$DECISION" == "approve" ]]; then
    REPORT+="### ✅ 判定: Approve\n"
    REPORT+="判断原則: "
    if [[ -z "$WARNINGS" ]]; then
        REPORT+="Principle 1 (明確にOK)\n"
    else
        REPORT+="Principle 4 (可逆的 → 承認)\n"
    fi
else
    REPORT+="### ❌ 判定: Request Changes\n"
    REPORT+="判断原則: Principle 5 (不可逆リスク → 人に確認)\n"
fi

# --- 7. Execute decision ---
if [[ "$DECISION" == "reject" ]]; then
    log "REJECT PR #$PR_NUMBER: $(echo -e "$CRITICAL" | tr '\n' ' ')"
    GITHUB_TOKEN= gh pr comment "$PR_NUMBER" --repo "$REPO" --body "$(echo -e "$REPORT\nPlease fix the critical issues above and push again.")" 2>/dev/null || true

    # Resume task agent for re-work
    log "Resuming task $TASK_ID for re-work..."
    RESUME_PAYLOAD="{\"event\":\"to_in_progress\",\"taskId\":\"$TASK_ID\",\"workspaceId\":\"$WORKSPACE_ID\",\"metadata\":{\"source\":\"reviewer\",\"activityText\":\"Auto-review rejected: $(echo -e "$CRITICAL" | tr '\n' ' ' | head -c 140)\"}}"
    curl -s -X POST "$KANBAN_BASE/hooks.ingest" \
        -H "Content-Type: application/json" \
        -H "x-kanban-workspace-id: $WORKSPACE_ID" \
        -d "$RESUME_PAYLOAD" 2>/dev/null || true
    log "Task $TASK_ID resumed for re-work"
else
    log "APPROVE PR #$PR_NUMBER"

    # Post review report as comment (for audit trail)
    GITHUB_TOKEN= gh pr comment "$PR_NUMBER" --repo "$REPO" --body "$(echo -e "$REPORT")" 2>/dev/null || true

    # Merge
    GITHUB_TOKEN= gh pr merge "$PR_NUMBER" --repo "$REPO" --merge --delete-branch 2>/dev/null || true
    log "Merged PR #$PR_NUMBER"
fi

rm -f "$SESSION_DIR/$TASK_ID"
log "=== Review trigger complete ==="
