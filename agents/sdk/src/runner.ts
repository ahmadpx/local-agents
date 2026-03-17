/**
 * executeAgent() — loads AGENTS.md, builds the prompt with trigger context,
 * calls the Claude Agent SDK query(), handles timeout/retry/abort.
 */

import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { query, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import type { AgentConfig, RunResult, RunStatus, TriggerContext } from "./config.js";
import { logger } from "./logger.js";

/**
 * Load agent-specific .env file into process.env (without overwriting existing vars).
 * Returns keys that were added so they can be cleaned up after the run.
 */
async function loadAgentEnv(agentDir: string): Promise<string[]> {
  const envPath = join(agentDir, ".env");
  if (!existsSync(envPath)) return [];

  const added: string[] = [];
  try {
    const content = await readFile(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
        added.push(key);
      }
    }
    if (added.length > 0) {
      logger.info("Loaded agent .env", { agentDir, keys: added });
    }
  } catch (err) {
    logger.warn("Failed to load agent .env", { agentDir, error: String(err) });
  }
  return added;
}

function logTs(): string {
  return new Date().toISOString();
}

function logLine(stream: WriteStream, msg: string): void {
  stream.write(`[${logTs()}] ${msg}\n`);
}

async function openRunLog(
  agentDir: string,
  agentName: string,
  triggerType: string,
): Promise<WriteStream> {
  const logsDir = join(agentDir, "logs");
  await mkdir(logsDir, { recursive: true });
  const ts = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "");
  const filename = `${ts}_${triggerType}.log`;
  return createWriteStream(join(logsDir, filename));
}

function formatMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    return JSON.stringify(message, null, 2);
  }
  return String(message);
}

/** Resolve the prompt string for a given trigger context. */
function resolvePrompt(config: AgentConfig, ctx: TriggerContext): string {
  if (typeof config.prompt === "function") return config.prompt(ctx);
  if (typeof config.prompt === "string") return config.prompt;
  return `You are the "${config.name}" agent. ${config.description}`;
}

/** Load the agent's AGENTS.md as a system prompt. */
async function loadSystemPrompt(agentDir: string): Promise<string> {
  const agentsPath = join(agentDir, "AGENTS.md");
  try {
    return await readFile(agentsPath, "utf-8");
  } catch {
    logger.warn("No AGENTS.md found, using empty system prompt", {
      agent: agentDir,
    });
    return "";
  }
}

export interface ExecuteAgentOptions {
  config: AgentConfig;
  /** Absolute path to the agent's package directory. */
  agentDir: string;
  triggerContext: TriggerContext;
  /** AbortSignal for external cancellation. */
  signal?: AbortSignal;
}

/**
 * Execute an agent by calling the Claude Agent SDK query loop.
 *
 * Returns a RunResult summarizing the execution.
 */
export async function executeAgent(
  opts: ExecuteAgentOptions,
): Promise<RunResult> {
  const { config, agentDir, triggerContext, signal } = opts;
  const startedAt = new Date().toISOString();
  const start = Date.now();

  const addedEnvKeys = await loadAgentEnv(agentDir);

  try {
    return await executeAgentCore(config, agentDir, triggerContext, startedAt, start, signal);
  } finally {
    for (const key of addedEnvKeys) {
      delete process.env[key];
    }
  }
}

