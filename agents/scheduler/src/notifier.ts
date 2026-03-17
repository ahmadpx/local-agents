/**
 * Notifier — sends Slack alerts when agent runs fail, timeout, or abort.
 * Also monitors for stale (stuck) runs that exceed their expected duration.
 */

import { logger, type RunResult, type RunStatus } from "@agents/sdk";
import type { ExecutionManager, AgentEntry } from "./execution-manager.js";

const ALERT_STATUSES = new Set<RunStatus>(["failure", "timeout", "aborted"]);

const STATUS_EMOJI: Record<RunStatus, string> = {
  failure: ":red_circle:",
  timeout: ":alarm_clock:",
  aborted: ":no_entry_sign:",
  success: ":white_check_mark:",
};

const STATUS_LABEL: Record<RunStatus, string> = {
  failure: "Failed",
  timeout: "Timed Out",
  aborted: "Aborted",
  success: "Succeeded",
};

interface ActiveRun {
  agentName: string;
  startedAt: number;
  timeoutMs: number;
  triggerType: string;
  alerted: boolean;
}

interface NotifierState {
  activeRuns: Map<string, ActiveRun>;
  staleCheckInterval: ReturnType<typeof setInterval> | null;
}

const STALE_CHECK_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_RATIO = 0.9;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

function buildFailureBlocks(result: RunResult): unknown[] {
  const emoji = STATUS_EMOJI[result.status];
  const label = STATUS_LABEL[result.status];

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${emoji} Agent ${label}: ${result.agentName}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Status:*\n${label}` },
        { type: "mrkdwn", text: `*Trigger:*\n${result.triggerContext.triggerType}` },
        { type: "mrkdwn", text: `*Duration:*\n${formatDuration(result.durationMs)}` },
        { type: "mrkdwn", text: `*Time:*\n${result.finishedAt}` },
      ],
    },
  ];

  if (result.error) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Error:*\n\`\`\`${truncate(result.error, 2500)}\`\`\``,
      },
    });
  }

  blocks.push({ type: "divider" });

  return blocks;
}

function buildStaleRunBlocks(run: ActiveRun): unknown[] {
  const elapsed = Date.now() - run.startedAt;
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `:warning: Agent Possibly Stuck: ${run.agentName}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Running for:*\n${formatDuration(elapsed)}` },
        { type: "mrkdwn", text: `*Timeout:*\n${formatDuration(run.timeoutMs)}` },
        { type: "mrkdwn", text: `*Trigger:*\n${run.triggerType}` },
        {
          type: "mrkdwn",
          text: `*Status:*\nApproaching timeout (${Math.round((elapsed / run.timeoutMs) * 100)}% elapsed)`,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "The agent will be automatically timed out if it doesn't complete soon.",
        },
      ],
    },
    { type: "divider" },
  ];
}

async function sendSlackAlert(text: string, blocks: unknown[]): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.warn("SLACK_WEBHOOK_URL not set — skipping Slack alert", { text });
    return;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, blocks }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error("Slack alert failed", { status: res.status, body });
    }
  } catch (err) {
    logger.error("Failed to send Slack alert", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function generateRunKey(agentName: string): string {
  return `${agentName}:${Date.now()}`;
}

function getTimeoutMs(entry: AgentEntry): number {
  return entry.config.execution?.timeoutMs ?? 300_000;
}

export function startNotifier(manager: ExecutionManager): () => void {
  const state: NotifierState = {
    activeRuns: new Map(),
    staleCheckInterval: null,
  };

  manager.on("run:start", (event: { agent: string; triggerContext: { triggerType: string } }) => {
    const entry = manager.getAgent(event.agent);
    const timeoutMs = entry ? getTimeoutMs(entry) : 300_000;
    const key = generateRunKey(event.agent);

    state.activeRuns.set(key, {
      agentName: event.agent,
      startedAt: Date.now(),
      timeoutMs,
      triggerType: event.triggerContext.triggerType,
      alerted: false,
    });
  });

  manager.on("run:complete", (result: RunResult) => {
    for (const [key, run] of state.activeRuns) {
      if (run.agentName === result.agentName) {
        state.activeRuns.delete(key);
        break;
      }
    }

    if (!ALERT_STATUSES.has(result.status)) return;

    const label = STATUS_LABEL[result.status];
    const fallbackText = `Agent ${label}: ${result.agentName} — ${result.error ?? "no error details"}`;
    const blocks = buildFailureBlocks(result);

    sendSlackAlert(fallbackText, blocks).catch(() => {
      // already logged inside sendSlackAlert
    });
  });

  state.staleCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [, run] of state.activeRuns) {
      if (run.alerted) continue;

      const elapsed = now - run.startedAt;
      const threshold = run.timeoutMs * STALE_THRESHOLD_RATIO;

      if (elapsed >= threshold) {
        run.alerted = true;
        const fallbackText = `Agent possibly stuck: ${run.agentName} (running for ${formatDuration(elapsed)}, timeout at ${formatDuration(run.timeoutMs)})`;
        const blocks = buildStaleRunBlocks(run);
        sendSlackAlert(fallbackText, blocks).catch(() => {});
      }
    }
  }, STALE_CHECK_INTERVAL_MS);

  logger.info("Notifier started — Slack alerts enabled for failed/timed-out/aborted runs");

  return () => {
    if (state.staleCheckInterval) {
      clearInterval(state.staleCheckInterval);
      state.staleCheckInterval = null;
    }
    state.activeRuns.clear();
  };
}
