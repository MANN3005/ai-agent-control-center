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
- **Slack and GitHub workflows**: real automation that stays safe.
- **Audit trails**: immutable records of all decisions and executions.

## How it works
1) User logs in with Auth0 and connects GitHub and/or Slack.
2) Admin allow-lists approved GitHub repos.
3) Policies define automatic, confirm, or step-up execution per tool.
4) User runs a tool or submits a natural language task.
5) The backend enforces policy + allow-list, then executes.
6) Everything is recorded in the audit log.

## Tool catalog
- `list_repos` - List GitHub repositories for the connected user.
- `list_issues` - List GitHub issues for a repo.
- `create_issue` - Create a GitHub issue.
- `close_issue` - Close a GitHub issue.
- `close_issues` - Close multiple GitHub issues.
- `create_issue_and_notify` - Create an issue and DM the assignee on Slack.
- `slack_post_message` - Post a message to Slack.
- `summarize_github_to_slack` - Summarize repos and post to Slack.

## Hackathon judging alignment

### Security model
- Explicit repo allow-lists block unauthorized access.
- Risk-based policy gates every tool.
- Step-up sessions protect high-stakes actions.
- Token Vault ensures credentials never sit in the app.

### User control
- Policies are visible and editable in the UI.
- Approvals are explicit and time-limited.
- Agent steps are transparent with clear prompts.

### Technical execution
- Auth0 Token Vault integration for GitHub/Slack access tokens.
- Strong input validation and policy enforcement on every call.
- LLM planning separated from execution and enforcement.

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

## API endpoints
- GET /health
- GET /me
- GET /debug/identities
- POST /auth/link
- GET /policies
- PUT /policies
- GET /allowed-resources
- PUT /allowed-resources
- POST /step-up/start
- POST /tools/execute
- POST /agent/run
- POST /agent/continue
- GET /agent/runs/:id
- GET /audit

## UI screens
- Home: overview stats
- Allow-list: manage allowed GitHub repos
- Policies: set risk and mode per tool
- Agent: task-based execution with approvals
- Audit: decision history

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

## Demo flow
1) Login and connect GitHub/Slack.
2) Allow-list a repo.
3) Set create_issue to CONFIRM and close_issue to STEP_UP.
4) Run a task like: "List open issues and create a summary issue."
5) Approve actions when prompted.
6) Review the audit log.

## Roadmap
- More connectors (Jira, Linear, ServiceNow).
- Durable run persistence and background workers.
- Webhooks for policy events and audit streaming.
- MCP tool registry adapter.

## License
TBD
