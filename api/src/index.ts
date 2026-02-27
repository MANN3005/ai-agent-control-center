import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { auth } from "express-oauth2-jwt-bearer";
import { ManagementClient } from "auth0";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";

const prisma = new PrismaClient();
const app = express();

const corsOrigin =
  process.env.CORS_ORIGIN || process.env.WEB_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);
app.use("/agent", agentLimiter);

// ---- Auth0 JWT verification ----
const checkJwt = auth({
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,
  audience: process.env.AUTH0_AUDIENCE,
});

app.use(checkJwt);

app.use((req, _res, next) => {
  const r = req as any;
  r.userId = r.auth?.payload?.sub;
  next();
});

// ---- Tool registry (allow-list) ----
const TOOL_REGISTRY = {
  list_repos: { needsRepo: false },
  list_issues: { needsRepo: true },
  create_issue: { needsRepo: true },
  close_issue: { needsRepo: true },
} as const;

type ToolName = keyof typeof TOOL_REGISTRY;

// ---- Auth0 Management (Token Vault) ----
let auth0ManagementClient: ManagementClient | null = null;
let groqClient: OpenAI | null = null;

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function getAuth0ManagementClient() {
  if (auth0ManagementClient) return auth0ManagementClient;

  const domain = requireEnv("AUTH0_DOMAIN");
  const clientId = requireEnv("AUTH0_M2M_CLIENT_ID");
  const clientSecret = requireEnv("AUTH0_M2M_CLIENT_SECRET");
  const audience =
    process.env.AUTH0_MANAGEMENT_AUDIENCE || `https://${domain}/api/v2/`;

  auth0ManagementClient = new ManagementClient({
    domain,
    clientId,
    clientSecret,
    audience,
    scope: "read:users read:user_idp_tokens",
  });

  return auth0ManagementClient;
}

function getGroqClient() {
  if (groqClient) return groqClient;
  const apiKey = requireEnv("GROQ_API_KEY");
  groqClient = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });
  return groqClient;
}

async function getGithubAccessToken(userId: string) {
  const client = getAuth0ManagementClient();
  const userResponse: any = await client.users.get({ id: userId });
  const user = userResponse?.data ?? userResponse;
  const identities: any[] = user?.identities ?? [];
  const githubIdentity = identities.find(
    (identity) => identity?.provider === "github",
  );
  const accessToken = githubIdentity?.access_token;

  if (!accessToken) {
    throw new Error("GitHub identity not connected in Auth0 Token Vault");
  }

  return accessToken as string;
}

async function hasGithubIdentity(userId: string) {
  const client = getAuth0ManagementClient();
  const userResponse: any = await client.users.get({ id: userId });
  const user = userResponse?.data ?? userResponse;
  const identities: any[] = user?.identities ?? [];
  return identities.some((identity) => identity?.provider === "github");
}

function parseRepo(repo: string) {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error("Invalid repo format. Expected owner/repo");
  }
  return { owner, name };
}

async function githubRequest<T>(
  accessToken: string,
  url: string,
  init?: RequestInit,
) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ai-agent-control-center",
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!res.ok) {
    const message = data?.message || `GitHub API error ${res.status}`;
    throw new Error(message);
  }

  return data as T;
}

async function githubListIssues(
  accessToken: string,
  owner: string,
  repo: string,
  state: string,
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}`;
  const items = await githubRequest<any[]>(accessToken, url);
  const issues = items.filter((i) => !i.pull_request);

  return issues.map((i) => ({
    id: i.id,
    number: i.number,
    title: i.title,
    state: i.state,
    htmlUrl: i.html_url,
    user: i.user?.login ?? null,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  }));
}

async function githubCreateIssue(
  accessToken: string,
  owner: string,
  repo: string,
  title: string,
  body?: string,
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues`;
  const created = await githubRequest<any>(accessToken, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  });

  return {
    id: created.id,
    number: created.number,
    title: created.title,
    state: created.state,
    htmlUrl: created.html_url,
  };
}

async function githubCloseIssue(
  accessToken: string,
  owner: string,
  repo: string,
  issueNumber: number,
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
  const updated = await githubRequest<any>(accessToken, url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });

  return {
    id: updated.id,
    number: updated.number,
    title: updated.title,
    state: updated.state,
    htmlUrl: updated.html_url,
  };
}

async function githubListRepos(accessToken: string) {
  const url = "https://api.github.com/user/repos?per_page=100&sort=updated";
  const repos = await githubRequest<any[]>(accessToken, url);

  return repos.map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    htmlUrl: r.html_url,
    owner: r.owner?.login ?? null,
    updatedAt: r.updated_at,
  }));
}

