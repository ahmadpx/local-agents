/**
 * File watcher — node:fs.watch with debounce and glob matching.
 */

import { watch, type FSWatcher } from "node:fs";
import { resolve, relative } from "node:path";
import { logger, type AgentConfig, type FileTrigger } from "@agents/sdk";
import type { ExecutionManager } from "./execution-manager.js";

const watchers: FSWatcher[] = [];

/** Simple glob match — supports * and ** patterns. */
function matchesGlob(filePath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regexStr}$`).test(filePath);
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(filePath, p));
}

export function registerFileWatchers(
  config: AgentConfig,
  triggers: FileTrigger[],
  manager: ExecutionManager,
  agentDir: string,
): void {
  for (const trigger of triggers) {
    const debounceMs = trigger.debounceMs ?? 500;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let changedFiles = new Set<string>();

    const watchDir = resolve(agentDir, "..");
    let watcher: FSWatcher;

    try {
      watcher = watch(watchDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;

        const rel = relative(watchDir, resolve(watchDir, filename));

        // Check ignore patterns
        if (trigger.ignore?.length && matchesAny(rel, trigger.ignore)) {
          return;
        }

        // Check if file matches any trigger pattern
        if (!matchesAny(rel, trigger.patterns)) {
          return;
        }

        changedFiles.add(rel);

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const files = Array.from(changedFiles);
          changedFiles = new Set();

          manager
            .run(config.name, {
              triggerType: "file",
              triggeredAt: new Date().toISOString(),
              changedFiles: files,
            })
            .catch((err) =>
              logger.error("File-triggered run failed", {
                agent: config.name,
                error: String(err),
              }),
            );
        }, debounceMs);
      });

      watchers.push(watcher);
      logger.info("Registered file watcher", {
        agent: config.name,
        patterns: trigger.patterns,
      });
    } catch (err) {
      logger.error("Failed to register file watcher", {
        agent: config.name,
        error: String(err),
      });
    }
  }
}

export function stopAllWatchers(): void {
  for (const w of watchers) {
    w.close();
  }
  watchers.length = 0;
}