async function executeAgentCore(
  config: AgentConfig,
  agentDir: string,
  triggerContext: TriggerContext,
  startedAt: string,
  start: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  const log = await openRunLog(
    agentDir,
    config.name,
    triggerContext.triggerType,
  );

  log.write(`${"=".repeat(72)}\n`);
  logLine(log, `Agent: ${config.name}`);
  logLine(log, `Trigger: ${triggerContext.triggerType}`);
  logLine(log, `Model: ${config.execution?.model ?? "(default)"}`);
  logLine(log, `CWD: ${config.execution?.cwd ?? agentDir}`);
  logLine(log, `Max turns: ${config.execution?.maxTurns ?? 10}`);
  logLine(log, `Timeout: ${config.execution?.timeoutMs ?? 300_000}ms`);
  log.write(`${"=".repeat(72)}\n\n`);

  // Unset CLAUDECODE so the Claude Code subprocess doesn't refuse to run nested
  const savedClaudeCode = process.env.CLAUDECODE;
  delete process.env.CLAUDECODE;
  const restoreClaudeCode = () => {
    if (savedClaudeCode !== undefined) process.env.CLAUDECODE = savedClaudeCode;
  };

  const retries = config.execution?.retries ?? 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      logLine(log, "Run aborted by signal");
      log.end();
      restoreClaudeCode();
      return buildResult(config, triggerContext, startedAt, start, "aborted");
    }

    if (attempt > 0) {
      logLine(log, `--- Retry attempt ${attempt} ---`);
    }

    try {
      const systemPrompt = await loadSystemPrompt(agentDir);
      const prompt = resolvePrompt(config, triggerContext);
      const fullPrompt = buildFullPrompt(prompt, triggerContext);

      logLine(log, "Prompt sent to agent:");
      log.write(fullPrompt + "\n\n");

      const timeoutMs = config.execution?.timeoutMs ?? 300_000;
      const cwd = config.execution?.cwd ?? agentDir;
      let output = "";

      const queryOptions: Record<string, unknown> = {
        systemPrompt: systemPrompt || undefined,
        allowedTools: config.execution?.tools ?? [
          "Read",
          "Edit",
          "Bash",
          "Glob",
          "Grep",
        ],
        permissionMode: (config.execution?.permissionMode ?? "acceptEdits") as PermissionMode,
        maxTurns: config.execution?.maxTurns ?? 10,
        cwd,
      };
      if (config.execution?.model) {
        queryOptions.model = config.execution.model;
      }

      const result = await Promise.race([
        (async () => {
          for await (const message of query({
            prompt: fullPrompt,
            options: queryOptions as Parameters<typeof query>[0]["options"],
          })) {
            if (signal?.aborted) break;

            logLine(log, "--- message ---");
            log.write(formatMessage(message) + "\n");

            if (typeof message === "string") {
              output += message;
            } else if (message && typeof message === "object" && "content" in message) {
              output += String((message as { content: unknown }).content);
            }
          }
          return { status: "success" as const, output };
        })(),
        timeoutPromise(timeoutMs),
      ]);

      if (result.status === "timeout") {
        logLine(log, `Run timed out after ${timeoutMs}ms`);
        log.end();
        restoreClaudeCode();
        return buildResult(
          config,
          triggerContext,
          startedAt,
          start,
          "timeout",
          undefined,
          "Execution timed out",
        );
      }

      const finalResult = buildResult(
        config,
        triggerContext,
        startedAt,
        start,
        "success",
        result.output,
      );
      log.write(`\n${"=".repeat(72)}\n`);
      logLine(log, `Run finished — status: ${finalResult.status}, duration: ${finalResult.durationMs}ms`);
      log.end();
      restoreClaudeCode();
      return finalResult;
    } catch (err) {
      lastError = err;
      logLine(log, `Error: ${String(err)}`);
      if (attempt < retries) {
        logger.warn("Agent execution failed, retrying", {
          agent: config.name,
          attempt: attempt + 1,
          error: String(err),
        });
      }
    }
  }

  const failResult = buildResult(
    config,
    triggerContext,
    startedAt,
    start,
    "failure",
    undefined,
    lastError instanceof Error ? lastError.message : String(lastError),
  );
  log.write(`\n${"=".repeat(72)}\n`);
  logLine(log, `Run finished — status: ${failResult.status}, error: ${failResult.error}`);
  log.end();
  restoreClaudeCode();
  return failResult;
}

function buildFullPrompt(prompt: string, ctx: TriggerContext): string {
  const parts = [prompt];

  if (ctx.triggerType === "webhook" && ctx.webhookBody) {
    parts.push(
      `\n\nWebhook payload:\n\`\`\`json\n${JSON.stringify(ctx.webhookBody, null, 2)}\n\`\`\``,
    );
  }
  if (ctx.triggerType === "file" && ctx.changedFiles?.length) {
    parts.push(`\n\nChanged files:\n${ctx.changedFiles.join("\n")}`);
  }
  if (ctx.triggerType === "agent" && ctx.upstreamResult) {
    parts.push(
      `\n\nUpstream agent "${ctx.upstreamResult.agentName}" result:\nStatus: ${ctx.upstreamResult.status}\nOutput: ${ctx.upstreamResult.output ?? "(none)"}`,
    );
  }
  if (ctx.meta && Object.keys(ctx.meta).length > 0) {
    parts.push(
      `\n\nTrigger metadata:\n\`\`\`json\n${JSON.stringify(ctx.meta, null, 2)}\n\`\`\``,
    );
  }

  return parts.join("");
}

function buildResult(
  config: AgentConfig,
  triggerContext: TriggerContext,
  startedAt: string,
  startMs: number,
  status: RunStatus,
  output?: string,
  error?: string,
): RunResult {
  const finishedAt = new Date().toISOString();
  return {
    agentName: config.name,
    status,
    triggerContext,
    startedAt,
    finishedAt,
    durationMs: Date.now() - startMs,
    output,
    error,
  };
}

function timeoutPromise(
  ms: number,
): Promise<{ status: "timeout"; output?: undefined }> {
  return new Promise((resolve) =>
    setTimeout(() => resolve({ status: "timeout" }), ms),
  );
}
