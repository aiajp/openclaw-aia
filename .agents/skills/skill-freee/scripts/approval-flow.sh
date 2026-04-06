#!/usr/bin/env bash
# approval-flow.sh - Slack Block Kit based approval flow for freee operations
# Usage: source approval-flow.sh

APPROVALS_FILE="${HOME}/.openclaw/data/freee-approvals.json"
APPROVAL_POLL_INTERVAL=5  # seconds

# Ensure approvals file exists
_init_approvals() {
    mkdir -p "$(dirname "$APPROVALS_FILE")"
    if [ ! -f "$APPROVALS_FILE" ]; then
        echo '{}' > "$APPROVALS_FILE"
        chmod 600 "$APPROVALS_FILE"
    fi
}

# _generate_approval_id <action>
_generate_approval_id() {
    local action="${1:-unknown}"
    echo "${action}_$(date -u +%Y%m%dT%H%M%S)_$$"
}

# _store_approval <approval_id> <status> [step]
_store_approval() {
    local approval_id="${1:?approval_id required}"
    local status="${2:?status required}"
    local step="${3:-}"
    local timestamp
    timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    _init_approvals
    local current
    current="$(cat "$APPROVALS_FILE")"
    local entry
    entry="$(jq -n \
        --arg id "$approval_id" \
        --arg s "$status" \
        --arg t "$timestamp" \
        --arg st "$step" \
        '{id: $id, status: $s, updated_at: $t, step: $st}')"
    echo "$current" | jq --arg id "$approval_id" --argjson e "$entry" \
        '.[$id] = $e' > "$APPROVALS_FILE"
}

# _get_approval_status <approval_id>
_get_approval_status() {
    local approval_id="${1:?approval_id required}"
    _init_approvals
    jq -r --arg id "$approval_id" '.[$id].status // "not_found"' "$APPROVALS_FILE"
}

# _wait_for_approval <approval_id> <timeout_seconds>
# Returns 0=approved, 1=rejected, 2=timeout, 3=cancelled
_wait_for_approval() {
    local approval_id="${1:?approval_id required}"
    local timeout_secs="${2:-300}"
    local elapsed=0

    while [ "$elapsed" -lt "$timeout_secs" ]; do
        local status
        status="$(_get_approval_status "$approval_id")"
        case "$status" in
            approved)   return 0 ;;
            rejected)   return 1 ;;
            cancelled)  return 3 ;;
            timeout)    return 2 ;;
        esac
        sleep "$APPROVAL_POLL_INTERVAL"
        elapsed=$((elapsed + APPROVAL_POLL_INTERVAL))
    done

    # Timeout: update status and return
    _store_approval "$approval_id" "timeout"
    return 2
}

# _send_slack_blocks <channel> <json_blocks_string>
# Returns ts (message timestamp) on success
_send_slack_blocks() {
    local channel="${1:?channel required}"
    local blocks="${2:?blocks required}"

    if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
        echo "[approval-flow] WARNING: SLACK_BOT_TOKEN not set, skipping Slack notification" >&2
        echo "mock_ts_$(date +%s)"
        return 0
    fi

    local payload
    payload="$(jq -n \
        --arg ch "$channel" \
        --argjson bl "$blocks" \
        '{channel: $ch, blocks: $bl}')"

    local response
    response="$(curl -sf -X POST \
        -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
        -H "Content-Type: application/json; charset=utf-8" \
        --data "$payload" \
        "https://slack.com/api/chat.postMessage")"

    if [ $? -ne 0 ]; then
        echo "[approval-flow] ERROR: curl failed posting to Slack" >&2
        return 1
    fi

    local ok ts
    ok="$(echo "$response" | jq -r '.ok')"
    ts="$(echo "$response" | jq -r '.ts // ""')"

    if [ "$ok" != "true" ]; then
        local err
        err="$(echo "$response" | jq -r '.error // "unknown"')"
        echo "[approval-flow] ERROR: Slack API error: $err" >&2
        return 1
    fi

    echo "$ts"
}

# _update_slack_message <channel> <ts> <blocks>
_update_slack_message() {
    local channel="${1:?channel required}"
    local ts="${2:?ts required}"
    local blocks="${3:?blocks required}"

    if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
        return 0
    fi

    local payload
    payload="$(jq -n \
        --arg ch "$channel" \
        --arg ts "$ts" \
        --argjson bl "$blocks" \
        '{channel: $ch, ts: $ts, blocks: $bl}')"

    curl -sf -X POST \
        -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
        -H "Content-Type: application/json; charset=utf-8" \
        --data "$payload" \
        "https://slack.com/api/chat.update" > /dev/null
}

