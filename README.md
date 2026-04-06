# AI Agent Control Center

## Authorized to Act: AI Agents with Auth0 Token Vault

AI Agent Control Center is a secure operations layer for autonomous agents that need to work with real tools like GitHub and Slack.

It combines:
- Auth0 for AI Agents (Token Vault)
- explicit permission boundaries
- risk-based execution controls
- complete observability

so teams can move from toy demos to production-ready agent workflows.

This project was built for the Authorized to Act Hackathon and is designed to directly satisfy the Token Vault requirement.

---

## Table of Contents
- Product Overview
- Why This Matters
- Core Product Capabilities
- Security and Trust Model
- User Experience
- Architecture
- End-to-End Flow
- Tool Catalog
- API Surface
- Setup and Quickstart
- Environment Variables
- Auth0 Setup Notes
- Slack Events Setup
- Demo Guide and Submission Checklist
- Judging Criteria Mapping
- Deployment Notes
- Troubleshooting
- Roadmap
- License

---

## Product Overview

Most agents can reason, but cannot safely act across a user’s real systems.

AI Agent Control Center solves that by introducing an intermediary governance layer between an agent runtime and external APIs:
- Agents can only operate inside approved boundaries.
- Sensitive actions require explicit approval and step-up re-verification.
- Every policy decision and tool action is traceable.

In plain terms: this is an enterprise-style control plane for AI actions.

---

## Why This Matters

The industry is moving fast toward local and sovereign AI runtimes, but external API access is still a trust bottleneck.

This project addresses that bottleneck with a practical pattern:
- Keep the agent restricted.
- Keep credentials in Token Vault.
- Let users control what the agent can do.
- Keep a full audit trail of outcomes and rationale.

---

## Core Product Capabilities

### 1) Identity and token governance
- Auth0-backed login and provider linking.
- Provider-agnostic identity model (first successful login becomes primary profile anchor).
- GitHub and Slack token retrieval via Token Vault-backed identity records.

### 2) Explicit permission boundaries
- Repo allow-listing for repository-scoped tools.
- Runtime enforcement of allow-listed resources.
- Clear blocked reasons when boundaries are violated.

### 3) Risk-based agent controls
- Per-tool modes: `AUTO`, `CONFIRM`, `STEP_UP`.
- Human-in-the-loop approvals for high-stakes actions.
- Step-up authentication sessions for sensitive paths.

### 4) Security controls for live operations
- Session Lockdown / Kill Switch to disarm actions.
- Re-arm flow with re-auth verification.
- Optional token revocation requests via Auth0 management APIs.

### 5) Full observability
- Audit log for policy outcomes and execution context.
- LLM activity trace for planning, recovery, reply, and policy calls.
- Summary intelligence cards and one-click executive summary generation.

### 6) Workflow utility
- GitHub issue management actions.
- Slack notification and summary posting.
- Slack issue-claim flow in `#new-issues` with identity-aware assignment.

---

## Security and Trust Model

### Policy gates
No tool executes unless policy checks pass.

### Resource constraints
Repo-scoped actions are hard-limited to approved repositories.

### Step-up for high risk
Critical actions can require active re-verification before approval.

### Token handling
OAuth token lifecycle stays with Auth0 Token Vault patterns; tokens are not exposed through the UI.

### Auditability
All decisions and outcomes are logged and inspectable.

---

## User Experience

### Screens
- Home: system posture, connected identities, executive summary
- Access: token health, live policy outcomes, verification controls
- Repositories: allow-list management
- Policies: risk + execution mode controls per tool
- Agent: task execution, approvals, trace timeline
- Activity Audit: decision outcomes and rationale
- AI Activity: planning/recovery/reply/policy telemetry

### Product UX principles
- Human-readable statuses (not raw booleans)
- Fast recovery paths when blocked (example: grant repo access shortcut)
- Clear visibility into why an action was allowed or blocked

---

## Architecture

- API: Node.js + Express + Prisma + SQLite
- Web: React + Vite
- Auth: Auth0 (JWT validation + management APIs + Token Vault patterns)
- LLM: Groq (OpenAI-compatible)
- Persistence: Prisma models for audit and LLM activity records

