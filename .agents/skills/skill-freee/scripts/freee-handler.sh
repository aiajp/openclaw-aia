#!/usr/bin/env bash
# freee-handler.sh - Main entry point for freee skill
# Usage: ./freee-handler.sh '<json_action>'
# Example: ./freee-handler.sh '{"action":"get_balance","account_type":"bank"}'

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SLACK_CHANNEL="${SLACK_CHANNEL:-#freee-approvals}"

# Source libraries
# shellcheck source=audit-log.sh
source "${SCRIPT_DIR}/audit-log.sh"
# shellcheck source=approval-flow.sh
source "${SCRIPT_DIR}/approval-flow.sh"
# shellcheck source=freee-api.sh
source "${SCRIPT_DIR}/freee-api.sh"

# ---------------------------------------------------------------------------
# Tier classification
# ---------------------------------------------------------------------------

# get_tier <action> — prints: read|important|irreversible
get_tier() {
    case "${1:-}" in
        get_balance|list_deals|list_invoices|generate_report|list_partners|list_account_items)
            echo "read" ;;
        create_deal|create_invoice)
            echo "important" ;;
        issue_invoice|send_invoice|execute_payment)
            echo "irreversible" ;;
        *)
            echo "unknown" ;;
    esac
}

# get_model <tier> — prints the model to use
get_model() {
    case "${1:-}" in
        read)        echo "claude-haiku-4-5-20251001" ;;
        important)   echo "claude-sonnet-4-6" ;;
        irreversible) echo "claude-opus-4-6" ;;
        *)           echo "claude-opus-4-6" ;;
    esac
}

# ---------------------------------------------------------------------------
# Action detail builders for approval messages
# ---------------------------------------------------------------------------

_deal_details() {
    local action_json="${1:?}"
    local issue_date amount account_item description
    issue_date="$(echo "$action_json" | jq -r '.issue_date // "不明"')"
    amount="$(echo "$action_json" | jq -r '[.details[]?.amount] | add // 0')"
    account_item="$(echo "$action_json" | jq -r '.details[0].account_item // "不明"')"
    description="$(echo "$action_json" | jq -r '.details[0].description // ""')"
    echo "日付: ${issue_date}\n借方: ${account_item} ¥$(printf '%d' "$amount" | sed ':a;s/\B[0-9]\{3\}\>/,&/;ta')\n摘要: ${description}"
}

_invoice_create_details() {
    local action_json="${1:?}"
    local partner issue_date due_date total
    partner="$(echo "$action_json" | jq -r '.partner // "不明"')"
    issue_date="$(echo "$action_json" | jq -r '.issue_date // "不明"')"
    due_date="$(echo "$action_json" | jq -r '.due_date // "不明"')"
    total="$(echo "$action_json" | jq -r '[.items[]? | .unit_price * (.quantity // 1)] | add // 0')"
    echo "請求先: ${partner}\n発行日: ${issue_date}\n期日: ${due_date}\n金額: ¥$(printf '%d' "$total" | sed ':a;s/\B[0-9]\{3\}\>/,&/;ta')（税抜）"
}

_invoice_id_details() {
    local action_json="${1:?}"
    local invoice_id
    invoice_id="$(echo "$action_json" | jq -r '.invoice_id // "不明"')"
    echo "請求書ID: ${invoice_id}"
}

_send_invoice_details() {
    local action_json="${1:?}"
    local invoice_id method
    invoice_id="$(echo "$action_json" | jq -r '.invoice_id // "不明"')"
    method="$(echo "$action_json" | jq -r '.method // "email"')"
    echo "請求書ID: ${invoice_id}\n送付方法: ${method}"
}

_payment_details() {
    local action_json="${1:?}"
    local deal_id amount from_account date
    deal_id="$(echo "$action_json" | jq -r '.deal_id // "不明"')"
    amount="$(echo "$action_json" | jq -r '.amount // 0')"
    from_account="$(echo "$action_json" | jq -r '.from_account // "不明"')"
    date="$(echo "$action_json" | jq -r '.date // "不明"')"
    echo "取引ID: ${deal_id}\n金額: ¥$(printf '%d' "$amount" | sed ':a;s/\B[0-9]\{3\}\>/,&/;ta')\n口座: ${from_account}\n日付: ${date}"
}

# ---------------------------------------------------------------------------
# Slack callback handler
# ---------------------------------------------------------------------------

_handle_callback() {
    local payload="${1:?payload required}"
    handle_slack_callback "$payload"
}

# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------

