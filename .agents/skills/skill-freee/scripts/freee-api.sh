#!/usr/bin/env bash
# freee-api.sh - freee API client with OAuth2 token management
# Usage: source freee-api.sh

FREEE_API_BASE="https://api.freee.co.jp"
FREEE_TOKEN_URL="https://accounts.secure.freee.co.jp/public_api/token"
FREEE_TOKENS_FILE="${HOME}/.openclaw/data/freee-tokens.json"

# Source audit-log if not already loaded
if ! declare -f log_action > /dev/null 2>&1; then
    # shellcheck source=audit-log.sh
    source "$(dirname "${BASH_SOURCE[0]}")/audit-log.sh"
fi

# ---------------------------------------------------------------------------
# Token management
# ---------------------------------------------------------------------------

_load_tokens() {
    mkdir -p "$(dirname "$FREEE_TOKENS_FILE")"
    if [ -f "$FREEE_TOKENS_FILE" ]; then
        local tokens
        tokens="$(cat "$FREEE_TOKENS_FILE")"
        FREEE_ACCESS_TOKEN="$(echo "$tokens" | jq -r '.access_token // ""')"
        # Only override env var if file has a value
        [ -n "$FREEE_ACCESS_TOKEN" ] && export FREEE_ACCESS_TOKEN
    fi
}

_save_tokens() {
    local access_token="${1:?}"
    local refresh_token="${2:-}"
    local expires_at="${3:-}"

    mkdir -p "$(dirname "$FREEE_TOKENS_FILE")"
    jq -n \
        --arg at "$access_token" \
        --arg rt "$refresh_token" \
        --arg ea "$expires_at" \
        '{access_token: $at, refresh_token: $rt, expires_at: $ea}' \
        > "$FREEE_TOKENS_FILE"
    chmod 600 "$FREEE_TOKENS_FILE"
}

refresh_token() {
    local refresh_tok="${1:-}"

    # Try to get refresh token from file if not provided
    if [ -z "$refresh_tok" ] && [ -f "$FREEE_TOKENS_FILE" ]; then
        refresh_tok="$(jq -r '.refresh_token // ""' "$FREEE_TOKENS_FILE")"
    fi

    if [ -z "$refresh_tok" ]; then
        echo "[freee-api] ERROR: no refresh token available" >&2
        return 1
    fi

    if [ -z "${FREEE_CLIENT_ID:-}" ] || [ -z "${FREEE_CLIENT_SECRET:-}" ]; then
        echo "[freee-api] ERROR: FREEE_CLIENT_ID and FREEE_CLIENT_SECRET required for token refresh" >&2
        return 1
    fi

    local response
    response="$(curl -sf -X POST "$FREEE_TOKEN_URL" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "grant_type=refresh_token" \
        -d "client_id=${FREEE_CLIENT_ID}" \
        -d "client_secret=${FREEE_CLIENT_SECRET}" \
        -d "refresh_token=${refresh_tok}")"

    if [ $? -ne 0 ]; then
        echo "[freee-api] ERROR: token refresh request failed" >&2
        return 1
    fi

    local new_access new_refresh expires_in
    new_access="$(echo "$response" | jq -r '.access_token // ""')"
    new_refresh="$(echo "$response" | jq -r '.refresh_token // ""')"
    expires_in="$(echo "$response" | jq -r '.expires_in // ""')"

    if [ -z "$new_access" ]; then
        echo "[freee-api] ERROR: token refresh returned no access_token" >&2
        return 1
    fi

    local expires_at=""
    if [ -n "$expires_in" ]; then
        expires_at="$(date -u -d "+${expires_in} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
                      date -u -v "+${expires_in}S" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
                      echo "")"
    fi

    export FREEE_ACCESS_TOKEN="$new_access"
    _save_tokens "$new_access" "$new_refresh" "$expires_at"
    echo "[freee-api] Token refreshed successfully" >&2
}

# ---------------------------------------------------------------------------
# HTTP request helper with retry/backoff
# ---------------------------------------------------------------------------

