/**
 * SchedulerDb — SQLite persistence layer for agent run queue and history.
 *
 * Replaces the in-memory RunStore and pendingQueues with durable storage
 * that survives scheduler crashes and restarts.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger, type RunResult, type TriggerContext } from "@agents/sdk";

const DB_DIR = join(homedir(), ".agents-scheduler");
const DB_PATH = join(DB_DIR, "scheduler.db");

export interface DbRun {
  id: number;
  agent_name: string;
  status: string;
  trigger_context: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  output: string | null;
  error: string | null;
}

export class SchedulerDb {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? DB_PATH;

    // Ensure directory exists (sync since constructor can't be async)
    const dir = join(path, "..");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // directory likely exists
    }

    this.db = new Database(path);

    // Pragmas for performance and safety
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    // Create schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        trigger_context TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        output TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_agent_status ON runs(agent_name, status);
      CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
    `);

    // Crash recovery: mark any active runs as failed
    const now = new Date().toISOString();
    const crashed = this.db
      .prepare(
        `UPDATE runs SET status = 'failed', error = 'Interrupted by scheduler restart', finished_at = ? WHERE status = 'active'`,
      )
      .run(now);

    if (crashed.changes > 0) {
      logger.warn("Crash recovery: marked interrupted runs as failed", {
        count: crashed.changes,
      });
    }
  }

  /**
   * Enqueue a new run with status 'pending'. Returns the row ID.
   */
  enqueue(agentName: string, triggerContext: TriggerContext): number {
    const result = this.db
      .prepare(
        `INSERT INTO runs (agent_name, status, trigger_context, created_at) VALUES (?, 'pending', ?, ?)`,
      )
      .run(agentName, JSON.stringify(triggerContext), new Date().toISOString());

    return Number(result.lastInsertRowid);
  }

  /**
   * Mark a run as active (started executing).
   */
  markActive(id: number): void {
    this.db
      .prepare(`UPDATE runs SET status = 'active', started_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  /**
   * Mark a run as completed with its result.
   */
  markCompleted(id: number, result: RunResult): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, output = ?, error = ? WHERE id = ?`,
      )
      .run(
        result.status,
        result.finishedAt,
        result.durationMs,
        result.output ?? null,
        result.error ?? null,
        id,
      );
  }

  /**
   * Remove a pending run (used when queue is full and we need to discard).
   */
  removePending(id: number): void {
    this.db.prepare(`DELETE FROM runs WHERE id = ? AND status = 'pending'`).run(id);
  }

  /**
   * Get the oldest pending run for an agent.
   */
  nextPending(agentName: string): { id: number; triggerContext: TriggerContext } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, trigger_context FROM runs WHERE agent_name = ? AND status = 'pending' ORDER BY id ASC LIMIT 1`,
      )
      .get(agentName) as { id: number; trigger_context: string } | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      triggerContext: JSON.parse(row.trigger_context) as TriggerContext,
    };
  }

  /**
   * Count pending runs for an agent.
   */
  pendingCount(agentName: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM runs WHERE agent_name = ? AND status = 'pending'`)
      .get(agentName) as { count: number };

    return row.count;
  }

  /**
   * Count active runs for an agent (used to rebuild activeCounts on startup).
   */
  activeCount(agentName: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM runs WHERE agent_name = ? AND status = 'active'`)
      .get(agentName) as { count: number };

    return row.count;
  }

  /**
   * Get recent completed runs for an agent.
   */
  getHistory(agentName: string, limit = 50): RunResult[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE agent_name = ? AND status NOT IN ('pending', 'active') ORDER BY id DESC LIMIT ?`,
      )
      .all(agentName, limit) as DbRun[];

    return rows.map((row) => this.rowToRunResult(row));
  }

  /**
   * Get the most recent completed run for an agent.
   */
  getLastRun(agentName: string): RunResult | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE agent_name = ? AND status NOT IN ('pending', 'active') ORDER BY id DESC LIMIT 1`,
      )
      .get(agentName) as DbRun | undefined;

    return row ? this.rowToRunResult(row) : undefined;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  private rowToRunResult(row: DbRun): RunResult {
    return {
      agentName: row.agent_name,
      status: row.status as RunResult["status"],
      triggerContext: JSON.parse(row.trigger_context) as TriggerContext,
      startedAt: row.started_at ?? row.created_at,
      finishedAt: row.finished_at ?? row.created_at,
      durationMs: row.duration_ms ?? 0,
      output: row.output ?? undefined,
      error: row.error ?? undefined,
    };
  }
}