type AgentStep = { tool: ToolName; input: Record<string, any> };

async function generateAgentPlan(task: string, context: Record<string, any>) {
  const client = getGroqClient();
  const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";

  const system =
    "You are a careful tool planner. Only output JSON with a top-level 'steps' array. " +
    "Each step must have 'tool' and 'input'. Tools allowed: list_repos, list_issues, create_issue, close_issue. " +
    "If a tool needs repo and none is provided, include input.repo as 'OWNER/REPO'. " +
    "Use input fields: repo, state (open|closed|all), title, body, issueNumber. " +
    "Never use issueNumber 0. Only use close_issue when you have a valid issueNumber. " +
    "Only use create_issue if the task explicitly asks to create a new issue.";

  const user = JSON.stringify({ task, context });

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  const content = completion.choices[0]?.message?.content || "";
  let parsed: any = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Agent returned invalid JSON");
  }

  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error("Agent plan missing steps");
  }

  return parsed.steps as AgentStep[];
}

function normalizeAgentSteps(steps: AgentStep[], context: Record<string, any>) {
  const normalized: AgentStep[] = [];
  for (const step of steps) {
    const tool = step?.tool as ToolName;
    if (!tool || !(tool in TOOL_REGISTRY)) {
      throw new Error("Agent selected an unsupported tool");
    }

    const input =
      step?.input && typeof step.input === "object" ? step.input : {};

    if (TOOL_REGISTRY[tool].needsRepo) {
      if (!input.repo && context.repo) input.repo = context.repo;
      if (!input.repo) {
        throw new Error("Missing repo for repo-scoped tool");
      }
    }

    if (tool === "close_issue" && !input.issueNumber && context.issueNumber) {
      input.issueNumber = context.issueNumber;
    }

    if (tool === "close_issue") {
      const issueNumber = Number(input.issueNumber);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error("Missing or invalid issueNumber for close_issue");
      }
    }

    if (tool === "create_issue") {
      if (!input.title && context.title) input.title = context.title;
      if (!input.body && context.body) input.body = context.body;
    }

    if (tool === "list_issues" && !input.state && context.state) {
      input.state = context.state;
    }

    normalized.push({ tool, input });
  }

  return normalized;
}

