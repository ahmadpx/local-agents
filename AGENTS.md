# Agents Monorepo

A Turborepo monorepo where each package under `agents/` is a self-contained AI agent.

## Architecture

```
agents/                   ← workspace root (Turborepo)
├── agents/               ← all agent packages live here
│   ├── sdk/              ← @agents/sdk (types, defineAgent, runner, logger)
│   ├── scheduler/        ← @agents/scheduler (orchestration engine)
│   ├── agent-a/
│   │   ├── AGENTS.md       ← system prompt (behavior, persona, tools, workflow)
│   │   ├── agent.config.ts ← execution config (triggers, model, tools, prompt)
│   │   ├── logs/           ← timestamped run logs (gitignored)
│   │   │   ├── 2026-02-24T05-00-00_cron.log
│   │   │   └── 2026-02-24T04-19-03_manual.log
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── agent-b/
│       ├── AGENTS.md
│       ├── agent.config.ts
│       ├── logs/
│       ├── package.json
│       └── tsconfig.json
├── turbo.json
├── package.json
└── AGENTS.md             ← you are here
```

## Core Principles

1. **One agent per package.** Each directory in `agents/` is a standalone agent with its own `AGENTS.md` and `agent.config.ts`.
2. **Config-driven, no standalone entry points.** Agents do NOT have `src/index.ts`. The scheduler + SDK runner handle all execution. Each agent only needs two files: `AGENTS.md` (system prompt) and `agent.config.ts` (execution config). The runner loads the AGENTS.md, resolves the prompt, and calls the Claude Agent SDK automatically.
3. **AGENTS.md is the source of truth.** Every agent MUST have an `AGENTS.md` at its root. This file defines what the agent does, how it behaves, what tools/skills it has, and how to run it. Any AI harness working on an agent should read its `AGENTS.md` first.
4. **Shared agentic loop, unique capabilities.** All agents share the same runtime foundation (Claude Agent SDK via `@agents/sdk`). What makes each agent different is its prompt, its skills, and its `AGENTS.md`.

## Shared Runtime: Claude Agent SDK

Every agent in this monorepo uses `@anthropic-ai/claude-agent-sdk` as its agentic loop, accessed through `@agents/sdk`. Individual agents NEVER depend on `@anthropic-ai/claude-agent-sdk` directly — they only depend on `@agents/sdk`, which wraps it and provides `defineAgent`, the runner, logger, and types.

### Authentication

All agents authenticate via **Claude Max subscription** using an OAuth token. This avoids usage-based billing — all agent usage is covered by the Max plan.

**Setup:**

```bash
# Generate your OAuth token (one-time)
claude setup-token

# Set the token at the repo root (.env)
CLAUDE_CODE_OAUTH_TOKEN=<your-token>
```

Set `CLAUDE_CODE_OAUTH_TOKEN` in a `.env` file at the repo root. Individual agents inherit it unless they override with their own. Do NOT set `ANTHROPIC_API_KEY` alongside it — the OAuth token takes precedence.

### How Agents Run

Agents do NOT have their own entry points. The scheduler + SDK runner handle execution:

1. The **scheduler** discovers agents by scanning for `agent.config.ts` files
2. When a trigger fires (cron, webhook, manual, etc.), the scheduler calls `executeAgent()` from `@agents/sdk`
3. The **runner** loads the agent's `AGENTS.md` as the system prompt, resolves the prompt from `agent.config.ts`, and calls the Claude Agent SDK `query()` loop
4. The runner handles timeout, retries, abort, and output capture

The SDK provides built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch) and handles the full agentic loop — context management, tool execution, retries. Agents extend their capabilities purely through **skills**.

## Skills System

Skills are the extension mechanism. An agent's capabilities beyond the SDK builtins come entirely from skills. When an agent needs a new capability, follow this resolution order:

### 1. Check the Monorepo First

Look in the repo for an existing skill that covers the need:

```bash
# check if a skill already exists locally
ls agents/*/skills/
ls .claude/skills/
```

If a skill exists in another agent's package and is general-purpose, consider extracting it to a shared location or referencing it.

### 2. Check skills.sh

