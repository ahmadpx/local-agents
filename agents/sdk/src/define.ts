/**
 * defineAgent() — identity function for TypeScript type inference.
 *
 * Use in agent.config.ts files:
 *
 * ```ts
 * import { defineAgent } from "@agents/sdk";
 *
 * export default defineAgent({
 *   name: "my-agent",
 *   description: "Does useful things",
 *   schedule: "0 9 * * *",
 * });
 * ```
 */

import type { AgentConfig } from "./config.js";

export function defineAgent(config: AgentConfig): AgentConfig {
  return config;
}
