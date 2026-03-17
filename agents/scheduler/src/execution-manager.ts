/**
 * ExecutionManager — concurrency control, persistent run queue, event bus for agent runs.
 *
 * Uses SchedulerDb (SQLite) for durable queue and run history. In-memory pendingQueues
 * and RunStore are replaced — runs survive scheduler crashes and restarts.
 */

import { EventEmitter } from "node:events";
import {
  executeAgent,
  logger,
  type AgentConfig,
  type RunResult,
  type TriggerContext,
} from "@agents/sdk";

import type { SchedulerDb } from "./db.js";

const DEFAULT_MAX_QUEUE_SIZE = 50;

export interface AgentEntry {
  config: AgentConfig;
  dir: string;
}

/**
 * Callbacks for runs that were enqueued while the caller is awaiting the result.
 * Keyed by DB run ID.
 */
interface PendingCallback {
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
}

export class ExecutionManager extends EventEmitter {
  private activeCounts = new Map<string, number>();
  private agents = new Map<string, AgentEntry>();
  private pendingCallbacks = new Map<number, PendingCallback>();

  constructor(private db: SchedulerDb) {
    super();
  }

  register(name: string, entry: AgentEntry): void {
    this.agents.set(name, entry);
    // Rebuild active count from DB (in case of restart with active runs
    // that were just marked failed by crash recovery — this will be 0)
    this.activeCounts.set(name, this.db.activeCount(name));
  }

  getAgent(name: string): AgentEntry | undefined {
    return this.agents.get(name);
  }

  listAgents(): AgentEntry[] {
    return Array.from(this.agents.values());
  }

  isRunning(name: string): boolean {
    return (this.activeCounts.get(name) ?? 0) > 0;
  }

  queueSize(name: string): number {
    return this.db.pendingCount(name);
  }

  getHistory(name: string, limit?: number): RunResult[] {
    return this.db.getHistory(name, limit);
  }

  getLastRun(name: string): RunResult | undefined {
    return this.db.getLastRun(name);
  }

  /**
   * Run an agent if concurrency allows, otherwise queue. Returns the RunResult
   * once the run actually completes (which may be after waiting in the queue).
   */
  async run(name: string, triggerContext: TriggerContext): Promise<RunResult> {
    const entry = this.agents.get(name);
    if (!entry) {
      throw new Error(`Unknown agent: ${name}`);
    }

    // Always enqueue to DB first
    const runId = this.db.enqueue(name, triggerContext);

    const maxConcurrency = entry.config.maxConcurrency ?? 1;
    const active = this.activeCounts.get(name) ?? 0;

    if (active >= maxConcurrency) {
      const maxQueue = entry.config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
      const pendingCount = this.db.pendingCount(name);

      if (pendingCount > maxQueue) {
        // Queue full — remove the just-enqueued row and return aborted
        this.db.removePending(runId);
        logger.warn("Agent queue full, aborting", {
          agent: name,
          active,
          pendingCount,
          maxQueueSize: maxQueue,
        });
        return {
          agentName: name,
          status: "aborted",
          triggerContext,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          error: "Run queue full",
        };
      }

      // Wait in queue — the drainQueue() method will pick it up
      return new Promise<RunResult>((resolve, reject) => {
        this.pendingCallbacks.set(runId, { resolve, reject });
        logger.info("Agent run queued", {
          agent: name,
          runId,
          pendingCount,
          trigger: triggerContext.triggerType,
        });
      });
    }

    // Capacity available — execute immediately
    return this.executeRun(name, entry, triggerContext, runId);
  }

  private async executeRun(
    name: string,
    entry: AgentEntry,
    triggerContext: TriggerContext,
    runId: number,
  ): Promise<RunResult> {
    const active = this.activeCounts.get(name) ?? 0;
    this.activeCounts.set(name, active + 1);
    this.db.markActive(runId);
    this.emit("run:start", { agent: name, triggerContext });
    logger.info("Agent run started", {
      agent: name,
      runId,
      trigger: triggerContext.triggerType,
    });

    let result: RunResult;
    try {
      result = await executeAgent({
        config: entry.config,
        agentDir: entry.dir,
        triggerContext,
      });
    } catch (err) {
      result = {
        agentName: name,
        status: "failure",
        triggerContext,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      const current = this.activeCounts.get(name) ?? 1;
      this.activeCounts.set(name, Math.max(0, current - 1));
      this.drainQueue(name);
    }

    this.db.markCompleted(runId, result);
    this.emit("run:complete", result);
    logger.info("Agent run completed", {
      agent: name,
      runId,
      status: result.status,
      durationMs: result.durationMs,
    });

    return result;
  }

  private drainQueue(name: string): void {
    const entry = this.agents.get(name);
    if (!entry) return;

    const maxConcurrency = entry.config.maxConcurrency ?? 1;
    const active = this.activeCounts.get(name) ?? 0;
    if (active >= maxConcurrency) return;

    const next = this.db.nextPending(name);
    if (!next) return;

    logger.info("Draining queued run", {
      agent: name,
      runId: next.id,
      trigger: next.triggerContext.triggerType,
    });

    const callback = this.pendingCallbacks.get(next.id);
    if (callback) {
      this.pendingCallbacks.delete(next.id);
      this.executeRun(name, entry, next.triggerContext, next.id)
        .then(callback.resolve)
        .catch(callback.reject);
    } else {
      // No caller waiting — run was enqueued before a restart, execute directly
      this.executeRun(name, entry, next.triggerContext, next.id).catch((err) =>
        logger.error("Drain queue execution failed", {
          agent: name,
          runId: next.id,
          error: String(err),
        }),
      );
    }
  }
}