async function executeToolWithPolicy(
  userId: string,
  requestId: string,
  tool: ToolName,
  input: Record<string, any>,
  approval: { confirmed: boolean; stepUpId: string | null },
) {
  const toolInfo = TOOL_REGISTRY[tool as ToolName];
  if (!toolInfo) {
    await prisma.auditLog.create({
      data: {
        userId,
        requestId,
        toolName: tool,
        inputJson: JSON.stringify(input),
        decision: "DENIED",
        reason: "Tool not in registry allow-list",
        executed: false,
      },
    });
    return {
      statusCode: 400,
      body: { status: "denied", reason: "Tool not allowed" },
    };
  }

  const existingPolicy = await prisma.toolPolicy.findUnique({
    where: { userId_toolName: { userId, toolName: tool } },
  });

  const defaultPolicy = (() => {
    if (tool === "create_issue")
      return { riskLevel: "MEDIUM", mode: "CONFIRM" } as const;
    if (tool === "close_issue")
      return { riskLevel: "HIGH", mode: "STEP_UP" } as const;
    return { riskLevel: "LOW", mode: "AUTO" } as const;
  })();

  const policy = existingPolicy ?? {
    userId,
    toolName: tool,
    riskLevel: defaultPolicy.riskLevel as any,
    mode: defaultPolicy.mode as any,
  };

  // Repo allow-list enforcement
  if (toolInfo.needsRepo) {
    const repo = String((input as any).repo || "");
    if (!repo) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: "Missing required input.repo",
          executed: false,
        },
      });
      return {
        statusCode: 400,
        body: { status: "denied", reason: "Missing repo" },
      };
    }

    const allowed = await prisma.allowedResource.findUnique({
      where: {
        userId_provider_resourceType_resourceId: {
          userId,
          provider: "github",
          resourceType: "repo",
          resourceId: repo,
        },
      },
    });

    if (!allowed) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: `Repo not allow-listed: ${repo}`,
          executed: false,
        },
      });
      return {
        statusCode: 403,
        body: { status: "denied", reason: "Repo not allow-listed" },
      };
    }
  }

  // Policy enforcement
  if (policy.mode === "CONFIRM" && !approval.confirmed) {
    await prisma.auditLog.create({
      data: {
        userId,
        requestId,
        toolName: tool,
        inputJson: JSON.stringify(input),
        decision: "CONFIRM_REQUIRED",
        reason: "Policy requires confirmation",
        executed: false,
      },
    });
    return {
      statusCode: 200,
      body: {
        status: "confirm_required",
        preview: { tool, input },
        reason: "Confirmation required",
      },
    };
  }

  if (policy.mode === "STEP_UP") {
    let stepUpId = approval.stepUpId;
    if (!stepUpId) {
      const now = new Date();
      const latestSession = await prisma.stepUpSession.findFirst({
        where: { userId, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
      });
      if (latestSession) stepUpId = latestSession.id;
    }

    if (!stepUpId) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "STEP_UP_REQUIRED",
          reason: "Policy requires step-up",
          executed: false,
        },
      });
      return {
        statusCode: 200,
        body: { status: "step_up_required", reason: "Step-up required" },
      };
    }

    const session = await prisma.stepUpSession.findUnique({
      where: { id: stepUpId },
    });
    const now = new Date();
    const valid =
      session && session.userId === userId && session.expiresAt > now;

    if (!valid) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "STEP_UP_REQUIRED",
          reason: "Invalid or expired step-up session",
          executed: false,
        },
      });
      return {
        statusCode: 200,
        body: {
          status: "step_up_required",
          reason: "Step-up expired or invalid",
        },
      };
    }

    if (!approval.confirmed) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "CONFIRM_REQUIRED",
          reason: "High risk tool requires confirmation",
          executed: false,
        },
      });
      return {
        statusCode: 200,
        body: {
          status: "confirm_required",
          preview: { tool, input },
          reason: "Confirmation required for high-risk action",
        },
      };
    }
  }

  if (toolInfo.needsRepo) {
    const repo = String((input as any).repo || "");
    try {
      parseRepo(repo);
    } catch (err: any) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: err?.message || "Invalid repo format",
          executed: false,
        },
      });
      return {
        statusCode: 400,
        body: { status: "denied", reason: err?.message },
      };
    }
  }

  if (tool === "create_issue") {
    const title = String((input as any).title || "");
    if (!title) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: "Missing required input.title",
          executed: false,
        },
      });
      return {
        statusCode: 400,
        body: { status: "denied", reason: "Missing title" },
      };
    }
  }

  if (tool === "close_issue") {
    const issueNumber = Number((input as any).issueNumber);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: "Missing or invalid input.issueNumber",
          executed: false,
        },
      });
      return {
        statusCode: 400,
        body: { status: "denied", reason: "Invalid issueNumber" },
      };
    }
  }

  if (tool === "list_issues") {
    const state = String((input as any).state || "open");
    if (!"open|closed|all".split("|").includes(state)) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: "Invalid input.state; expected open, closed, or all",
          executed: false,
        },
      });
      return {
        statusCode: 400,
        body: { status: "denied", reason: "Invalid state" },
      };
    }
  }

  try {
    let result: any = null;

    if (tool === "list_issues") {
      const accessToken = await getGithubAccessToken(userId);
      const repo = String((input as any).repo || "");
      const { owner, name } = parseRepo(repo);
      const state = String((input as any).state || "open");
      const issues = await githubListIssues(accessToken, owner, name, state);
      result = { issues };
    } else if (tool === "list_repos") {
      const accessToken = await getGithubAccessToken(userId);
      const repos = await githubListRepos(accessToken);
      result = { repos };
    } else if (tool === "create_issue") {
      const accessToken = await getGithubAccessToken(userId);
      const repo = String((input as any).repo || "");
      const { owner, name } = parseRepo(repo);
      const title = String((input as any).title || "");
      const body = (input as any).body
        ? String((input as any).body)
        : undefined;
      const issue = await githubCreateIssue(
        accessToken,
        owner,
        name,
        title,
        body,
      );
      result = { issue };
    } else if (tool === "close_issue") {
      const accessToken = await getGithubAccessToken(userId);
      const repo = String((input as any).repo || "");
      const { owner, name } = parseRepo(repo);
      const issueNumber = Number((input as any).issueNumber);
      const issue = await githubCloseIssue(
        accessToken,
        owner,
        name,
        issueNumber,
      );
      result = { issue };
    } else {
      result = { ok: true, executedTool: tool, input };
    }

    await prisma.auditLog.create({
      data: {
        userId,
        requestId,
        toolName: tool,
        inputJson: JSON.stringify(input),
        decision: "ALLOWED",
        reason: "Executed",
        executed: true,
        resultJson: JSON.stringify(result),
      },
    });

    return { statusCode: 200, body: { status: "executed", result } };
  } catch (err: any) {
    await prisma.auditLog.create({
      data: {
        userId,
        requestId,
        toolName: tool,
        inputJson: JSON.stringify(input),
        decision: "ERROR",
        reason: err?.message || "Execution failed",
        executed: false,
      },
    });

    return {
      statusCode: 500,
      body: { status: "error", reason: err?.message || "Execution failed" },
    };
  }
}

