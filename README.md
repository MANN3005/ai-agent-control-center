# AI Agent Control Center

**Authorized to Act: AI Agents with Auth0**

A secure, business-ready control plane for AI agents that act on GitHub and Slack. It solves the trust deficit by enforcing **explicit permission boundaries**, **step-up authentication**, and **auditable execution** using Auth0’s Token Vault.

In short: a **policy-gated agent platform** built for teams that care about security, accountability, and safe automation.

## Executive summary
AI agents are powerful, but most can’t leave the sandbox. This project enables real-world agent workflows by combining Auth0’s identity layer with strict tool governance: allow-listed resources, risk-based approvals, and fully traceable execution. It is designed to be deployable in real teams, not just demos.

## Why this wins the trust game
- **Security-first**: no tool executes without explicit policy and resource approval.
- **Token Vault integration**: user tokens stay protected in Auth0.
- **Step-up for high risk**: time-boxed approvals for critical actions.
- **Audit-ready**: every decision and tool call is logged with context.
- **Clear user control**: policies are visible and enforced at runtime.

## Features
- **Policy enforcement**: AUTO, CONFIRM, and STEP_UP per tool.
- **Allow-listing**: repo-scoped tools can only touch approved repos.
- **Agent orchestration**: LLM plans tool calls; humans approve when needed.
- **Provider-agnostic identity linking**: first authenticated profile becomes primary; additional providers link to that anchor.
- **Slack and GitHub workflows**: real automation that stays safe.
- **Slack claims**: volunteers can claim issues in `#new-issues` with natural phrases.
- **Traceability**: step-by-step trace viewer with planning, recovery, reply, and policy verdict entries.
- **Token Health monitor**: vault protection status and token TTL visibility without exposing secrets.
- **Live policy decision log**: terminal-style feed of recent allow/deny/step-up decisions with reasons.
- **Policy Impact visualizer**: blocked reasons open a clickable rule-by-rule policy evaluation trace.
- **Real-Time Resource Map**: permission scan view with per-repo capability levels.
- **Interactive step-up trigger**: one-click identity re-verification from the Access screen.
- **Session Lockdown / Kill Switch**: disarm the agent and request token revocation from Auth0 Management API.
- **Durable LLM trace history**: LLM Trace is persisted in Prisma (SQLite) instead of memory-only logs.
- **Resilience**: retry-with-reflection and circuit breaker protection.
- **Audit trails**: immutable records of all decisions and executions.

## How it works
1) User logs in with Auth0 (GitHub, Google, or Slack).
2) The first successful identity is treated as the primary profile anchor.
3) User links additional providers to that same primary profile.
4) Admin allow-lists approved GitHub repos.
5) Policies define automatic, confirm, or step-up execution per tool.
6) User runs a tool or submits a natural language task.
7) The backend enforces policy + allow-list, then executes.
8) Everything is recorded in audit and persisted LLM trace logs.

## Identity linking model
- Primary profile is provider-agnostic (not hardcoded to Google).
- Linking can be finalized from primary or secondary session context.
- On redirect return, the app restores the primary session provider and completes pending link handshakes.
- Identity graph center represents the primary profile; linked providers attach around it.

## Tool catalog
- `github_explorer` - List GitHub repos, issues, or PRs.
- `manage_issues` - Create, close, reopen, or comment on GitHub issues.
- `slack_notifier` - Post a message or summary to Slack.

## Tool actions
- `github_explorer.resource`: `repos`, `issues`, `prs`
- `manage_issues.action`: `create`, `close`, `reopen`, `comment`
- `slack_notifier.action`: `post`, `summary`

## Slack issue claims (new-issues)
- When an unassigned issue is created, it posts to `#new-issues` with a prompt.
- Team members can reply **in the thread** with natural phrases like:
	- "I’ll take it", "assign to me", "I can work on this", "I’ll handle this"
	- Optional GitHub handle: "assign to me @githubid"
- The system adds a GitHub comment and assigns the issue when a GitHub handle is provided.
- If no GitHub handle is provided, it attempts to match by Slack user email; if no match, it only comments.

Note: Auth0 identity linkage is the source of truth. When a user links Slack + GitHub in Auth0, the app uses that linkage to map Slack users to GitHub identities without requiring `@githubid`.

## Hackathon judging alignment