# _build_tier3_blocks <approval_id> <operation_name> <details_mrkdwn>
_build_tier3_blocks() {
    local approval_id="${1:?}"
    local op_name="${2:?}"
    local details="${3:?}"

    jq -n \
        --arg op "$op_name" \
        --arg det "$details" \
        --arg aid "$approval_id" \
        '[
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": ("🔔 *freee " + $op + " 確認*\n" + $det)
            }
          },
          {
            "type": "actions",
            "elements": [
              {
                "type": "button",
                "text": {"type": "plain_text", "text": "✅ 承認", "emoji": true},
                "style": "primary",
                "action_id": "freee_approve",
                "value": ("approve:" + $aid)
              },
              {
                "type": "button",
                "text": {"type": "plain_text", "text": "❌ キャンセル", "emoji": true},
                "style": "danger",
                "action_id": "freee_cancel",
                "value": ("cancel:" + $aid)
              }
            ]
          }
        ]'
}

# _build_tier4_step1_blocks <approval_id> <operation_name> <details_mrkdwn>
_build_tier4_step1_blocks() {
    local approval_id="${1:?}"
    local op_name="${2:?}"
    local details="${3:?}"

    jq -n \
        --arg op "$op_name" \
        --arg det "$details" \
        --arg aid "$approval_id" \
        '[
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": ("🔔 *freee " + $op + " 確認（ステップ 1/2）*\n" + $det + "\n\n内容を確認してください。")
            }
          },
          {
            "type": "actions",
            "elements": [
              {
                "type": "button",
                "text": {"type": "plain_text", "text": "✅ 承認", "emoji": true},
                "style": "primary",
                "action_id": "freee_approve_step1",
                "value": ("approve_step1:" + $aid)
              },
              {
                "type": "button",
                "text": {"type": "plain_text", "text": "❌ キャンセル", "emoji": true},
                "style": "danger",
                "action_id": "freee_cancel_step1",
                "value": ("cancel_step1:" + $aid)
              }
            ]
          }
        ]'
}

# _build_tier4_step2_blocks <approval_id> <operation_name> <final_description>
_build_tier4_step2_blocks() {
    local approval_id="${1:?}"
    local op_name="${2:?}"
    local final_desc="${3:?}"

    jq -n \
        --arg op "$op_name" \
        --arg fdesc "$final_desc" \
        --arg aid "$approval_id" \
        '[
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": ("⚠️ *freee " + $op + " 最終確認（ステップ 2/2）*\nこの操作は取り消せません。\n" + $fdesc)
            }
          },
          {
            "type": "actions",
            "elements": [
              {
                "type": "button",
                "text": {"type": "plain_text", "text": "✅ 最終承認", "emoji": true},
                "style": "primary",
                "action_id": "freee_approve_step2",
                "value": ("approve_step2:" + $aid),
                "confirm": {
                  "title": {"type": "plain_text", "text": "本当に実行しますか？"},
                  "text": {"type": "mrkdwn", "text": "この操作は *取り消せません*。"},
                  "confirm": {"type": "plain_text", "text": "実行する"},
                  "deny": {"type": "plain_text", "text": "やめる"},
                  "style": "danger"
                }
              },
              {
                "type": "button",
                "text": {"type": "plain_text", "text": "❌ キャンセル", "emoji": true},
                "style": "danger",
                "action_id": "freee_cancel_step2",
                "value": ("cancel_step2:" + $aid)
              }
            ]
          }
        ]'
}

# _build_status_blocks <message>
_build_status_blocks() {
    local message="${1:?}"
    jq -n --arg msg "$message" \
        '[{"type": "section", "text": {"type": "mrkdwn", "text": $msg}}]'
}

# request_tier3_approval <action> <operation_name> <details_mrkdwn> <channel>
# Returns 0=approved, 1=rejected/cancelled, 2=timeout
request_tier3_approval() {
    local action="${1:?request_tier3_approval: action required}"
    local op_name="${2:?request_tier3_approval: operation_name required}"
    local details="${3:?request_tier3_approval: details required}"
    local channel="${4:-${SLACK_CHANNEL:-#freee-approvals}}"
    local timeout_secs=300  # 5 minutes

    local approval_id
    approval_id="$(_generate_approval_id "$action")"

    # Store pending approval
    _store_approval "$approval_id" "pending" "1"

    # Build and send Block Kit message
    local blocks
    blocks="$(_build_tier3_blocks "$approval_id" "$op_name" "$details")"
    local msg_ts
    msg_ts="$(_send_slack_blocks "$channel" "$blocks")"
    if [ $? -ne 0 ]; then
        _store_approval "$approval_id" "error"
        return 1
    fi

    echo "[approval-flow] Tier3 approval request sent (id=$approval_id, ts=$msg_ts)" >&2

    # Wait for approval
    _wait_for_approval "$approval_id" "$timeout_secs"
    local result=$?

    # Update Slack message with result status
    local status_msg
    case $result in
        0) status_msg="✅ *承認されました* (id: $approval_id)" ;;
        1) status_msg="❌ *却下されました* (id: $approval_id)" ;;
        2) status_msg="⏱️ *タイムアウトにより自動キャンセルされました* (id: $approval_id)" ;;
        3) status_msg="❌ *キャンセルされました* (id: $approval_id)" ;;
    esac
    if [ -n "$msg_ts" ]; then
        _update_slack_message "$channel" "$msg_ts" \
            "$(_build_status_blocks "$status_msg")"
    fi

    return $result
}

