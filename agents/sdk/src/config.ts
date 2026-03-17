/**
 * Type definitions for agent configuration and orchestration.
 */

// ---------------------------------------------------------------------------
// Trigger types
// ---------------------------------------------------------------------------

export interface CronTrigger {
  type: "cron";
  schedule: string;
  timezone?: string;
  /** Skip this trigger if the agent is already running. */
  skipIfRunning?: boolean;
}

export interface WebhookTrigger {
  type: "webhook";
  /** Custom path segment — defaults to agent name. */
  path?: string;
  /** HMAC secret for signature verification. */
  secret?: string;
  /** Pass the request body into the trigger context. */
  passBody?: boolean;
}

export interface FileTrigger {
  type: "file";
  /** Glob patterns to watch. */
  patterns: string[];
  /** Debounce delay in milliseconds (default 500). */
  debounceMs?: number;
  /** Glob patterns to ignore. */
  ignore?: string[];
}

export interface AgentTrigger {
  type: "agent";
  /** Name of the upstream agent. */
  source: string;
  /** Only fire on successful completion. */
  onSuccess?: boolean;
  /** Only fire on failure. */
  onFailure?: boolean;
  /** Pass the upstream agent's result into the trigger context. */
  passResult?: boolean;
}

export type GitHubPREvent =
  | "pr:opened"
  | "pr:closed"
  | "pr:merged"
  | "pr:reopened"
  | "pr:synchronize"
  | "pr:reviewed"
  | "pr:labeled"
  | "pr:ready_for_review";

export type GitHubIssueEvent =
  | "issue:opened"
  | "issue:closed"
  | "issue:reopened"
  | "issue:labeled"
  | "issue:assigned"
  | "issue:commented";

export type GitHubEvent = GitHubPREvent | GitHubIssueEvent;

export interface GitHubTrigger {
  type: "github";
  /** GitHub repo in owner/name format (e.g. "owner/repo-name"). */
  repo: string;
  /** GitHub events to subscribe to (PR and/or issue events). */
  events: GitHubEvent[];
  /** Polling interval in ms (default: 60000). Applies globally per repo — shortest wins. */
  pollIntervalMs?: number;
}

export type Trigger = CronTrigger | WebhookTrigger | FileTrigger | AgentTrigger | GitHubTrigger;

// ---------------------------------------------------------------------------
// Trigger context — passed to the prompt builder at runtime
// ---------------------------------------------------------------------------

export interface TriggerContext {
  /** Which trigger caused this execution. */
  triggerType: Trigger["type"] | "manual";
  /** ISO-8601 timestamp of trigger event. */
  triggeredAt: string;
  /** Webhook request body (when passBody is true). */
  webhookBody?: unknown;
  /** Changed file paths (for file triggers). */
  changedFiles?: string[];
  /** Upstream agent result (when passResult is true). */
  upstreamResult?: RunResult;
  /** Arbitrary metadata. */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Execution configuration
// ---------------------------------------------------------------------------

export interface ExecutionConfig {
  /** Permission mode passed to the SDK. */
  permissionMode?: string;
  /** Maximum agentic turns. */
  maxTurns?: number;
  /** Hard timeout in milliseconds. */
  timeoutMs?: number;
  /** Allowed SDK tools. */
  tools?: string[];
  /** Number of retries on failure (default 0). */
  retries?: number;
  /** Model to use (e.g. "claude-sonnet-4-6"). Defaults to SDK default. */
  model?: string;
  /** Working directory for the agent process. Defaults to the agent's package directory. */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export type RunStatus = "success" | "failure" | "timeout" | "aborted";

export interface RunResult {
  agentName: string;
  status: RunStatus;
  triggerContext: TriggerContext;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  output?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Agent config — the shape returned by defineAgent()
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Unique agent name (must match the package directory name). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Whether this agent is enabled. Disabled agents are discovered but not scheduled. Defaults to true. */
  enabled?: boolean;
  /** Cron schedule shorthand (syntactic sugar — creates a CronTrigger). */
  schedule?: string;
  /** Explicit triggers. */
  triggers?: Trigger[];
  /** Execution settings. */
  execution?: ExecutionConfig;
  /** Prompt: a static string or a function that receives trigger context. */
  prompt?: string | ((ctx: TriggerContext) => string);
  /** Max concurrent runs for this agent (default 1). */
  maxConcurrency?: number;
  /** Max queued runs when at maxConcurrency (default 50). Runs beyond this are aborted. */
  maxQueueSize?: number;
}