### Security model
- Explicit repo allow-lists block unauthorized access.
- Risk-based policy gates every tool.
- Step-up sessions protect high-stakes actions.
- Token Vault ensures credentials never sit in the app.

### Observability
- Trace viewer shows step-level execution (plan → call → results).
- Trace viewer includes policy verdict events (allow/confirm/step-up/error decisions).
- Audit log includes structured decision reasoning for each action.

### Resilience
- Retry-with-reflection to recover from common errors (bad repo names, missing inputs).
- Circuit breaker freezes runaway actions and notifies the owner on Slack.

### User control
- Policies are visible and editable in the UI.
- Approvals are explicit and time-limited.
- Agent steps are transparent with clear prompts.

### Technical execution
- Auth0 Token Vault integration for GitHub/Slack access tokens.
- Strong input validation and policy enforcement on every call.
- LLM planning separated from execution and enforcement.
- LLM trace records are persisted in Prisma for durable history and debugging.

### Design
- Clear control-plane layout with policy, allow-list, agent, and audit screens.
- Balanced frontend/backend with real integrations.

### Potential impact
- A template for safe, production-ready AI agent workflows.
- Reusable policy and auditing patterns for enterprise use.

### Insight value
- Demonstrates how identity and governance enable agents to leave the sandbox.
- Reveals the operational patterns needed for secure tool calling.

## Architecture
- **API**: Node + Express + Prisma + SQLite.
- **Web**: React + Vite.
- **Auth**: Auth0 (JWT + Token Vault).
- **LLM**: Groq API (OpenAI-compatible).
- **Persistence**: Prisma models for audit logs and LLM trace logs.

## API endpoints
- GET /health
- GET /me
- GET /access-state
- GET /debug/identities
- POST /auth/link
- POST /auth/unlink
- GET /policies
- PUT /policies
- GET /allowed-resources
- PUT /allowed-resources
- POST /step-up/start
- POST /agent/lockdown
- POST /agent/arm
- POST /tools/execute
- POST /agent/run
- POST /agent/continue
- GET /agent/runs/:id
- GET /audit
- GET /llm-audit
- POST /slack/events

## UI screens
- Home: overview stats
- Access: token health, live policy decisions, and step-up trigger
- Allow-list: manage allowed GitHub repos
- Policies: set risk and mode per tool
- Agent: task-based execution with approvals
- Audit: decision history
- LLM Trace: planning/recovery/reply/policy call visibility

## Project structure
- API server: api/src/index.ts
- API routes: api/src/routes.ts
- Tool registry: api/src/tools.ts
- Prisma schema: api/prisma/schema.prisma
- Web app: web/src/App.tsx

## Quickstart

### 1) Install dependencies
```bash
npm install
cd api && npm install
cd ../web && npm install
```

### 2) Database
```bash
cd api
npx prisma migrate dev
```

### 3) Run the apps
```bash
cd api
npm run dev
```

```bash
cd web
npm run dev
```

Open the web app at http://localhost:5173

## Slack Events setup
1) Create a Slack app and add a Bot User.
2) Enable Event Subscriptions and set the Request URL to:
	`https://<your-ngrok-id>.ngrok-free.dev/slack/events`
3) Subscribe to Bot Events: `message.channels`.
4) OAuth scopes: `channels:history`, `channels:read`, `chat:write`, `users:read`, `users:read.email`.
5) Install/Reinstall the app and invite the bot to `#new-issues`.

Note: for local development, keep ngrok running while testing Slack events. If ngrok stops, Slack can’t reach your API.

Required env vars:
- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `SLACK_EVENTS_DEBUG` (optional)

## Demo flow
1) Login with any supported provider.
2) Link remaining providers from the Identity Linkage Graph.
3) Allow-list a repo.
4) Set `manage_issues` to CONFIRM and `slack_notifier` to STEP_UP.
5) Run a tool chain like: "Find the open issues in the backend repo, summarize them, and post that summary to Slack."
6) Approve actions when prompted.
7) Review the audit log and LLM trace.
8) Create an unassigned issue and reply in `#new-issues` with "I’ll take it @yourgithubid".

## Roadmap
- More connectors (Jira, Linear, ServiceNow).
- Durable run persistence and background workers.
- Webhooks for policy events and audit streaming.
- MCP tool registry adapter.

## License
TBD