# request_tier4_approval <action> <operation_name> <details_mrkdwn> <final_description> <channel>
# Returns 0=fully_approved, 1=rejected/cancelled, 2=timeout
request_tier4_approval() {
    local action="${1:?request_tier4_approval: action required}"
    local op_name="${2:?request_tier4_approval: operation_name required}"
    local details="${3:?request_tier4_approval: details required}"
    local final_desc="${4:?request_tier4_approval: final_description required}"
    local channel="${5:-${SLACK_CHANNEL:-#freee-approvals}}"
    local step1_timeout=300  # 5 minutes
    local step2_timeout=180  # 3 minutes

    local approval_id
    approval_id="$(_generate_approval_id "$action")"

    # ---- Step 1 ----
    _store_approval "$approval_id" "pending" "1"

    local blocks1
    blocks1="$(_build_tier4_step1_blocks "$approval_id" "$op_name" "$details")"
    local msg_ts1
    msg_ts1="$(_send_slack_blocks "$channel" "$blocks1")"
    if [ $? -ne 0 ]; then
        _store_approval "$approval_id" "error"
        return 1
    fi

    echo "[approval-flow] Tier4 step1 approval request sent (id=$approval_id)" >&2

    _wait_for_approval "$approval_id" "$step1_timeout"
    local step1_result=$?

    if [ "$step1_result" -ne 0 ]; then
        local status_msg
        case $step1_result in
            1) status_msg="❌ *ステップ1で却下されました* (id: $approval_id)" ;;
            2) status_msg="⏱️ *ステップ1タイムアウト — 自動キャンセル* (id: $approval_id)" ;;
            3) status_msg="❌ *ステップ1でキャンセルされました* (id: $approval_id)" ;;
        esac
        [ -n "$msg_ts1" ] && _update_slack_message "$channel" "$msg_ts1" \
            "$(_build_status_blocks "$status_msg")"
        return 1
    fi

    # Update step1 message to show approved
    [ -n "$msg_ts1" ] && _update_slack_message "$channel" "$msg_ts1" \
        "$(_build_status_blocks "✅ *ステップ1 承認済み* — ステップ2へ進みます (id: $approval_id)")"

    # ---- Step 2 ----
    # Reset approval status for step2
    _store_approval "$approval_id" "pending" "2"

    local blocks2
    blocks2="$(_build_tier4_step2_blocks "$approval_id" "$op_name" "$final_desc")"
    local msg_ts2
    msg_ts2="$(_send_slack_blocks "$channel" "$blocks2")"
    if [ $? -ne 0 ]; then
        _store_approval "$approval_id" "error"
        return 1
    fi

    echo "[approval-flow] Tier4 step2 approval request sent (id=$approval_id)" >&2

    _wait_for_approval "$approval_id" "$step2_timeout"
    local step2_result=$?

    local status_msg2
    case $step2_result in
        0) status_msg2="✅ *最終承認完了* — 実行します (id: $approval_id)" ;;
        1) status_msg2="❌ *最終ステップで却下されました* (id: $approval_id)" ;;
        2) status_msg2="⏱️ *ステップ2タイムアウト — ステップ1承認済みですが実行されません* (id: $approval_id)" ;;
        3) status_msg2="❌ *ステップ2でキャンセルされました* (id: $approval_id)" ;;
    esac
    [ -n "$msg_ts2" ] && _update_slack_message "$channel" "$msg_ts2" \
        "$(_build_status_blocks "$status_msg2")"

    return $step2_result
}

# handle_slack_callback <raw_payload_json>
# Called by freee-handler.sh when Slack sends an action callback
# Updates freee-approvals.json based on button press
handle_slack_callback() {
    local payload="${1:?handle_slack_callback: payload required}"

    local action_id value
    action_id="$(echo "$payload" | jq -r '.actions[0].action_id // ""')"
    value="$(echo "$payload" | jq -r '.actions[0].value // ""')"

    if [ -z "$action_id" ] || [ -z "$value" ]; then
        echo "[approval-flow] ERROR: invalid callback payload" >&2
        return 1
    fi

    # value format: "approve:<approval_id>" or "cancel:<approval_id>" etc.
    local verdict approval_id
    verdict="${value%%:*}"
    approval_id="${value#*:}"

    if [ -z "$approval_id" ]; then
        echo "[approval-flow] ERROR: could not extract approval_id from value: $value" >&2
        return 1
    fi

    case "$verdict" in
        approve|approve_step1)
            _store_approval "$approval_id" "approved" "1"
            echo "[approval-flow] Approval recorded: $approval_id => approved (step1)"
            ;;
        approve_step2)
            _store_approval "$approval_id" "approved" "2"
            echo "[approval-flow] Approval recorded: $approval_id => approved (step2)"
            ;;
        cancel|cancel_step1|cancel_step2)
            _store_approval "$approval_id" "cancelled"
            echo "[approval-flow] Approval recorded: $approval_id => cancelled"
            ;;
        *)
            echo "[approval-flow] WARNING: unknown verdict '$verdict' for $approval_id" >&2
            return 1
            ;;
    esac
}
