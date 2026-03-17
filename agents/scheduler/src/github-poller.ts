/**
 * GitHub PR poller — polls repos via `gh` CLI, detects PR state transitions,
 * and dispatches events to subscribing agents.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger, type AgentConfig, type GitHubEvent, type GitHubIssueEvent, type GitHubPREvent, type GitHubTrigger } from "@agents/sdk";
import type { ExecutionManager } from "./execution-manager.js";

// ---------------------------------------------------------------------------
// Types for the gh CLI JSON output
// ---------------------------------------------------------------------------

interface GhLabel {
  name: string;
}

interface GhAuthor {
  login: string;
}

interface GhReview {
  state: string;
  author: GhAuthor;
}

interface GhPR {
  number: number;
  state: string;
  title: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isDraft: boolean;
  mergedAt: string | null;
  updatedAt: string;
  url: string;
  author: GhAuthor;
  labels: GhLabel[];
  reviews: GhReview[];
}

// ---------------------------------------------------------------------------
// Types for the gh CLI JSON output (issues)
// ---------------------------------------------------------------------------

interface GhIssueLabel {
  name: string;
}

interface GhIssueAuthor {
  login: string;
}

interface GhIssueAssignee {
  login: string;
}

interface GhIssue {
  number: number;
  state: string;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  author: GhIssueAuthor;
  labels: GhIssueLabel[];
  assignees: GhIssueAssignee[];
  comments: { totalCount: number }[];
}

// ---------------------------------------------------------------------------
// Persisted state per PR
// ---------------------------------------------------------------------------

interface StoredPR {
  state: string;
  headRefOid: string;
  isDraft: boolean;
  merged: boolean;
  labels: string[];
  reviewCount: number;
}

// ---------------------------------------------------------------------------
// Persisted state per issue
// ---------------------------------------------------------------------------

interface StoredIssue {
  state: string;
  labels: string[];
  assignees: string[];
  commentCount: number;
}

interface RepoState {
  lastPoll: string;
  prs: Record<string, StoredPR>;
  issues?: Record<string, StoredIssue>;
}

type PollerState = Record<string, RepoState>;

// ---------------------------------------------------------------------------
// Registration structures
// ---------------------------------------------------------------------------

interface RepoSubscription {
  agentName: string;
  events: GitHubEvent[];
}

interface RepoPoller {
  repo: string;
  intervalMs: number;
  subscribers: RepoSubscription[];
  timer: ReturnType<typeof setInterval> | null;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const pollers: RepoPoller[] = [];
let stateDir = join(homedir(), ".agents-scheduler");

/**
 * Bug 3 fix: Track repos that haven't completed their first poll after restart.
 * On the first poll, we snapshot state silently (no events dispatched).
 */
const freshRepos = new Set<string>();

function getStatePath(): string {
  return join(stateDir, "github-state.json");
}

async function loadState(): Promise<PollerState> {
  try {
    const raw = await readFile(getStatePath(), "utf-8");
    return JSON.parse(raw) as PollerState;
  } catch {
    return {};
  }
}

