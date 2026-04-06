#!/usr/bin/env bash
# audit-log.sh - SQLite-based audit logging for freee operations
# Usage: source audit-log.sh

AUDIT_DB="${HOME}/.openclaw/data/freee-audit.db"

init_db() {
    mkdir -p "$(dirname "$AUDIT_DB")"
    sqlite3 "$AUDIT_DB" <<'SQL'
CREATE TABLE IF NOT EXISTS audit_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp         TEXT    NOT NULL,
    action            TEXT    NOT NULL,
    tier              TEXT    NOT NULL,
    model             TEXT    NOT NULL,
    user              TEXT    NOT NULL DEFAULT 'akkey',
    approval_status   TEXT    NOT NULL,
    approval_step     INTEGER,
    request_body      TEXT,
    response_status   INTEGER,
    result            TEXT    NOT NULL,
    freee_id          TEXT
);
SQL
    chmod 600 "$AUDIT_DB"
}

# log_action <action> <tier> <model> <approval_status> [approval_step] [request_body] [response_status] [result] [freee_id]
log_action() {
    local action="${1:?log_action: action required}"
    local tier="${2:?log_action: tier required}"
    local model="${3:?log_action: model required}"
    local approval_status="${4:-auto}"
    local approval_step="${5:-}"
    local request_body="${6:-}"
    local response_status="${7:-}"
    local result="${8:-success}"
    local freee_id="${9:-}"
    local timestamp
    timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local user="akkey"

    init_db

    # Mask sensitive fields in request_body: strip token/secret keys
    if [ -n "$request_body" ]; then
        request_body="$(echo "$request_body" | \
            sed 's/"access_token"[[:space:]]*:[[:space:]]*"[^"]*"/"access_token":"***"/g' | \
            sed 's/"refresh_token"[[:space:]]*:[[:space:]]*"[^"]*"/"refresh_token":"***"/g' | \
            sed 's/"client_secret"[[:space:]]*:[[:space:]]*"[^"]*"/"client_secret":"***"/g')"
        # Mask account numbers: keep only last 4 digits of sequences >=5 digits
        request_body="$(echo "$request_body" | sed 's/\([0-9]\{5,\}\)/****\(last4:\1\)/g' | \
            sed 's/\*\*\*\*(last4:\([0-9]*\))/****\n/g')"
        # Simpler account masking: replace long digit strings keeping last 4
        request_body="$(echo "$request_body" | \
            perl -pe 's/(?<!\d)(\d{5,})(?!\d)/substr($1, 0, length($1)-4) =~ s|.|\*|gr . substr($1, -4)/ge' 2>/dev/null || \
            echo "$request_body")"
    fi

    # Escape single quotes for SQLite
    local esc_action esc_tier esc_model esc_user esc_approval_status esc_request_body esc_result esc_freee_id
    esc_action="${action//\'/\'\'}"
    esc_tier="${tier//\'/\'\'}"
    esc_model="${model//\'/\'\'}"
    esc_user="${user//\'/\'\'}"
    esc_approval_status="${approval_status//\'/\'\'}"
    esc_request_body="${request_body//\'/\'\'}"
    esc_result="${result//\'/\'\'}"
    esc_freee_id="${freee_id//\'/\'\'}"

    local step_val
    [ -n "$approval_step" ] && step_val="$approval_step" || step_val="NULL"
    local status_val
    [ -n "$response_status" ] && status_val="$response_status" || status_val="NULL"
    local freee_val
    [ -n "$freee_id" ] && freee_val="'$esc_freee_id'" || freee_val="NULL"
    local body_val
    [ -n "$request_body" ] && body_val="'$esc_request_body'" || body_val="NULL"

    sqlite3 "$AUDIT_DB" "
INSERT INTO audit_log
    (timestamp, action, tier, model, user, approval_status, approval_step,
     request_body, response_status, result, freee_id)
VALUES
    ('$timestamp', '$esc_action', '$esc_tier', '$esc_model', '$esc_user',
     '$esc_approval_status', $step_val, $body_val, $status_val, '$esc_result', $freee_val);
"
}

# query_logs [where_clause]
# Example: query_logs "action='create_deal' AND result='success'"
query_logs() {
    local where_clause="${1:-}"
    init_db
    local sql="SELECT * FROM audit_log"
    [ -n "$where_clause" ] && sql="$sql WHERE $where_clause"
    sql="$sql ORDER BY timestamp DESC LIMIT 100;"
    sqlite3 -column -header "$AUDIT_DB" "$sql"
}