[skills.sh](https://skills.sh) is the open agent skills ecosystem. Search before building:

```bash
# search for a skill
npx skills find "what you need"

# browse categories at https://skills.sh

# install a skill to the project
npx skills add owner/repo

# install a specific skill
npx skills add owner/repo -s skill-name

# list what's installed
npx skills list
```

Skills installed via `npx skills add` land in `.claude/skills/` (project-level) and are automatically available to all agents.

### 3. Build a New Skill

Only if nothing exists in the monorepo or on skills.sh should you build a new skill. Use the skill creator:

```bash
# scaffold a new skill
npx skills init my-skill-name
```

A skill is a markdown file that gives the agent specialized knowledge and instructions. Place it in the agent's own `.claude/skills/` directory if agent-specific, or in the repo root `.claude/skills/` if shared across agents.

**Skill resolution summary:**

```
Need a capability
  → exists in monorepo? USE IT
  → exists on skills.sh? INSTALL IT
  → neither? BUILD IT
```

## Creating a New Agent

Every agent is config-driven. You need exactly 4 files: `AGENTS.md`, `agent.config.ts`, `package.json`, and `tsconfig.json`. No `src/` directory, no `index.ts`.

### Step 1: Scaffold the Package

```bash
mkdir -p agents/my-agent
cd agents/my-agent
```

Create `package.json`:

```json
{
  "name": "@agents/my-agent",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@agents/sdk": "*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "5.9.2"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["agent.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### Step 2: Create the Agent's AGENTS.md

This is the most important file. Every agent MUST have one. It should contain:

```markdown
# Agent Name

## Purpose
What this agent does in one paragraph.

## Persona
How the agent behaves, its tone, its constraints.

## Constraints
Hard limits on what the agent can and cannot do.

## Workflow
Step-by-step instructions for the agent's workflow.

## Tools
Which SDK tools this agent is allowed to use.

## Inputs
What the agent expects as input.

## Outputs
What the agent produces.
```

The `AGENTS.md` is loaded by the runner and injected as the agent's system prompt. Write it as if you are speaking directly to the agent.

### Step 3: Create agent.config.ts

This defines when and how the agent runs:

```typescript
import { defineAgent } from "@agents/sdk";

export default defineAgent({
  name: "my-agent",
  description: "What this agent does",
  triggers: [
    { type: "cron", schedule: "0 9 * * *", skipIfRunning: true },
  ],
  execution: {
    model: "claude-sonnet-4-6",
    cwd: "/path/to/target/project",
    permissionMode: "acceptEdits",
    maxTurns: 10,
    timeoutMs: 300_000,
    tools: ["Read", "Edit", "Bash", "Glob", "Grep"],
    retries: 1,
  },
  prompt: () => "Do your thing. Follow the workflow in your AGENTS.md.",
  maxConcurrency: 1,
});
```

### Step 4: Build & Validate

After creating the agent, you MUST validate the full workflow end-to-end:

```bash
# 1. Install dependencies
npm install                                      # links workspaces

# 2. Build the agent (this also restarts the scheduler automatically)
npx turbo build --filter=@agents/my-agent        # build the agent
# pm2 watches agents/*/dist/agent.config.js — the scheduler auto-restarts
# on build, picking up the new agent. No need to restart it manually.

# 3. Verify the scheduler discovered the agent
npm run agent-list                               # should show your agent and its triggers

# 4. Manually trigger the agent
npm run agent-run -- my-agent                    # run it once

# 5. Check the run log to confirm it worked
npm run agent-logs -- my-agent                   # live-tail the log
# OR
ls -lt agents/my-agent/logs/                     # verify a log file was created
tail -100 agents/my-agent/logs/*.log             # inspect the output

# 6. Verify the output
# Check that the agent produced the expected result — files created/edited,
# commands run, etc. The log file contains the full transcript of what happened.
```

**Do NOT skip validation.** Every new agent must be manually triggered and its log inspected before considering it done. A successful build alone does not mean the agent works — you need to confirm the run log shows the agent executed its workflow correctly and produced the expected output.

## Agent Orchestration

Agents can run autonomously via the scheduler. Each agent defines **when** and **how** it runs via an `agent.config.ts` file alongside its `AGENTS.md`.

### Per-Agent Files

| File | Purpose | Used by |
|------|---------|---------|
| `AGENTS.md` | System prompt (behavior, persona, workflow) | Runner loads it as `systemPrompt` for `query()` |
| `agent.config.ts` | Triggers, execution settings, prompt | Scheduler imports it to configure when/how to run |
| `package.json` | Dependencies (only `@agents/sdk`) and build script | Turborepo workspace |
| `tsconfig.json` | TypeScript config (includes only `agent.config.ts`) | `tsc` build |
| `logs/` | Timestamped run logs (one file per run) | Runner writes stdout/stderr; useful for debugging and checking if an agent already ran |

Agents do NOT have `src/index.ts` or any standalone entry point. The scheduler + SDK runner handle all execution.

### Run Logs

Each agent has a `logs/` directory at its package root containing timestamped log files from each run. The runner writes these automatically.

```
agents/my-agent/logs/
├── 2026-02-24T05-00-00_cron.log
├── 2026-02-24T04-19-03_manual.log
└── 2026-02-23T18-04-37_manual.log
```

- **Format:** `YYYY-MM-DDTHH-MM-SS_<triggerType>.log` (UTC timestamp + trigger type: `cron`, `manual`, `webhook`, etc.)
- **Generated by:** The SDK runner (`@agents/sdk`) — creates the `logs/` directory automatically and writes a log file per run
- **Contents:** Full run transcript — agent config, prompt, all messages, tool calls, responses, errors, final status and duration
- **Purpose:** Check if an agent has already run, debug failures, review past behavior
- **Gitignored:** The `logs/` directory is gitignored and should NOT be committed

To check if an agent has run recently:

```bash
ls -lt agents/my-agent/logs/            # list runs, newest first
tail -50 agents/my-agent/logs/*.log     # inspect the end of a specific run
npm run agent-logs -- my-agent          # live-tail the latest log file
```

### agent.config.ts

```typescript
import { defineAgent } from "@agents/sdk";

export default defineAgent({
  name: "my-agent",
  description: "What this agent does",
  schedule: "0 9 * * *",           // cron shorthand
  triggers: [
    { type: "webhook" },
    { type: "file", patterns: ["src/**/*.ts"] },
    { type: "agent", source: "other-agent" },
  ],
  execution: {
    permissionMode: "acceptEdits",
    maxTurns: 10,
    timeoutMs: 300_000,
    tools: ["Read", "Edit", "Bash", "Glob", "Grep"],
    retries: 1,
  },
  prompt: (ctx) => "Do your thing.",
  maxConcurrency: 1,
});
```

### Trigger Types

1. **Cron** — `{ type: "cron", schedule: "0 9 * * *", timezone?, skipIfRunning? }`
2. **Webhook** — `{ type: "webhook", path?, secret?, passBody? }` → `POST /trigger/{path}`
3. **File watch** — `{ type: "file", patterns: ["**/*.ts"], debounceMs?, ignore? }`
4. **Inter-agent** — `{ type: "agent", source: "agent-name", onSuccess?, onFailure?, passResult? }`
5. **Manual** — always implicitly available via CLI

### Scheduler Commands

```bash
npm run scheduler            # start the scheduler daemon (dev mode)
npm run agent-list           # show discovered agents and triggers
npm run agent-run -- <name>  # manually trigger an agent
```

The scheduler discovers agents by scanning each agent directory for `agent.config.ts`, registers triggers (cron jobs, webhook routes, file watchers, pipeline edges), and runs agents via the Claude Agent SDK when triggers fire.

**Auto-restart on build:** In production (pm2), the scheduler watches `agents/*/dist/agent.config.js`. When you run `npx turbo build`, the compiled config files change and pm2 automatically restarts the scheduler, picking up any new or updated agents. You do NOT need to manually restart the scheduler after adding a new agent — just build.

- Webhook server runs on port 3847 (configurable via `SCHEDULER_PORT`)
- `GET /health` returns `{"status":"ok"}`
- `POST /trigger/{agent}` triggers an agent and returns 202 immediately
- Inter-agent pipelines fire downstream agents on completion
- Pipeline cycles are detected at startup and logged as errors

## Conventions

- **Package naming:** `@agents/<agent-name>`
- **Agent behavior:** `AGENTS.md` at agent package root
- **Agent execution config:** `agent.config.ts` at agent package root
- **No standalone entry points:** agents do NOT have `src/index.ts` — the scheduler + runner handle execution
- **Only dependency:** `@agents/sdk` (never `@anthropic-ai/claude-agent-sdk` directly)
- **Only build script:** `"build": "tsc"` (no `dev` or `start` scripts)
- **tsconfig includes:** only `agent.config.ts` (no `src/` directory)
- **Build output:** `dist/`
- **Agent-specific skills:** `agents/<name>/.claude/skills/`
- **Shared skills:** `.claude/skills/` at repo root
- **Run logs:** `agents/<name>/logs/` — timestamped per-run logs, gitignored, never committed
- **Environment variables:** `.env` at repo root, agent-specific `.env` in agent directory

## Commands

```bash
npm install                                    # install all dependencies
npx turbo build                                # build all agents
npx turbo build --filter=@agents/my-agent      # build one agent
npm run scheduler                              # start the scheduler daemon
npm run agent-list                             # list discovered agents
npm run agent-run -- <name>                    # manually trigger an agent
npm run agent-logs -- <name>                   # live-tail the latest run log
```

### pm2 (Production)

```bash
npm run scheduler:start                        # start scheduler via pm2
npm run scheduler:stop                         # stop scheduler
npm run scheduler:restart                      # rebuild & restart scheduler
npm run scheduler:status                       # check pm2 process status
npm run scheduler:logs                         # tail pm2 scheduler logs
```