// ---- Routes ----
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/me", (req, res) => {
  const userId = (req as any).userId as string;
  hasGithubIdentity(userId)
    .then((hasGithub) => res.json({ userId, hasGithub }))
    .catch(() => res.json({ userId, hasGithub: false }));
});

// ---------- Policies ----------
app.get("/policies", async (req, res) => {
  const userId = (req as any).userId as string;
  const policies = await prisma.toolPolicy.findMany({ where: { userId } });
  res.json(policies);
});

const PutPoliciesBody = z.object({
  policies: z.array(
    z.object({
      toolName: z.string().min(1),
      riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
      mode: z.enum(["AUTO", "CONFIRM", "STEP_UP"]),
    }),
  ),
});

app.put("/policies", async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = PutPoliciesBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const ops = parsed.data.policies.map((p) =>
    prisma.toolPolicy.upsert({
      where: { userId_toolName: { userId, toolName: p.toolName } },
      update: { riskLevel: p.riskLevel as any, mode: p.mode as any },
      create: {
        userId,
        toolName: p.toolName,
        riskLevel: p.riskLevel as any,
        mode: p.mode as any,
      },
    }),
  );

  await prisma.$transaction(ops);

  const updated = await prisma.toolPolicy.findMany({ where: { userId } });
  res.json(updated);
});

// ---------- Allowed resources (repo allow-list) ----------
app.get("/allowed-resources", async (req, res) => {
  const userId = (req as any).userId as string;
  const provider = String(req.query.provider || "github");
  const resourceType = String(req.query.resourceType || "repo");

  const items = await prisma.allowedResource.findMany({
    where: { userId, provider: provider as any, resourceType },
    orderBy: { createdAt: "desc" },
  });

  res.json(items.map((i) => i.resourceId));
});

const PutAllowedBody = z.object({
  provider: z.enum(["github"]),
  resourceType: z.string().min(1),
  resources: z.array(z.string().min(1)),
});

app.put("/allowed-resources", async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = PutAllowedBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const { provider, resourceType, resources } = parsed.data;

  await prisma.allowedResource.deleteMany({
    where: { userId, provider: provider as any, resourceType },
  });

  if (resources.length) {
    await prisma.allowedResource.createMany({
      data: resources.map((r) => ({
        userId,
        provider: provider as any,
        resourceType,
        resourceId: r,
      })),
    });
  }

  res.json({ ok: true, count: resources.length });
});

// ---------- Audit ----------
app.get("/audit", async (req, res) => {
  const userId = (req as any).userId as string;
  const limit = Math.min(Number(req.query.limit || 50), 200);

  const logs = await prisma.auditLog.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json(
    logs.map((l) => ({
      ...l,
      inputJson: JSON.parse(l.inputJson),
      resultJson: l.resultJson ? JSON.parse(l.resultJson) : null,
    })),
  );
});

// ---------- Step-up ----------
app.post("/step-up/start", async (req, res) => {
  const userId = (req as any).userId as string;
  const ttlMs = 2 * 60 * 1000; // 2 minutes
  const now = Date.now();

  const session = await prisma.stepUpSession.create({
    data: {
      userId,
      expiresAt: new Date(now + ttlMs),
    },
  });

  res.json({ stepUpId: session.id, expiresAt: session.expiresAt });
});

// ---------- Tool execute ----------
app.post("/tools/execute", async (req, res) => {
  const userId = (req as any).userId as string;
  const body = (req.body ?? {}) as any;

  const requestId =
    typeof body.requestId === "string" ? body.requestId.trim() : "";
  const tool = typeof body.tool === "string" ? body.tool : "";
  const input = body.input && typeof body.input === "object" ? body.input : {};

  const approval = {
    confirmed: Boolean(body.approval?.confirmed),
    stepUpId:
      typeof body.approval?.stepUpId === "string"
        ? body.approval.stepUpId
        : null,
  };

  if (!requestId) {
    await prisma.auditLog.create({
      data: {
        userId,
        requestId: "unknown",
        toolName: tool || "unknown",
        inputJson: JSON.stringify(input),
        decision: "DENIED",
        reason: "Missing required requestId",
        executed: false,
      },
    });
    return res
      .status(400)
      .json({ status: "denied", reason: "Missing requestId" });
  }
  const response = await executeToolWithPolicy(
    userId,
    requestId,
    tool as ToolName,
    input,
    approval,
  );
  return res.status(response.statusCode).json(response.body);
});

