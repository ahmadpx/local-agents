/**
 * Cron trigger — wraps node-cron to schedule agent runs.
 */

import cron from "node-cron";
import { logger, type AgentConfig, type CronTrigger } from "@agents/sdk";
import type { ExecutionManager } from "./execution-manager.js";

const tasks: cron.ScheduledTask[] = [];

export function registerCronTriggers(
  config: AgentConfig,
  triggers: CronTrigger[],
  manager: ExecutionManager,
): void {
  for (const trigger of triggers) {
    if (!cron.validate(trigger.schedule)) {
      logger.error("Invalid cron schedule", {
        agent: config.name,
        schedule: trigger.schedule,
      });
      continue;
    }

    const task = cron.schedule(
      trigger.schedule,
      () => {
        if (trigger.skipIfRunning && manager.isRunning(config.name)) {
          logger.info("Skipping cron trigger — agent already running", {
            agent: config.name,
          });
          return;
        }

        manager
          .run(config.name, {
            triggerType: "cron",
            triggeredAt: new Date().toISOString(),
          })
          .catch((err) =>
            logger.error("Cron-triggered run failed", {
              agent: config.name,
              error: String(err),
            }),
          );
      },
      {
        timezone: trigger.timezone,
        scheduled: true,
      },
    );

    tasks.push(task);
    logger.info("Registered cron trigger", {
      agent: config.name,
      schedule: trigger.schedule,
    });
  }
}

export function stopAllCronTasks(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks.length = 0;
}