# _freee_request <method> <path> [json_body]
# Sets FREEE_LAST_STATUS and FREEE_LAST_RESPONSE
_freee_request() {
    local method="${1:?method required}"
    local path="${2:?path required}"
    local body="${3:-}"
    local max_retries_429=3
    local max_retries_5xx=2
    local attempt=0
    local backoff=1

    _load_tokens

    while true; do
        local args=(-sf -w "\n__HTTP_STATUS__%{http_code}" \
            -H "Authorization: Bearer ${FREEE_ACCESS_TOKEN}" \
            -H "Content-Type: application/json" \
            -H "Accept: application/json")

        if [ -n "$body" ]; then
            args+=(-d "$body")
        fi

        local raw_response
        raw_response="$(curl "${args[@]}" -X "$method" "${FREEE_API_BASE}${path}")"
        local curl_exit=$?

        # Parse status and body
        FREEE_LAST_STATUS="$(echo "$raw_response" | grep '__HTTP_STATUS__' | sed 's/__HTTP_STATUS__//')"
        FREEE_LAST_RESPONSE="$(echo "$raw_response" | grep -v '__HTTP_STATUS__')"

        if [ $curl_exit -ne 0 ] && [ -z "$FREEE_LAST_STATUS" ]; then
            echo "[freee-api] ERROR: curl failed (exit=$curl_exit)" >&2
            return 1
        fi

        case "$FREEE_LAST_STATUS" in
            2*)
                return 0
                ;;
            401)
                echo "[freee-api] 401 Unauthorized — attempting token refresh" >&2
                if refresh_token; then
                    continue  # retry with new token (one time)
                else
                    _notify_slack_error "freee API認証エラー (401): トークンリフレッシュ失敗"
                    return 1
                fi
                ;;
            403)
                echo "[freee-api] ERROR: 403 Forbidden" >&2
                _notify_slack_error "freee API権限エラー (403): ${path}"
                return 1
                ;;
            400)
                local err_msg
                err_msg="$(echo "$FREEE_LAST_RESPONSE" | jq -r '.errors[]?.messages[]? // .message // "バリデーションエラー"' 2>/dev/null | head -3 | tr '\n' ' ')"
                echo "[freee-api] ERROR: 400 Bad Request: $err_msg" >&2
                _notify_slack_error "freee APIバリデーションエラー (400): $err_msg"
                return 1
                ;;
            429)
                attempt=$((attempt + 1))
                if [ "$attempt" -gt "$max_retries_429" ]; then
                    echo "[freee-api] ERROR: rate limit exceeded after $max_retries_429 retries" >&2
                    return 1
                fi
                echo "[freee-api] 429 Rate limit — backoff ${backoff}s (attempt $attempt)" >&2
                sleep "$backoff"
                backoff=$((backoff * 2))
                ;;
            5*)
                attempt=$((attempt + 1))
                if [ "$attempt" -gt "$max_retries_5xx" ]; then
                    echo "[freee-api] ERROR: server error $FREEE_LAST_STATUS after $max_retries_5xx retries" >&2
                    _notify_slack_error "freee APIサーバーエラー ($FREEE_LAST_STATUS): ${path}"
                    return 1
                fi
                echo "[freee-api] ${FREEE_LAST_STATUS} Server error — retry in ${backoff}s (attempt $attempt)" >&2
                sleep "$backoff"
                backoff=$((backoff * 2))
                ;;
            *)
                echo "[freee-api] ERROR: unexpected status $FREEE_LAST_STATUS" >&2
                return 1
                ;;
        esac
    done
}

# ---------------------------------------------------------------------------
# Slack error notification helper
# ---------------------------------------------------------------------------