### High-level components
- API routing and enforcement: `api/src/routes.ts`
- Agent execution and orchestration: `api/src/agent/engine.ts`
- Tool registry and execution: `api/src/tools.ts`
- Auth0 integration: `api/src/services/auth0.ts`
- LLM integration: `api/src/services/llm.ts`
- Slack events and claims flow: `api/src/slack-events.ts`
- Frontend app shell: `web/src/App.tsx`

---

## End-to-End Flow

1. User authenticates with Auth0.
2. First authenticated identity becomes the primary profile anchor.
3. User links additional providers (GitHub/Slack).
4. Admin or user configures approved repositories.
5. Policies define execution mode (`AUTO`, `CONFIRM`, `STEP_UP`) per tool.
6. User requests an agent action.
7. Backend validates policy + boundaries + session requirements.
8. Action executes (or requests approval/step-up).
9. Audit and LLM activity are persisted for review.

---

## Tool Catalog

- `github_explorer`: list repositories, issues, pull requests
- `manage_issues`: create, close, reopen, comment on issues
- `slack_notifier`: post updates and summaries to Slack

### Tool actions
- `github_explorer.resource`: `repos`, `issues`, `prs`
- `manage_issues.action`: `create`, `close`, `reopen`, `comment`
- `slack_notifier.action`: `post`, `summary`

---

## API Surface

### Core health and identity
- `GET /health`
- `GET /me`
- `GET /access-state`
- `GET /debug/identities`

### Auth and identity linking
- `POST /auth/link`
- `POST /auth/unlink`

### Policies and boundaries
- `GET /policies`
- `PUT /policies`
- `GET /allowed-resources`
- `PUT /allowed-resources`

### Step-up and agent controls
- `POST /step-up/start`
- `POST /agent/lockdown`
- `POST /agent/arm`

### Tool and agent execution
- `POST /tools/execute`
- `POST /agent/run`
- `POST /agent/continue`
- `GET /agent/runs/:id`

### Observability
- `GET /audit`
- `GET /llm-audit`

### Slack events
- `POST /slack/events`

---

## Setup and Quickstart

### Prerequisites
- Node.js 18+
- npm
- Auth0 tenant configured for app + M2M + provider connections
- Groq API key
- Optional: Slack app + ngrok for events testing

### 1) Install dependencies

```bash
npm install
npm run install:all
```

### 2) Configure environment variables

Create:
- `api/.env`
- `web/.env`

Use the Environment Variables section below.

### 3) Database setup

```bash
cd api
npx prisma migrate dev
```

### 4) Run locally (both API + web)

From repository root:

```bash
npm run dev
```

Default URLs:
- Web: `http://localhost:5173`
- API: `http://localhost:4000`

---

## Environment Variables

## API (`api/.env`)

Required:

```bash
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_AUDIENCE=https://control-center-api
AUTH0_M2M_CLIENT_ID=...
AUTH0_M2M_CLIENT_SECRET=...
GROQ_API_KEY=...
```

Recommended / optional:

```bash
PORT=4000
WEB_ORIGIN=http://localhost:5173
CORS_ORIGIN=http://localhost:5173
AGENT_MAX_STEPS=8

AUTH0_MANAGEMENT_AUDIENCE=https://your-tenant.us.auth0.com/api/v2/
AUTH0_MANAGEMENT_SCOPE=read:users read:user_idp_tokens update:users delete:refresh_tokens

AUTH0_GITHUB_CONNECTION=github
AUTH0_SLACK_CONNECTION=slack
AUTH0_GOOGLE_CONNECTION=google-oauth2

GROQ_MODEL=llama-3.1-70b-versatile
ALLOW_LINK_WITHOUT_EMAIL=false

SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=...
SLACK_EVENTS_DEBUG=false
```

## Web (`web/.env`)

Required:

```bash
VITE_AUTH0_DOMAIN=your-tenant.us.auth0.com
VITE_AUTH0_CLIENT_ID=...
VITE_AUTH0_AUDIENCE=https://control-center-api
```

Recommended / optional:

```bash
VITE_API_BASE_URL=http://localhost:4000

VITE_AUTH0_CONNECTION_GITHUB=github
VITE_AUTH0_CONNECTION_SLACK=slack
VITE_AUTH0_CONNECTION_GOOGLE=google-oauth2
```

---

## Auth0 Setup Notes

