import { defineAgent } from "@agents/sdk";
import type { GitHubEvent } from "@agents/sdk";

interface RepoConfig {
  events: GitHubEvent[];
  reviewFormat: "comment" | "review";
  labels?: {
    issues?: string;
    passed?: string;
  };
}

// Add your repositories here. Example:
// "owner/repo-name": {
//   events: ["pr:opened", "pr:reopened", "pr:synchronize"],
//   reviewFormat: "review",        // "review" for formal GitHub reviews, "comment" for PR comments
//   labels: { issues: "needs-changes", passed: "approved" },  // optional
// },
const repos: Record<string, RepoConfig> = {};

export default defineAgent({
  name: "pr-reviewer",
  description:
    "Generic PR reviewer — reviews pull requests across multiple repositories.",
  triggers: Object.entries(repos).map(([repo, config]) => ({
    type: "github" as const,
    repo,
    events: config.events,
  })),
  execution: {
    model: "claude-sonnet-4-6",
    permissionMode: "acceptEdits",
    maxTurns: 30,
    timeoutMs: 600_000,
    tools: ["Read", "Bash", "Glob", "Grep"],
    retries: 1,
  },
  prompt: (ctx) => {
    const meta = ctx.meta as Record<string, unknown> | undefined;
    const repo = meta?.repo as string;
    const pr = meta?.pr as Record<string, unknown> | undefined;
    const repoConfig = repos[repo];
    const repoSlug = repo?.replace("/", "-") ?? "unknown";

    return [
      `A pull request event was detected.`,
      ``,
      `## Repo Config`,
      `- REPO: ${repo}`,
      `- REPO_SLUG: ${repoSlug}`,
      `- WORKSPACE: $HOME/pr-reviews/${repoSlug}`,
      `- PR_NUMBER: ${pr?.number ?? "UNKNOWN"}`,
      `- PR_TITLE: ${pr?.title ?? ""}`,
      `- HEAD_REF: ${pr?.headRefName ?? ""}`,
      `- BASE_REF: ${pr?.baseRefName ?? "main"}`,
      `- EVENT: ${meta?.event ?? "unknown"}`,
      `- REVIEW_FORMAT: ${repoConfig?.reviewFormat ?? "comment"}`,
      repoConfig?.labels
        ? `- LABEL_ISSUES: ${repoConfig.labels.issues ?? ""}`
        : `- LABEL_ISSUES: (none)`,
      repoConfig?.labels
        ? `- LABEL_PASSED: ${repoConfig.labels.passed ?? ""}`
        : `- LABEL_PASSED: (none)`,
      ``,
      `Follow the workflow in your AGENTS.md step by step.`,
      `Use the values above wherever the workflow references variables like REPO, PR_NUMBER, etc.`,
    ].join("\n");
  },
  maxConcurrency: 1,
});