_notify_slack_error() {
    local message="${1:-freee APIエラーが発生しました}"
    local channel="${SLACK_CHANNEL:-#freee-errors}"

    if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
        echo "[freee-api] Slack notify (no token): $message" >&2
        return 0
    fi

    local payload
    payload="$(jq -n \
        --arg ch "$channel" \
        --arg msg "🚨 *freee APIエラー*\n$message" \
        '{channel: $ch, text: $msg}')"

    curl -sf -X POST \
        -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
        -H "Content-Type: application/json" \
        --data "$payload" \
        "https://slack.com/api/chat.postMessage" > /dev/null
}

# ---------------------------------------------------------------------------
# Helper: mask account number (keep last 4 digits)
# ---------------------------------------------------------------------------
_mask_account() {
    local num="${1:-}"
    if [ ${#num} -gt 4 ]; then
        local masked
        masked="$(printf '%0*d' $((${#num} - 4)) 0 | tr '0' '*')"
        echo "${masked}${num: -4}"
    else
        echo "$num"
    fi
}

# ---------------------------------------------------------------------------
# API functions
# ---------------------------------------------------------------------------

get_balance() {
    local account_type="${1:-all}"
    local company_id="${FREEE_COMPANY_ID:?FREEE_COMPANY_ID required}"

    local path="/api/1/walletables?company_id=${company_id}"
    [ "$account_type" != "all" ] && path="${path}&type=${account_type}"

    _freee_request GET "$path"
    local exit_code=$?
    log_action "get_balance" "read" "claude-haiku-4-5-20251001" "auto" "" \
        "{\"account_type\":\"$account_type\"}" "$FREEE_LAST_STATUS" \
        "$([ $exit_code -eq 0 ] && echo success || echo failure)"
    return $exit_code
}

list_deals() {
    local start_date="${1:-}"
    local end_date="${2:-}"
    local account_item="${3:-}"
    local company_id="${FREEE_COMPANY_ID:?FREEE_COMPANY_ID required}"

    local path="/api/1/deals?company_id=${company_id}"
    [ -n "$start_date" ] && path="${path}&start_issue_date=${start_date}"
    [ -n "$end_date" ]   && path="${path}&end_issue_date=${end_date}"
    [ -n "$account_item" ] && path="${path}&account_item_name=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$account_item'))" 2>/dev/null || echo "$account_item")"

    _freee_request GET "$path"
    local exit_code=$?
    log_action "list_deals" "read" "claude-haiku-4-5-20251001" "auto" "" \
        "{\"start_date\":\"$start_date\",\"end_date\":\"$end_date\"}" "$FREEE_LAST_STATUS" \
        "$([ $exit_code -eq 0 ] && echo success || echo failure)"
    return $exit_code
}

list_invoices() {
    local status="${1:-all}"
    local start_date="${2:-}"
    local company_id="${FREEE_COMPANY_ID:?FREEE_COMPANY_ID required}"

    local path="/api/1/invoices?company_id=${company_id}"
    [ "$status" != "all" ] && path="${path}&invoice_status=${status}"
    [ -n "$start_date" ] && path="${path}&start_issue_date=${start_date}"

    _freee_request GET "$path"
    local exit_code=$?
    log_action "list_invoices" "read" "claude-haiku-4-5-20251001" "auto" "" \
        "{\"status\":\"$status\",\"start_date\":\"$start_date\"}" "$FREEE_LAST_STATUS" \
        "$([ $exit_code -eq 0 ] && echo success || echo failure)"
    return $exit_code
}

list_partners() {
    local company_id="${FREEE_COMPANY_ID:?FREEE_COMPANY_ID required}"

    _freee_request GET "/api/1/partners?company_id=${company_id}"
    local exit_code=$?
    log_action "list_partners" "read" "claude-haiku-4-5-20251001" "auto" "" \
        "{\"company_id\":\"$company_id\"}" "$FREEE_LAST_STATUS" \
        "$([ $exit_code -eq 0 ] && echo success || echo failure)"
    return $exit_code
}

list_account_items() {
    local company_id="${FREEE_COMPANY_ID:?FREEE_COMPANY_ID required}"

    _freee_request GET "/api/1/account_items?company_id=${company_id}"
    local exit_code=$?
    log_action "list_account_items" "read" "claude-haiku-4-5-20251001" "auto" "" \
        "{\"company_id\":\"$company_id\"}" "$FREEE_LAST_STATUS" \
        "$([ $exit_code -eq 0 ] && echo success || echo failure)"
    return $exit_code
}

generate_report() {
    local report_type="${1:-pl}"
    local year="${2:-$(date +%Y)}"
    local month="${3:-$(date +%m)}"
    local company_id="${FREEE_COMPANY_ID:?FREEE_COMPANY_ID required}"

    local path
    case "$report_type" in
        pl)            path="/api/1/reports/trial_pl_three_years" ;;
        bs)            path="/api/1/reports/trial_bs_two_years" ;;
        trial_balance) path="/api/1/reports/trial_pl" ;;
        *)             path="/api/1/reports/trial_pl" ;;
    esac
    path="${path}?company_id=${company_id}&fiscal_year=${year}&start_month=${month}&end_month=${month}"

    _freee_request GET "$path"
    local exit_code=$?
    log_action "generate_report" "read" "claude-haiku-4-5-20251001" "auto" "" \
        "{\"type\":\"$report_type\",\"year\":$year,\"month\":$month}" "$FREEE_LAST_STATUS" \
        "$([ $exit_code -eq 0 ] && echo success || echo failure)"
    return $exit_code
}