main() {
    local action_json="${1:-}"

    if [ -z "$action_json" ]; then
        echo '{"error":"action JSON required","usage":"freee-handler.sh <json>"}' >&2
        exit 1
    fi

    # Slack callback
    if echo "$action_json" | jq -e '.type == "block_actions"' > /dev/null 2>&1; then
        _handle_callback "$action_json"
        exit $?
    fi

    local action tier model
    action="$(echo "$action_json" | jq -r '.action // ""')"

    if [ -z "$action" ]; then
        echo '{"error":"missing action field"}' >&2
        exit 1
    fi

    tier="$(get_tier "$action")"
    model="$(get_model "$tier")"

    if [ "$tier" = "unknown" ]; then
        echo "{\"error\":\"unknown action: $action\"}" >&2
        exit 1
    fi

    # Output model assignment info
    echo "{\"action\":\"$action\",\"tier\":\"$tier\",\"model\":\"$model\"}" >&2

    case "$tier" in
        # ----------------------------------------------------------------
        # Tier 1: Read — auto execute
        # ----------------------------------------------------------------
        read)
            case "$action" in
                get_balance)
                    local account_type
                    account_type="$(echo "$action_json" | jq -r '.account_type // "all"')"
                    get_balance "$account_type"
                    ;;
                list_deals)
                    local start_date end_date account_item
                    start_date="$(echo "$action_json" | jq -r '.start_date // ""')"
                    end_date="$(echo "$action_json" | jq -r '.end_date // ""')"
                    account_item="$(echo "$action_json" | jq -r '.account_item // ""')"
                    list_deals "$start_date" "$end_date" "$account_item"
                    ;;
                list_invoices)
                    local status start_date
                    status="$(echo "$action_json" | jq -r '.status // "all"')"
                    start_date="$(echo "$action_json" | jq -r '.start_date // ""')"
                    list_invoices "$status" "$start_date"
                    ;;
                generate_report)
                    local report_type year month
                    report_type="$(echo "$action_json" | jq -r '.type // "pl"')"
                    year="$(echo "$action_json" | jq -r '.year // empty' 2>/dev/null || date +%Y)"
                    month="$(echo "$action_json" | jq -r '.month // empty' 2>/dev/null || date +%m)"
                    generate_report "$report_type" "$year" "$month"
                    ;;
                list_partners)
                    list_partners
                    ;;
                list_account_items)
                    list_account_items
                    ;;
            esac
            ;;

        # ----------------------------------------------------------------
        # Tier 3: Important — single approval required
        # ----------------------------------------------------------------
        important)
            local op_name details approval_result

            case "$action" in
                create_deal)
                    op_name="仕訳登録"
                    details="$(_deal_details "$action_json")"
                    ;;
                create_invoice)
                    op_name="請求書作成"
                    details="$(_invoice_create_details "$action_json")"
                    ;;
                *)
                    op_name="$action"
                    details="$(echo "$action_json" | jq -c '.' 2>/dev/null)"
                    ;;
            esac

            # Log pending
            log_action "$action" "important" "$model" "pending" "" \
                "$(echo "$action_json" | jq -c '.' 2>/dev/null)" "" "pending"

            request_tier3_approval "$action" "$op_name" "$details" "$SLACK_CHANNEL"
            approval_result=$?

            if [ "$approval_result" -ne 0 ]; then
                local appr_status
                [ "$approval_result" -eq 2 ] && appr_status="timeout" || appr_status="rejected"
                log_action "$action" "important" "$model" "$appr_status" "" \
                    "$(echo "$action_json" | jq -c '.' 2>/dev/null)" "" "cancelled"
                echo "{\"error\":\"approval_${appr_status}\",\"action\":\"$action\"}" >&2
                exit 1
            fi

            # Execute approved action
            case "$action" in
                create_deal)
                    local deal_body
                    deal_body="$(echo "$action_json" | jq 'del(.action)')"
                    create_deal "$deal_body" 0
                    ;;
                create_invoice)
                    local inv_body
                    inv_body="$(echo "$action_json" | jq 'del(.action)')"
                    create_invoice "$inv_body" 0
                    ;;
            esac
            ;;

        # ----------------------------------------------------------------
        # Tier 4: Irreversible — two-step approval required
        # ----------------------------------------------------------------
        irreversible)
            local op_name details final_desc approval_result

            case "$action" in
                issue_invoice)
                    local invoice_id
                    invoice_id="$(echo "$action_json" | jq -r '.invoice_id')"
                    op_name="請求書発行"
                    details="$(_invoice_id_details "$action_json")"
                    final_desc="請求書番号 ${invoice_id} を発行します。"
                    ;;
                send_invoice)
                    local invoice_id method
                    invoice_id="$(echo "$action_json" | jq -r '.invoice_id')"
                    method="$(echo "$action_json" | jq -r '.method // "email"')"
                    op_name="請求書送付"
                    details="$(_send_invoice_details "$action_json")"
                    final_desc="請求書番号 ${invoice_id} を ${method} で送付します。"
                    ;;
                execute_payment)
                    local deal_id amount
                    deal_id="$(echo "$action_json" | jq -r '.deal_id')"
                    amount="$(echo "$action_json" | jq -r '.amount')"
                    op_name="支払い実行"
                    details="$(_payment_details "$action_json")"
                    final_desc="取引ID ${deal_id}、¥${amount} の支払いを実行します。"
                    ;;
                *)
                    op_name="$action"
                    details="$(echo "$action_json" | jq -c '.' 2>/dev/null)"
                    final_desc="$action を実行します。"
                    ;;
            esac

            # Log pending
            log_action "$action" "irreversible" "$model" "pending" "1" \
                "$(echo "$action_json" | jq -c '.' 2>/dev/null)" "" "pending"

            request_tier4_approval "$action" "$op_name" "$details" "$final_desc" "$SLACK_CHANNEL"
            approval_result=$?

            if [ "$approval_result" -ne 0 ]; then
                local appr_status
                [ "$approval_result" -eq 2 ] && appr_status="timeout" || appr_status="rejected"
                log_action "$action" "irreversible" "$model" "$appr_status" "2" \
                    "$(echo "$action_json" | jq -c '.' 2>/dev/null)" "" "cancelled"
                echo "{\"error\":\"approval_${appr_status}\",\"action\":\"$action\"}" >&2
                exit 1
            fi

            # Execute approved action
            case "$action" in
                issue_invoice)
                    issue_invoice "$(echo "$action_json" | jq -r '.invoice_id')" 0
                    ;;
                send_invoice)
                    send_invoice \
                        "$(echo "$action_json" | jq -r '.invoice_id')" \
                        "$(echo "$action_json" | jq -r '.method // "email"')" \
                        0
                    ;;
                execute_payment)
                    execute_payment "$(echo "$action_json" | jq 'del(.action)')" 0
                    ;;
            esac
            ;;
    esac

    # Output result
    echo "$FREEE_LAST_RESPONSE"
}

main "$@"
