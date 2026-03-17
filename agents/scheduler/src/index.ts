/**
 * @agents/scheduler — boots the scheduler: discovery → register triggers → run.
 */

import { resolve } from "node:path";
import {
  logger,
  type AgentTrigger,
  type CronTrigger,
  type FileTrigger,
  type GitHubTrigger,
  type WebhookTrigger,
} from "@agents/sdk";

import { discoverAgents } from "./discovery.js";
import { ExecutionManager } from "./execution-manager.js";
import { SchedulerDb } from "./db.js";
import { registerCronTriggers, stopAllCronTasks } from "./cron.js";
import {
  createWebhookServer,
  type WebhookRoute,
} from "./webhook.js";
import { registerFileWatchers, stopAllWatchers } from "./watcher.js";
import { PipelineManager } from "./pipeline.js";
import {
  registerGitHubPollers,
  stopGitHubPollers,
  type GitHubPollerRoute,
} from "./github-poller.js";
import { startNotifier } from "./notifier.js";

export interface SchedulerOptions {
  /** Root directory containing agent packages (default: resolved agents/ relative to cwd). */
  agentsRoot?: string;
  /** Webhook server port (default: 3847). */
  port?: number;
}

export async function startScheduler(opts: SchedulerOptions = {}) {
  const agentsRoot = opts.agentsRoot ?? resolve(process.cwd(), "agents");
  const port = opts.port ?? Number(process.env.SCHEDULER_PORT ?? 3847);

  logger.info("Starting agent scheduler", { agentsRoot, port });

  // 1. Discover agents (filter out disabled ones)
  const allAgents = await discoverAgents(agentsRoot);
  const discovered = allAgents.filter((a) => a.config.enabled !== false);
  const disabledCount = allAgents.length - discovered.length;

  if (discovered.length === 0) {
    logger.warn("No agents discovered");
  }
  if (disabledCount > 0) {
    logger.info("Disabled agents skipped", {
      count: disabledCount,
      agents: allAgents
        .filter((a) => a.config.enabled === false)
        .map((a) => a.config.name),
    });
  }

  // 2. Register agents with execution manager
  const db = new SchedulerDb();
  const manager = new ExecutionManager(db);
  for (const agent of discovered) {
    manager.register(agent.config.name, {
      config: agent.config,
      dir: agent.dir,
    });
  }

  // 3. Start failure/stale-run notifier (Slack alerts)
  const stopNotifier = startNotifier(manager);

  // 4. Set up triggers
  const webhookRoutes: WebhookRoute[] = [];
  const githubRoutes: GitHubPollerRoute[] = [];
  const pipeline = new PipelineManager(manager);

  for (const agent of discovered) {
    const triggers = agent.config.triggers ?? [];

    // Cron triggers
    const cronTriggers = triggers.filter(
      (t): t is CronTrigger => t.type === "cron",
    );
    if (cronTriggers.length > 0) {
      registerCronTriggers(agent.config, cronTriggers, manager);
    }

    // Webhook triggers
    const webhookTriggers = triggers.filter(
      (t): t is WebhookTrigger => t.type === "webhook",
    );
    for (const wt of webhookTriggers) {
      webhookRoutes.push({
        agentName: agent.config.name,
        path: wt.path ?? agent.config.name,
        trigger: wt,
      });
    }

    // File triggers
    const fileTriggers = triggers.filter(
      (t): t is FileTrigger => t.type === "file",
    );
    if (fileTriggers.length > 0) {
      registerFileWatchers(agent.config, fileTriggers, manager, agent.dir);
    }

    // Agent triggers (pipeline)
    const agentTriggers = triggers.filter(
      (t): t is AgentTrigger => t.type === "agent",
    );
    if (agentTriggers.length > 0) {
      pipeline.registerEdges(agent.config, agentTriggers);
    }

    // GitHub triggers
    const githubTriggers = triggers.filter(
      (t): t is GitHubTrigger => t.type === "github",
    );
    for (const gt of githubTriggers) {
      githubRoutes.push({
        agentName: agent.config.name,
        trigger: gt,
      });
    }
  }

  // 4. Detect pipeline cycles (advisory)
  pipeline.detectCycles();
  pipeline.start();

  // 5. Start GitHub pollers
  if (githubRoutes.length > 0) {
    registerGitHubPollers(githubRoutes, manager);
  }

  // 6. Start webhook server
  const server = createWebhookServer(manager, webhookRoutes, port);

  // 7. Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down scheduler");
    stopNotifier();
    stopAllCronTasks();
    stopAllWatchers();
    stopGitHubPollers();
    server.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("Scheduler started", {
    agents: discovered.map((a) => a.config.name),
    webhookRoutes: webhookRoutes.map((r) => `/trigger/${r.path}`),
  });

  return { manager, server };
}

export { ExecutionManager } from "./execution-manager.js";
export { discoverAgents } from "./discovery.js";
export { PipelineManager } from "./pipeline.js";
export { SchedulerDb } from "./db.js";
export { startNotifier } from "./notifier.js";