create_deal() {
    local deal_json="${1:?create_deal: deal_json required}"
    local approval_result="${2:-0}"  # pre-approved by handler
    local company_id="${FREEE_COMPANY_ID:?FREEE_COMPANY_ID required}"

    local body
    body="$(echo "$deal_json" | jq --arg cid "$company_id" '. + {company_id: ($cid | tonumber)}')"

    if [ "$approval_result" -ne 0 ]; then
        log_action "create_deal" "important" "claude-sonnet-4-6" "rejected" "" \
            "$(echo "$deal_json" | jq -c '{issue_date,type}' 2>/dev/null)" "" "cancelled"
        return 1
    fi

    _freee_request POST "/api/1/deals" "$body"
    local exit_code=$?
    local freee_id=""
    [ $exit_code -eq 0 ] && freee_id="$(echo "$FREEE_LAST_RESPONSE" | jq -r '.deal.id // ""')"

    log_action "create_deal" "important" "claude-sonnet-4-6" "approved" "" \
        "$(echo "$deal_json" | jq -c '{issue_date,type,"details_count":(.details | length)}' 2>/dev/null)" \
        "$FREEE_LAST_STATUS" \
        "$([ $exit_code -eq 0 ] && echo success || echo failure)" \
        "$freee_id"
    return $exit_code
}

create_invoice() {
    local invoice_json="${1:?create_invoice: invoice_json required}"
    local approval_result="${2:-0}"
    local company_id="${FREEE_COMPANY_ID:?FREEE_COMPANY_ID required}"

    local body
    body="$(echo "$invoice_json" | jq --arg cid "$company_id" '. + {company_id: ($cid | tonumber)}')"

    if [ "$approval_result" -ne 0 ]; then
        log_action "create_invoice" "important" "claude-sonnet-4-6" "rejected" "" \
            "$(echo "$invoice_json" | jq -c '{partner_name,issue_date,due_date}' 2>/dev/null)" "" "cancelled"
        return 1
    fi

    _freee_request POST "/api/1/invoices" "$body"
    local exit_code=$?
    local freee_id=""
    [ $exit_code -eq 0 ] && freee_id="$(echo "$FREEE_LAST_RESPONSE" | jq -r '.invoice.id // ""')"

    log_action "create_invoice" "important" "claude-sonnet-4-6" "approved" "" \
        "$(echo "$invoice_json" | jq -c '{partner_name,issue_date,due_date}' 2>/dev/null)" \
        "$FREEE_LAST_STATUS" \
        "$([ $exit_code -eq 0 ] && echo success || echo failure)" \
        "$freee_id"
    return $exit_code
}

