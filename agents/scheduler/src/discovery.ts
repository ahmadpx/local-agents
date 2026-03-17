/**
 * Agent discovery — scans each agent directory for agent.config.ts,
 * dynamically imports, validates, and normalizes configs.
 */

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { logger, type AgentConfig, type Trigger } from "@agents/sdk";

export interface DiscoveredAgent {
  config: AgentConfig;
  dir: string;
}

/**
 * Scan the agents directory for agent.config.ts files and import them.
 * Expects configs to have been compiled to agent.config.js in dist/.
 */
export async function discoverAgents(
  agentsRoot: string,
): Promise<DiscoveredAgent[]> {
  const discovered: DiscoveredAgent[] = [];
  const root = resolve(agentsRoot);

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    logger.error("Cannot read agents directory", { path: root });
    return [];
  }

  for (const entry of entries) {
    const agentDir = join(root, entry);

    // Skip non-directories and infrastructure packages
    const s = await stat(agentDir).catch(() => null);
    if (!s?.isDirectory()) continue;
    if (entry === "sdk" || entry === "scheduler") continue;

    // Try compiled config first, then source
    const candidates = [
      join(agentDir, "dist", "agent.config.js"),
      join(agentDir, "agent.config.js"),
    ];

    let config: AgentConfig | null = null;
    for (const candidate of candidates) {
      const exists = await stat(candidate).catch(() => null);
      if (!exists) continue;

      try {
        const fileUrl = pathToFileURL(candidate).href;
        const mod = await import(fileUrl);
        config = mod.default ?? mod;
        break;
      } catch (err) {
        logger.warn("Failed to import agent config", {
          path: candidate,
          error: String(err),
        });
      }
    }

    if (!config) {
      logger.debug("No agent.config found, skipping", { dir: entry });
      continue;
    }

    // Validate required fields
    if (!config.name || !config.description) {
      logger.warn("Agent config missing name or description, skipping", {
        dir: entry,
      });
      continue;
    }

    // Normalize: expand schedule shorthand into a CronTrigger
    const triggers: Trigger[] = [...(config.triggers ?? [])];
    if (config.schedule) {
      const hasCron = triggers.some((t) => t.type === "cron");
      if (!hasCron) {
        triggers.push({ type: "cron", schedule: config.schedule });
      }
    }
    config = { ...config, triggers };

    discovered.push({ config, dir: agentDir });
    logger.info("Discovered agent", {
      name: config.name,
      triggers: triggers.length,
    });
  }

  return discovered;
}