// ---------- Agent run ----------
app.post("/agent/run", async (req, res) => {
  const userId = (req as any).userId as string;
  const body = (req.body ?? {}) as any;
  const requestId =
    typeof body.requestId === "string" ? body.requestId.trim() : "";
  const task = typeof body.task === "string" ? body.task.trim() : "";
  const context =
    body.context && typeof body.context === "object" ? body.context : {};

  if (!context.repo) {
    const repoMatch = task.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
    if (repoMatch) context.repo = repoMatch[1];
  }

  if (!context.issueNumber) {
    const issueMatch = task.match(/issue\s+#?(\d+)/i);
    if (issueMatch) context.issueNumber = Number(issueMatch[1]);
  }

  if (!requestId || !task) {
    return res.status(400).json({
      status: "denied",
      reason: "Missing requestId or task",
    });
  }

  try {
    const rawSteps = await generateAgentPlan(task, context);
    const steps = normalizeAgentSteps(rawSteps, context);
    const results: any[] = [];

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const stepRequestId = `${requestId}:${i + 1}`;
      const response = await executeToolWithPolicy(
        userId,
        stepRequestId,
        step.tool,
        step.input,
        {
          confirmed: false,
          stepUpId: null,
        },
      );

      results.push({ step, response: response.body });

      if (
        response.body.status === "confirm_required" ||
        response.body.status === "step_up_required"
      ) {
        return res.json({
          status: "approval_required",
          stepIndex: i,
          step,
          response: response.body,
          steps,
          results,
        });
      }

      if (response.statusCode >= 400 && response.body.status !== "executed") {
        return res.status(response.statusCode).json({
          status: "error",
          reason: response.body.reason || "Agent step failed",
          stepIndex: i,
          step,
          results,
        });
      }
    }

    return res.json({ status: "completed", steps, results });
  } catch (err: any) {
    return res.status(500).json({
      status: "error",
      reason: err?.message || "Agent planning failed",
    });
  }
});

// ---------- Agent continue ----------
app.post("/agent/continue", async (req, res) => {
  const userId = (req as any).userId as string;
  const body = (req.body ?? {}) as any;
  const requestId =
    typeof body.requestId === "string" ? body.requestId.trim() : "";
  const stepIndex = Number.isInteger(body.stepIndex) ? body.stepIndex : -1;
  const steps = Array.isArray(body.steps) ? body.steps : [];
  const approval = {
    confirmed: Boolean(body.approval?.confirmed),
    stepUpId:
      typeof body.approval?.stepUpId === "string"
        ? body.approval.stepUpId
        : null,
  };

  if (!requestId || stepIndex < 0 || !steps.length) {
    return res.status(400).json({
      status: "denied",
      reason: "Missing requestId, stepIndex, or steps",
    });
  }

  try {
    const normalizedSteps = normalizeAgentSteps(steps as AgentStep[], {});
    const results: any[] = [];

    for (let i = stepIndex; i < normalizedSteps.length; i += 1) {
      const step = normalizedSteps[i];
      const stepRequestId = `${requestId}:${i + 1}`;
      const response = await executeToolWithPolicy(
        userId,
        stepRequestId,
        step.tool,
        step.input,
        i === stepIndex ? approval : { confirmed: false, stepUpId: null },
      );

      results.push({ step, response: response.body });

      if (
        response.body.status === "confirm_required" ||
        response.body.status === "step_up_required"
      ) {
        return res.json({
          status: "approval_required",
          stepIndex: i,
          step,
          response: response.body,
          steps: normalizedSteps,
          results,
        });
      }

      if (response.statusCode >= 400 && response.body.status !== "executed") {
        return res.status(response.statusCode).json({
          status: "error",
          reason: response.body.reason || "Agent step failed",
          stepIndex: i,
          step,
          steps: normalizedSteps,
          results,
        });
      }
    }

    return res.json({ status: "completed", steps: normalizedSteps, results });
  } catch (err: any) {
    return res.status(500).json({
      status: "error",
      reason: err?.message || "Agent continuation failed",
    });
  }
});

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
