/**
 * Pipeline manager — inter-agent trigger chains + cycle detection.
 */

import { logger, type AgentConfig, type AgentTrigger, type RunResult } from "@agents/sdk";
import type { ExecutionManager } from "./execution-manager.js";

interface PipelineEdge {
  source: string;
  target: string;
  trigger: AgentTrigger;
}

export class PipelineManager {
  private edges: PipelineEdge[] = [];
  private manager: ExecutionManager;

  constructor(manager: ExecutionManager) {
    this.manager = manager;
  }

  registerEdges(config: AgentConfig, triggers: AgentTrigger[]): void {
    for (const trigger of triggers) {
      this.edges.push({
        source: trigger.source,
        target: config.name,
        trigger,
      });
      logger.info("Registered pipeline edge", {
        source: trigger.source,
        target: config.name,
      });
    }
  }

  /** Detect cycles in the pipeline graph. Logs errors but does not throw. */
  detectCycles(): string[][] {
    const graph = new Map<string, string[]>();
    for (const edge of this.edges) {
      const targets = graph.get(edge.source) ?? [];
      targets.push(edge.target);
      graph.set(edge.source, targets);
    }

    const cycles: string[][] = [];
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (node: string, path: string[]): void => {
      if (stack.has(node)) {
        const cycleStart = path.indexOf(node);
        const cycle = path.slice(cycleStart).concat(node);
        cycles.push(cycle);
        return;
      }
      if (visited.has(node)) return;

      visited.add(node);
      stack.add(node);

      for (const neighbor of graph.get(node) ?? []) {
        dfs(neighbor, [...path, node]);
      }

      stack.delete(node);
    };

    for (const node of graph.keys()) {
      dfs(node, []);
    }

    for (const cycle of cycles) {
      logger.error("Pipeline cycle detected", {
        cycle: cycle.join(" -> "),
      });
    }

    return cycles;
  }

  /** Listen for run:complete events and fire downstream agents. */
  start(): void {
    this.manager.on("run:complete", (result: RunResult) => {
      const downstream = this.edges.filter(
        (e) => e.source === result.agentName,
      );

      for (const edge of downstream) {
        // Check success/failure filters
        if (edge.trigger.onSuccess && result.status !== "success") continue;
        if (edge.trigger.onFailure && result.status !== "failure") continue;

        logger.info("Firing downstream agent", {
          source: result.agentName,
          target: edge.target,
        });

        this.manager
          .run(edge.target, {
            triggerType: "agent",
            triggeredAt: new Date().toISOString(),
            upstreamResult: edge.trigger.passResult ? result : undefined,
          })
          .catch((err) =>
            logger.error("Pipeline-triggered run failed", {
              source: result.agentName,
              target: edge.target,
              error: String(err),
            }),
          );
      }
    });
  }
}
