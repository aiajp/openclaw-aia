#!/usr/bin/env bash
# Thin wrapper for Kanban's KANBAN_REVIEW_TRIGGER_SCRIPT env var.
# Kanban expects a bash script; this delegates to the TypeScript implementation.
exec npx tsx "$(dirname "$0")/on-review-trigger.ts" "$@"
