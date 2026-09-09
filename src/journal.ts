import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import path from "node:path"
import { defaultAuthPath } from "./auth"
import type { ConsumeOutcome, ResetAttempt } from "./types"

export class RecoveryError extends Error {
  constructor() {
    super(
      "Reset recovery storage is unavailable or invalid. Run codex-doctor; no new reset can be sent until storage is repaired. Do not delete pending recovery data.",
    )
    this.name = "RecoveryError"
  }
}

export class PendingResetError extends Error {
  constructor(readonly attempt: ResetAttempt) {
    super("An earlier reset has an unknown outcome. Reopen the reset picker or retry the saved retryId.")
    this.name = "PendingResetError"
  }
}

export type SavedAttempt = ResetAttempt & { outcome?: ConsumeOutcome; createdAt: number }
type Row = { account: string; id: string; credit: string | null; outcome: ConsumeOutcome | null; created: number }
const outcomes = new Set(["reset", "already_redeemed", "no_credit", "nothing_to_reset"])

export function defaultJournalPath() {
  return path.join(path.dirname(defaultAuthPath()), "codex-usage", "resets.sqlite")
}

function saved(row: Row): SavedAttempt {
  if (!row.account || !row.id || !Number.isFinite(row.created) || (row.outcome !== null && !outcomes.has(row.outcome)))
    throw new RecoveryError()
  return {
    accountKey: row.account,
    idempotencyKey: row.id,
    ...(row.credit ? { creditId: row.credit } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    createdAt: row.created,
  }
}

/** SQLite transactions arbitrate between independent TUI/server processes. No credentials or response bodies are stored. */
export class ResetJournal {
  private db?: Database
  constructor(readonly filename = defaultJournalPath()) {}

  private use<T>(run: (db: Database) => T): T {
    try {
      if (!this.db) {
        if (this.filename !== ":memory:") mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 })
        const db = new Database(this.filename, { create: true, strict: true })
        try {
          db.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
          db.transaction(() => {
            const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
            if (version !== 0 && version !== 1) throw new RecoveryError()
            if (version === 1) {
              const index = db
                .query("SELECT name FROM sqlite_master WHERE type='index' AND name='one_pending_per_account'")
                .get()
              if (!index) throw new RecoveryError()
              db.query("SELECT id,account,credit,created,outcome FROM attempts LIMIT 1").get()
              return
            }
            if (db.query("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()) throw new RecoveryError()
            db.exec(`CREATE TABLE attempts (
            id TEXT PRIMARY KEY, account TEXT NOT NULL, credit TEXT, created INTEGER NOT NULL,
            outcome TEXT CHECK(outcome IS NULL OR outcome IN ('reset','already_redeemed','no_credit','nothing_to_reset'))
          );
          CREATE UNIQUE INDEX one_pending_per_account ON attempts(account) WHERE outcome IS NULL;
          PRAGMA user_version=1;`)
          }).immediate()
          if (this.filename !== ":memory:" && process.platform !== "win32") chmodSync(this.filename, 0o600)
          this.db = db
        } catch (error) {
          db.close()
          throw error
        }
      }
      return run(this.db)
    } catch (error) {
      if (error instanceof PendingResetError || error instanceof RecoveryError) throw error
      throw new RecoveryError()
    }
  }

  get(id: string): SavedAttempt | undefined {
    return this.use((db) => {
      const row = db.query<Row, [string]>("SELECT * FROM attempts WHERE id=?").get(id)
      return row ? saved(row) : undefined
    })
  }

  pending(accountKey: string): SavedAttempt | undefined {
    return this.use((db) => {
      const row = db.query<Row, [string]>("SELECT * FROM attempts WHERE account=? AND outcome IS NULL").get(accountKey)
      return row ? saved(row) : undefined
    })
  }

  begin(attempt: ResetAttempt): SavedAttempt {
    return this.use((db) =>
      db
        .transaction(() => {
          const existing = this.get(attempt.idempotencyKey)
          if (existing) {
            if (existing.accountKey !== attempt.accountKey || existing.creditId !== attempt.creditId)
              throw new RecoveryError()
            return existing
          }
          const pending = this.pending(attempt.accountKey)
          if (pending) throw new PendingResetError(pending)
          db.query("INSERT INTO attempts (id,account,credit,created) VALUES (?,?,?,?)").run(
            attempt.idempotencyKey,
            attempt.accountKey,
            attempt.creditId ?? null,
            Date.now(),
          )
          return this.get(attempt.idempotencyKey)!
        })
        .immediate(),
    )
  }

  complete(attempt: ResetAttempt, outcome: ConsumeOutcome) {
    this.use((db) =>
      db
        .transaction(() => {
          const existing = this.get(attempt.idempotencyKey)
          if (!existing || existing.accountKey !== attempt.accountKey || existing.creditId !== attempt.creditId)
            throw new RecoveryError()
          // Keep the first known outcome if two safe, same-key retries finish together.
          db.query("UPDATE attempts SET outcome=COALESCE(outcome,?) WHERE id=?").run(outcome, attempt.idempotencyKey)
        })
        .immediate(),
    )
  }

  health(accountKey?: string) {
    return this.use((db) => {
      const rows = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all()
      if (rows.some((row) => row.quick_check !== "ok")) throw new RecoveryError()
      return accountKey ? this.pending(accountKey) : undefined
    })
  }

  close() {
    this.db?.close()
    this.db = undefined
  }
}