At minimum:
- Create an Auth0 Application for the web app.
- Create an API in Auth0 with audience matching `AUTH0_AUDIENCE`.
- Configure M2M credentials for management API access (`AUTH0_M2M_CLIENT_ID` and `AUTH0_M2M_CLIENT_SECRET`).
- Enable desired social/workforce connections (GitHub, Slack, Google).
- Ensure redirect URLs include your web app URL for local/dev environments.

Token Vault requirement alignment:
- This project expects provider tokens to be managed through Auth0 identity records and management API lookups.

---

## Slack Events Setup

1. Create a Slack app and Bot User.
2. Enable Event Subscriptions.
3. Set request URL:

```text
https://<your-ngrok-id>.ngrok-free.dev/slack/events
```

4. Subscribe to bot event: `message.channels`.
5. Add scopes:
	 - `channels:history`
	 - `channels:read`
	 - `chat:write`
	 - `users:read`
	 - `users:read.email`
6. Install app and invite bot to `#new-issues`.

Note: keep ngrok alive during local Slack tests.

---

## Demo Guide and Submission Checklist

### Product demo flow
1. Login with supported provider.
2. Link additional providers from Home.
3. Add repository to approved list.
4. Configure tool policies (`CONFIRM` and `STEP_UP` for critical actions).
5. Run a natural-language task requiring multiple tools.
6. Show blocked path and recovery path.
7. Complete step-up flow for sensitive action.
8. Show Activity Audit + AI Activity + Executive Summary.

### Submission checklist
- Text description with project features and functionality
- Public demo video link (about 3 minutes)
- Public repository URL
- Published app/project link (or clear explanation if not applicable)
- Optional bonus blog section (250+ words, materially distinct)

---

## Hackathon Judging Criteria Mapping

### Security model
- Explicit repo allow-lists
- Risk-based policy gates
- Step-up sessions for high-stakes actions
- Token Vault-backed identity/token handling

### User control
- Visible policy controls
- Transparent approvals
- Runtime permission boundaries and blocked reasons

### Technical execution
- Full-stack implementation (frontend + backend + real integrations)
- Durable audit and AI activity persistence
- Robust policy enforcement before execution

### Design
- Coherent control-plane UX with focused operational surfaces
- Product-oriented navigation and observability views

### Potential impact
- Reusable governance model for secure AI tool-calling
- Practical intermediary pattern for sovereign/local agent runtimes

### Insight value
- Surfaces real authorization pain points
- Demonstrates production patterns for agent trust and control

---

## Deployment Notes

### API
- Build: `npm --prefix api run build`
- Run: `npm --prefix api run start`

### Web
- Build: `npm --prefix web run build`
- Preview: `npm --prefix web run preview`

### Database
- For production, use `prisma migrate deploy` in CI/CD.
- Consider moving from SQLite to managed Postgres for scale.

### Security hardening recommendations
- Restrict CORS to known origins.
- Rotate M2M secrets regularly.
- Use separate tenants for dev/staging/prod.
- Enable stricter rate limits per endpoint.

---

## Troubleshooting

### 401 unauthorized from API
- Check `AUTH0_DOMAIN` and `AUTH0_AUDIENCE` consistency across API and web.
- Confirm access token audience matches API config.

### GitHub/Slack token not found
- Verify identity is linked in Auth0.
- Verify configured connection names match your tenant.

### Step-up not activating
- Confirm step-up route is reachable and Auth0 re-auth redirect succeeds.
- Check local storage return-path values during redirect flow.

### Slack events not arriving
- Ensure ngrok tunnel is live.
- Verify signing secret and bot token.
- Reinstall Slack app after scope changes.

---

## Project Structure

```text
api/
	src/
		index.ts
		routes.ts
		tools.ts
		slack-events.ts
		agent/
			engine.ts
			fanout.ts
		services/
			auth0.ts
			github.ts
			llm.ts
			slack.ts
	prisma/
		schema.prisma

web/
	src/
		App.tsx
		api.ts
		components/
			Dashboard.tsx
			AccessSection.tsx
			AllowListSection.tsx
			PoliciesSection.tsx
			AgentPanel.tsx
			AuditSection.tsx
			LlmAuditSection.tsx
```

---

## Roadmap

- More enterprise connectors (Jira, Linear, ServiceNow)
- Background workers for durable async runs
- Streaming audit webhooks and SIEM-friendly export
- Policy templates and environment promotion
- MCP tool registry adapter and fine-grained tool attestation

---

## License

TBD
