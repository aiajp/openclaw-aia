/**
 * Audit Logger for skill-claude-code
 *
 * SQLite-backed audit trail for all operations.
 * Provides in-memory variant for testing.
 */

import Database from "better-sqlite3";

// ── Types ──

export interface AuditLogEntry {
  timestamp: string;
  skill: string;
  action: string;
  target: string;
  result: "success" | "failure" | "error";
  details: Record<string, unknown>;
}

export interface AuditLogger {
  log(entry: Omit<AuditLogEntry, "timestamp">): void;
  query(filters?: { skill?: string; action?: string; limit?: number }): AuditLogEntry[];
  close(): void;
}

// ── Schema ──

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime(now)),
    skill TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    result TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT {}
  )
`;

const CREATE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_audit_skill_action ON audit_log (skill, action)
`;

// ── Implementation ──

function createLogger(db: InstanceType<typeof Database>): AuditLogger {
  db.exec(CREATE_TABLE);
  db.exec(CREATE_INDEX);

  const insertStmt = db.prepare(
    "INSERT INTO audit_log (skill, action, target, result, details) VALUES (?, ?, ?, ?, ?)",
  );

  const queryStmt = db.prepare(
    "SELECT * FROM audit_log WHERE (?1 IS NULL OR skill = ?1) AND (?2 IS NULL OR action = ?2) ORDER BY id DESC LIMIT ?3",
  );

  return {
    log(entry) {
      insertStmt.run(
        entry.skill,
        entry.action,
        entry.target,
        entry.result,
        JSON.stringify(entry.details),
      );
    },
    query(filters) {
      const rows = queryStmt.all(
        filters?.skill ?? null,
        filters?.action ?? null,
        filters?.limit ?? 100,
      ) as Array<{
        timestamp: string;
        skill: string;
        action: string;
        target: string;
        result: string;
        details: string;
      }>;

      return rows.map((row) => ({
        ...row,
        result: row.result as AuditLogEntry["result"],
        details: JSON.parse(row.details),
      }));
    },
    close() {
      db.close();
    },
  };
}

// ── Factory functions ──

export function createAuditLogger(dbPath: string): AuditLogger {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return createLogger(db);
}

export function createInMemoryDatabase(): AuditLogger {
  const db = new Database(":memory:");
  return createLogger(db);
}
