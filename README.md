# AI Agent Control Center

This project is a secure control plane for AI agents that act on GitHub on a user’s behalf. It lets a user connect their GitHub identity via Auth0, define explicit permissions (allow-listed repos), set risk-based policies, and then run tool calls or agent tasks that are enforced and audited.

In short: it is a **policy-gated GitHub agent** with **step-up authentication** and **audit trails**.

## What the project does (end-to-end)
1) The user logs in with Auth0 (optionally connects GitHub).
2) The user allow-lists GitHub repos the agent is permitted to access.
3) The user sets tool policies (AUTO, CONFIRM, STEP_UP) per tool.
4) The user runs a tool directly or submits a natural language task to the agent.
5) The backend enforces allow-lists and policy rules, then executes the tool.
6) Every decision (allowed/denied/step-up) is recorded in the audit log.

## Tools currently supported
- list_repos
- list_issues
- create_issue
- close_issue

These are executed through GitHub’s API using a user token retrieved from the Auth0 Token Vault.

## Agent behavior (current)
The agent uses an LLM to plan tool calls for a task. If the plan hits a CONFIRM or STEP_UP policy, the UI asks for approval before continuing. This demonstrates **secure tool calling** instead of unrestricted autonomous action.

## Security model
- **Allow-listing**: repo-scoped tools are denied unless the repo is explicitly allowed.
- **Policy modes**:
	- AUTO executes immediately
	- CONFIRM requires user approval
	- STEP_UP requires a fresh step-up session + approval
- **Audit log**: every request records tool, input, decision, and result.

## API and UI overview

### API endpoints (current)
- GET /health
- GET /me
- GET /policies
- PUT /policies
- GET /allowed-resources
- PUT /allowed-resources
- POST /step-up/start
- POST /tools/execute
- POST /agent/run
- POST /agent/continue
- GET /audit

### UI screens
- Home: overview stats
- Allow-list: manage allowed GitHub repos
- Policies: set risk and mode per tool
- Tools: manual execution
- Agent: task-based execution with approvals
- Audit: decision history

## Tech stack
- API: Node + Express + Prisma + SQLite
- Web: React + Vite
- Auth: Auth0 (JWT + Token Vault)
- LLM: Groq API (OpenAI-compatible)

## Project structure
- API server: [api/src/index.ts](api/src/index.ts)
- Prisma schema: [api/prisma/schema.prisma](api/prisma/schema.prisma)
- Web app: [web/src/App.tsx](web/src/App.tsx)

## Quickstart

### 1) Install dependencies
```bash
npm install
cd api && npm install
cd ../web && npm install
```

### 2) Configure environment
Create an .env file in api with values for Auth0 and Groq.

Example:
```bash
AUTH0_DOMAIN=YOUR_AUTH0_DOMAIN
AUTH0_AUDIENCE=YOUR_AUTH0_AUDIENCE
AUTH0_M2M_CLIENT_ID=YOUR_M2M_CLIENT_ID
AUTH0_M2M_CLIENT_SECRET=YOUR_M2M_CLIENT_SECRET
AUTH0_MANAGEMENT_AUDIENCE=https://YOUR_AUTH0_DOMAIN/api/v2/
GROQ_API_KEY=YOUR_GROQ_API_KEY
GROQ_MODEL=llama-3.1-70b-versatile
WEB_ORIGIN=http://localhost:5173
```

### 3) Database
```bash
cd api
npx prisma migrate dev
```

### 4) Run the apps
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
1) Login and connect GitHub
2) Allow-list a repo
3) Set create_issue to CONFIRM and close_issue to STEP_UP
4) Run an agent task like: “List open issues and create a summary issue.”
5) Approve actions when prompted
6) Review the audit log

## Hackathon alignment (Auth0 Authorized to Act)
- Security Model: explicit permission boundaries, step-up for high risk
- User Control: visible policy modes and approvals
- Technical Execution: Token Vault usage and auditability
- Design: balanced frontend and backend
- Insight Value: demonstrates safe agent patterns

## Future improvements
- Add more tool connectors (Slack, Jira, Linear)
- Persist agent runs and steps
- Add async worker for long-running runs
- MCP tool registry adapter

## License
TBD