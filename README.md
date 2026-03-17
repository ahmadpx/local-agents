# Local Agents

A Turborepo monorepo for running autonomous AI agents locally, powered by the [Claude Agent SDK](https://docs.anthropic.com).

Each agent is a self-contained package under `agents/` — defined by a system prompt (`AGENTS.md`) and an execution config (`agent.config.ts`). A shared scheduler orchestrates triggers (cron, webhooks, GitHub events, file watchers) and runs agents via the Claude Agent SDK.

## Structure

```
agents/
├── sdk/              ← @agents/sdk — shared runtime (defineAgent, runner, logger, types)
├── scheduler/        ← @agents/scheduler — orchestration engine (cron, webhooks, GitHub poller)
├── pr-reviewer/      ← example agent — reviews PRs across GitHub repos
└── your-agent/       ← add your own agents here
```

## Quick Start

```bash
# Install dependencies
npm install

# Build all packages
npx turbo build

# List discovered agents
npm run agent-list

# Manually run an agent
npm run agent-run -- pr-reviewer

# Check run logs
npm run agent-logs -- pr-reviewer
```

## Authentication

Agents authenticate via a Claude Max subscription OAuth token:

```bash
claude setup-token
```

Set the token in `.env` at the repo root:

```
CLAUDE_CODE_OAUTH_TOKEN=<your-token>
```

## Creating a New Agent

Each agent needs 4 files: `AGENTS.md`, `agent.config.ts`, `package.json`, and `tsconfig.json`.

```bash
mkdir -p agents/my-agent
```

See `agents/pr-reviewer/` for a complete example, or read [`AGENTS.md`](./AGENTS.md) for the full guide on agent structure, triggers, skills, and orchestration.

## Example: PR Reviewer

The included `pr-reviewer` agent demonstrates a GitHub-triggered agent that:

- Watches for PR events (opened, reopened, synchronized) on configured repos
- Clones the repo, checks out the PR branch, and reads the full diff
- Discovers project conventions from docs (CLAUDE.md, README, etc.)
- Posts a structured code review via `gh` CLI
- Supports both formal GitHub reviews and PR comments
- Optionally labels PRs based on review outcome

Configure repos in `agents/pr-reviewer/agent.config.ts`.

## Scheduler

The scheduler discovers agents automatically and manages their execution:

```bash
# Development
npm run scheduler

# Production (pm2)
npm run scheduler:start
npm run scheduler:stop
npm run scheduler:restart
npm run scheduler:logs
```

### Trigger Types

- **Cron** — run on a schedule
- **Webhook** — `POST /trigger/{agent}` (port 3847)
- **GitHub** — react to PR/issue events via polling
- **File watch** — react to file changes
- **Inter-agent** — chain agents together
- **Manual** — always available via `npm run agent-run`

## License

Private — for personal use.