issue_invoice() {
    local invoice_id="${1:?issue_invoice: invoice_id required}"
    local approval_result="${2:-0}"
    local company_id="${FREEE_COMPANY_ID:?FREEE_COMPANY_ID required}"

    if [ "$approval_result" -ne 0 ]; then
        log_action "issue_invoice" "irreversible" "claude-opus-4-6" "rejected" "2" \
            "{\"invoice_id\":$invoice_id}" "" "cancelled"
        return 1
    fi

    local body
    body="$(jq -n --arg cid "$company_id" --argjson iid "$invoice_id" \
        '{company_id: ($cid | tonumber), invoice_status: "issued"}')"

    _freee_request PUT "/api/1/invoices/${invoice_id}" "$body"
    local exit_code=$?

    log_action "issue_invoice" "irreversible" "claude-opus-4-6" "approved" "2" \
        "{\"invoice_id\":$invoice_id}" "$FREEE_LAST_STATUS" \
        "$([ $exit_code -eq 0 ] && echo success || echo failure)" \
        "$invoice_id"
    return $exit_code
}

send_invoice() {
    local invoice_id="${1:?send_invoice: invoice_id required}"
    local method="${2:-email}"
    local approval_result="${3:-0}"
    local company_id="${FREEE_COMPANY_ID:?FREEE_COMPANY_ID required}"

    if [ "$approval_result" -ne 0 ]; then
        log_action "send_invoice" "irreversible" "claude-opus-4-6" "rejected" "2" \
            "{\"invoice_id\":$invoice_id,\"method\":\"$method\"}" "" "cancelled"
        return 1
    fi

    local body
    body="$(jq -n \
        --arg cid "$company_id" \
        --argjson iid "$invoice_id" \
        --arg m "$method" \
        '{company_id: ($cid | tonumber), send_method: $m}')"

    _freee_request POST "/api/1/invoices/${invoice_id}/mail_send" "$body"
    local exit_code=$?

    log_action "send_invoice" "irreversible" "claude-opus-4-6" "approved" "2" \
        "{\"invoice_id\":$invoice_id,\"method\":\"$method\"}" "$FREEE_LAST_STATUS" \
        "$([ $exit_code -eq 0 ] && echo success || echo failure)" \
        "$invoice_id"
    return $exit_code
}

execute_payment() {
    local payment_json="${1:?execute_payment: payment_json required}"
    local approval_result="${2:-0}"
    local company_id="${FREEE_COMPANY_ID:?FREEE_COMPANY_ID required}"

    local deal_id amount from_account date
    deal_id="$(echo "$payment_json" | jq -r '.deal_id')"
    amount="$(echo "$payment_json" | jq -r '.amount')"
    from_account="$(echo "$payment_json" | jq -r '.from_account')"
    date="$(echo "$payment_json" | jq -r '.date')"

    if [ "$approval_result" -ne 0 ]; then
        log_action "execute_payment" "irreversible" "claude-opus-4-6" "rejected" "2" \
            "{\"deal_id\":$deal_id,\"amount\":$amount}" "" "cancelled"
        return 1
    fi

    local body
    body="$(jq -n \
        --arg cid "$company_id" \
        --argjson amt "$amount" \
        --arg acc "$from_account" \
        --arg dt "$date" \
        '{company_id: ($cid | tonumber), amount: $amt, from_walletable_type: "bank_account", from_walletable_name: $acc, date: $dt}')"

    _freee_request POST "/api/1/deals/${deal_id}/payments" "$body"
    local exit_code=$?

    log_action "execute_payment" "irreversible" "claude-opus-4-6" "approved" "2" \
        "{\"deal_id\":$deal_id,\"amount\":$amount,\"from_account\":\"$from_account\"}" \
        "$FREEE_LAST_STATUS" \
        "$([ $exit_code -eq 0 ] && echo success || echo failure)" \
        "$deal_id"
    return $exit_code
}