async function saveState(state: PollerState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(getStatePath(), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Retry helper (Bug 2 fix)
// ---------------------------------------------------------------------------

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 2,
  baseDelayMs = 2000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        logger.warn(`${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms`, {
          error: lastError.message,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// gh CLI wrapper
// ---------------------------------------------------------------------------

const GH_PR_FIELDS = [
  "number", "state", "title", "headRefName", "baseRefName",
  "headRefOid", "isDraft", "mergedAt", "updatedAt", "url",
  "author", "labels", "reviews",
].join(",");

function ghPrList(repo: string): Promise<GhPR[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [
        "pr", "list",
        "--repo", repo,
        "--state", "all",
        "--limit", "50",
        "--json", GH_PR_FIELDS,
      ],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`gh pr list failed for ${repo}: ${stderr || err.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as GhPR[]);
        } catch (parseErr) {
          reject(new Error(`Failed to parse gh output for ${repo}: ${String(parseErr)}`));
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// gh CLI wrapper (issues)
// ---------------------------------------------------------------------------

const GH_ISSUE_FIELDS = [
  "number", "state", "title", "body", "url", "updatedAt",
  "author", "labels", "assignees", "comments",
].join(",");

function ghIssueList(repo: string): Promise<GhIssue[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [
        "issue", "list",
        "--repo", repo,
        "--state", "all",
        "--limit", "50",
        "--json", GH_ISSUE_FIELDS,
      ],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`gh issue list failed for ${repo}: ${stderr || err.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as GhIssue[]);
        } catch (parseErr) {
          reject(new Error(`Failed to parse gh issue output for ${repo}: ${String(parseErr)}`));
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// State diffing — detect PR events
// ---------------------------------------------------------------------------

interface DetectedEvent {
  event: GitHubEvent;
  pr?: GhPR;
  issue?: GhIssue;
  addedLabels?: string[];
}

function snapshotPR(pr: GhPR): StoredPR {
  return {
    state: pr.state,
    headRefOid: pr.headRefOid,
    isDraft: pr.isDraft,
    merged: pr.mergedAt !== null,
    labels: pr.labels.map((l) => l.name).sort(),
    reviewCount: pr.reviews.length,
  };
}

function detectPREvents(current: GhPR[], stored: Record<string, StoredPR>): DetectedEvent[] {
  const events: DetectedEvent[] = [];

  for (const pr of current) {
    const key = String(pr.number);
    const prev = stored[key];

    if (!prev) {
      if (pr.state === "OPEN") {
        events.push({ event: "pr:opened", pr });
      }
      continue;
    }

    const wasMerged = prev.merged;
    const isMerged = pr.mergedAt !== null;

    if (prev.state === "OPEN" && pr.state === "CLOSED" && isMerged) {
      events.push({ event: "pr:merged", pr });
    } else if (prev.state === "OPEN" && pr.state === "CLOSED" && !isMerged) {
      events.push({ event: "pr:closed", pr });
    } else if (prev.state === "CLOSED" && pr.state === "OPEN" && !wasMerged) {
      events.push({ event: "pr:reopened", pr });
    } else if (prev.state === "MERGED" && pr.state === "OPEN") {
      events.push({ event: "pr:reopened", pr });
    }

    if (pr.state === "OPEN" && prev.headRefOid !== pr.headRefOid) {
      events.push({ event: "pr:synchronize", pr });
    }

    if (pr.reviews.length > prev.reviewCount) {
      events.push({ event: "pr:reviewed", pr });
    }

    const currentLabels = pr.labels.map((l) => l.name).sort();
    const addedLabels = currentLabels.filter((l) => !prev.labels.includes(l));
    if (addedLabels.length > 0) {
      events.push({ event: "pr:labeled", pr, addedLabels });
    }

    if (prev.isDraft && !pr.isDraft) {
      events.push({ event: "pr:ready_for_review", pr });
    }
  }

  return events;
}

function snapshotIssue(issue: GhIssue): StoredIssue {
  return {
    state: issue.state,
    labels: issue.labels.map((l) => l.name).sort(),
    assignees: issue.assignees.map((a) => a.login).sort(),
    commentCount: Array.isArray(issue.comments)
      ? issue.comments.length
      : (issue.comments as unknown as { totalCount: number })?.totalCount ?? 0,
  };
}

function detectIssueEvents(current: GhIssue[], stored: Record<string, StoredIssue>): DetectedEvent[] {
  const events: DetectedEvent[] = [];

  for (const issue of current) {
    const key = String(issue.number);
    const prev = stored[key];

    if (!prev) {
      if (issue.state === "OPEN") {
        events.push({ event: "issue:opened", issue });
      }
      continue;
    }

    if (prev.state === "OPEN" && issue.state === "CLOSED") {
      events.push({ event: "issue:closed", issue });
    } else if (prev.state === "CLOSED" && issue.state === "OPEN") {
      events.push({ event: "issue:reopened", issue });
    }

    const currentLabels = issue.labels.map((l) => l.name).sort();
    const addedLabels = currentLabels.filter((l) => !prev.labels.includes(l));
    if (addedLabels.length > 0) {
      events.push({ event: "issue:labeled", issue, addedLabels });
    }

    const currentAssignees = issue.assignees.map((a) => a.login).sort();
    const newAssignees = currentAssignees.filter((a) => !prev.assignees.includes(a));
    if (newAssignees.length > 0) {
      events.push({ event: "issue:assigned", issue });
    }

    const currentCommentCount = Array.isArray(issue.comments)
      ? issue.comments.length
      : (issue.comments as unknown as { totalCount: number })?.totalCount ?? 0;
    if (currentCommentCount > prev.commentCount) {
      events.push({ event: "issue:commented", issue });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Build trigger context metadata from a PR or issue
// ---------------------------------------------------------------------------

function buildPRMeta(
  repo: string,
  event: GitHubEvent,
  pr: GhPR,
  addedLabels?: string[],
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    event,
    repo,
    pr: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      headRefOid: pr.headRefOid,
      isDraft: pr.isDraft,
      mergedAt: pr.mergedAt,
      url: pr.url,
      author: pr.author.login,
      labels: pr.labels.map((l) => l.name),
      reviewCount: pr.reviews.length,
    },
  };
  if (addedLabels && addedLabels.length > 0) {
    meta.addedLabels = addedLabels;
  }
  return meta;
}

function buildIssueMeta(
  repo: string,
  event: GitHubEvent,
  issue: GhIssue,
  addedLabels?: string[],
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    event,
    repo,
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: issue.url,
      author: issue.author.login,
      labels: issue.labels.map((l) => l.name),
      assignees: issue.assignees.map((a) => a.login),
    },
  };
  if (addedLabels && addedLabels.length > 0) {
    meta.addedLabels = addedLabels;
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Poll cycle for a single repo
// ---------------------------------------------------------------------------

async function pollRepo(
  repo: string,
  subscribers: RepoSubscription[],
  manager: ExecutionManager,
): Promise<void> {
  logger.debug("Polling GitHub repo", { repo });

  // Determine which event families are needed
  const needsPRs = subscribers.some((s) => s.events.some((e) => e.startsWith("pr:")));
  const needsIssues = subscribers.some((s) => s.events.some((e) => e.startsWith("issue:")));

  // Bug 1 fix: Track whether each fetch succeeded
  let currentPRs: GhPR[] = [];
  let currentIssues: GhIssue[] = [];
  let prFetchOk = false;
  let issueFetchOk = false;

  // Bug 2 fix: Wrap fetches in withRetry for exponential backoff
  if (needsPRs) {
    try {
      currentPRs = await withRetry(() => ghPrList(repo), `gh pr list ${repo}`);
      prFetchOk = true;
    } catch (err) {
      logger.error("GitHub PR poll failed after retries", { repo, error: String(err) });
    }
  }

  if (needsIssues) {
    try {
      currentIssues = await withRetry(() => ghIssueList(repo), `gh issue list ${repo}`);
      issueFetchOk = true;
    } catch (err) {
      logger.error("GitHub issue poll failed after retries", { repo, error: String(err) });
    }
  }

  // Bug 1 fix: If both fetches failed, skip state update entirely
  if (needsPRs && !prFetchOk && needsIssues && !issueFetchOk) {
    logger.warn("All GitHub fetches failed — skipping state update", { repo });
    return;
  }
  if (needsPRs && !prFetchOk && !needsIssues) {
    logger.warn("GitHub PR fetch failed — skipping state update", { repo });
    return;
  }
  if (needsIssues && !issueFetchOk && !needsPRs) {
    logger.warn("GitHub issue fetch failed — skipping state update", { repo });
    return;
  }

  const state = await loadState();
  const repoState = state[repo];
  const isFirstRun = !repoState;

  const storedPRs = repoState?.prs ?? {};
  const storedIssues = repoState?.issues ?? {};

  // Bug 1 fix: Only build updated snapshots for successful fetches
  const updatedPRs: Record<string, StoredPR> = prFetchOk ? {} : (repoState?.prs ?? {});
  if (prFetchOk) {
    for (const pr of currentPRs) {
      updatedPRs[String(pr.number)] = snapshotPR(pr);
    }
  }

  const updatedIssues: Record<string, StoredIssue> = issueFetchOk ? {} : (repoState?.issues ?? {});
  if (issueFetchOk) {
    for (const issue of currentIssues) {
      updatedIssues[String(issue.number)] = snapshotIssue(issue);
    }
  }

  if (isFirstRun) {
    // Save initial state snapshot, no events
    state[repo] = {
      lastPoll: new Date().toISOString(),
      prs: updatedPRs,
      issues: updatedIssues,
    };
    await saveState(state);
    logger.info("First poll for repo — snapshotted state, no events fired", {
      repo,
      prCount: currentPRs.length,
      issueCount: currentIssues.length,
    });
    return;
  }

  // Bug 3 fix: Suppress events on first poll after restart
  if (freshRepos.has(repo)) {
    freshRepos.delete(repo);
    state[repo] = {
      lastPoll: new Date().toISOString(),
      prs: updatedPRs,
      issues: updatedIssues,
    };
    await saveState(state);
    logger.info("First poll after restart — refreshed state, events suppressed", {
      repo,
      prCount: currentPRs.length,
      issueCount: currentIssues.length,
    });
    return;
  }

  // Detect PR events (only if fetch succeeded)
  const prEvents = (needsPRs && prFetchOk) ? detectPREvents(currentPRs, storedPRs) : [];
  // Detect issue events (only if fetch succeeded)
  const issueEvents = (needsIssues && issueFetchOk) ? detectIssueEvents(currentIssues, storedIssues) : [];
  const allEvents = [...prEvents, ...issueEvents];

  if (allEvents.length === 0) {
    logger.debug("No GitHub events detected", { repo });
  } else {
    logger.info("GitHub events detected", {
      repo,
      events: allEvents.map((e) =>
        `${e.event}#${e.pr?.number ?? e.issue?.number}`,
      ),
    });

    for (const { event, pr, issue, addedLabels } of allEvents) {
      const matchingAgents = subscribers.filter((s) => s.events.includes(event));

      for (const sub of matchingAgents) {
        const itemNumber = pr?.number ?? issue?.number;

        logger.info("Dispatching GitHub event to agent", {
          agent: sub.agentName,
          event,
          number: itemNumber,
          repo,
        });

        const meta = pr
          ? buildPRMeta(repo, event, pr, addedLabels)
          : buildIssueMeta(repo, event, issue!, addedLabels);

        manager
          .run(sub.agentName, {
            triggerType: "github",
            triggeredAt: new Date().toISOString(),
            meta,
          })
          .catch((err) =>
            logger.error("GitHub-triggered run failed", {
              agent: sub.agentName,
              event,
              number: itemNumber,
              error: String(err),
            }),
          );
      }
    }
  }

  // Bug 1 fix: Save state AFTER event detection/dispatch (at-least-once delivery)
  state[repo] = {
    lastPoll: new Date().toISOString(),
    prs: updatedPRs,
    issues: updatedIssues,
  };
  await saveState(state);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GitHubPollerRoute {
  agentName: string;
  trigger: GitHubTrigger;
}

export function registerGitHubPollers(
  routes: GitHubPollerRoute[],
  manager: ExecutionManager,
): void {
  const envStateDir = process.env.GITHUB_STATE_DIR;
  if (envStateDir) {
    stateDir = envStateDir;
  }

  const defaultInterval = Number(process.env.GITHUB_POLL_INTERVAL_MS ?? 60_000);

  const repoMap = new Map<string, { intervalMs: number; subscribers: RepoSubscription[] }>();

  for (const route of routes) {
    const repo = route.trigger.repo;
    const existing = repoMap.get(repo);

    const sub: RepoSubscription = {
      agentName: route.agentName,
      events: route.trigger.events,
    };

    const triggerInterval = route.trigger.pollIntervalMs ?? defaultInterval;

    if (existing) {
      existing.subscribers.push(sub);
      existing.intervalMs = Math.min(existing.intervalMs, triggerInterval);
    } else {
      repoMap.set(repo, {
        intervalMs: triggerInterval,
        subscribers: [sub],
      });
    }
  }

  for (const [repo, { intervalMs, subscribers }] of repoMap) {
    // Bug 3 fix: Mark each repo as fresh so first poll suppresses events
    freshRepos.add(repo);

    const poller: RepoPoller = {
      repo,
      intervalMs,
      subscribers,
      timer: null,
    };

    pollRepo(repo, subscribers, manager).catch((err) =>
      logger.error("Initial GitHub poll failed", { repo, error: String(err) }),
    );

    poller.timer = setInterval(() => {
      pollRepo(repo, subscribers, manager).catch((err) =>
        logger.error("GitHub poll cycle failed", { repo, error: String(err) }),
      );
    }, intervalMs);

    pollers.push(poller);
    logger.info("Registered GitHub poller", {
      repo,
      intervalMs,
      agents: subscribers.map((s) => s.agentName),
      events: [...new Set(subscribers.flatMap((s) => s.events))],
    });
  }
}

export function stopGitHubPollers(): void {
  for (const poller of pollers) {
    if (poller.timer) {
      clearInterval(poller.timer);
      poller.timer = null;
    }
  }
  pollers.length = 0;
  freshRepos.clear();
}
