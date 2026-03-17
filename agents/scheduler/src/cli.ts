#!/usr/bin/env node

/**
 * CLI for the agent scheduler.
 *
 * Commands:
 *   list              — show discovered agents and their triggers
 *   run <agent-name>  — manually trigger an agent
 *   start             — boot the scheduler daemon
 */

try {
  process.loadEnvFile();
} catch {
  // .env file is optional
}

import { resolve } from "node:path";
import { logger, type Trigger } from "@agents/sdk";
import { discoverAgents } from "./discovery.js";
import { ExecutionManager } from "./execution-manager.js";
import { SchedulerDb } from "./db.js";
import { startScheduler } from "./index.js";

const args = process.argv.slice(2);
const command = args[0];

function agentsRoot(): string {
  return resolve(process.cwd(), "agents");
}

function formatTrigger(t: Trigger): string {
  switch (t.type) {
    case "cron":
      return `cron(${t.schedule})`;
    case "webhook":
      return `webhook(${t.path ?? "default"})`;
    case "file":
      return `file(${t.patterns.join(", ")})`;
    case "agent":
      return `agent(${t.source})`;
    case "github":
      return `github(${t.repo} → ${t.events.join(", ")})`;
  }
}

async function listCommand() {
  const discovered = await discoverAgents(agentsRoot());
  if (discovered.length === 0) {
    console.log("No agents discovered.");
    return;
  }

  console.log(`\nDiscovered ${discovered.length} agent(s):\n`);
  for (const agent of discovered) {
    const disabled = agent.config.enabled === false;
    const triggers = agent.config.triggers ?? [];
    const triggerStr =
      triggers.length > 0
        ? triggers.map(formatTrigger).join(", ")
        : "manual only";
    console.log(`  ${agent.config.name}${disabled ? " (disabled)" : ""}`);
    console.log(`    ${agent.config.description}`);
    console.log(`    Triggers: ${triggerStr}`);
    console.log(`    Dir: ${agent.dir}`);
    console.log();
  }
}

async function runCommand(agentName: string) {
  if (!agentName) {
    console.error("Usage: agent-scheduler run <agent-name>");
    process.exit(1);
  }

  const discovered = await discoverAgents(agentsRoot());
  const agent = discovered.find((a) => a.config.name === agentName);

  if (!agent) {
    console.error(`Agent "${agentName}" not found.`);
    console.error(
      "Available agents:",
      discovered.map((a) => a.config.name).join(", ") || "(none)",
    );
    process.exit(1);
  }

  const db = new SchedulerDb();
  const manager = new ExecutionManager(db);
  manager.register(agent.config.name, {
    config: agent.config,
    dir: agent.dir,
  });

  console.log(`Running agent "${agentName}"...`);
  const result = await manager.run(agentName, {
    triggerType: "manual",
    triggeredAt: new Date().toISOString(),
  });

  console.log(`\nResult:`);
  console.log(`  Status: ${result.status}`);
  console.log(`  Duration: ${result.durationMs}ms`);
  if (result.output) {
    console.log(`  Output: ${result.output}`);
  }
  if (result.error) {
    console.error(`  Error: ${result.error}`);
  }

  db.close();
}

async function startCommand() {
  await startScheduler({
    agentsRoot: agentsRoot(),
  });
  // startScheduler keeps the process alive via the HTTP server
}

async function main() {
  switch (command) {
    case "list":
      await listCommand();
      break;
    case "run":
      await runCommand(args[1]!);
      break;
    case "start":
      await startCommand();
      break;
    default:
      console.log("Usage: agent-scheduler <command>");
      console.log();
      console.log("Commands:");
      console.log("  list              Show discovered agents and triggers");
      console.log("  run <agent-name>  Manually trigger an agent");
      console.log("  start             Start the scheduler daemon");
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  logger.error("CLI error", { error: String(err) });
  process.exit(1);
});
