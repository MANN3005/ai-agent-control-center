import { z } from "zod";
import { Express } from "express";
import { prisma } from "./db";
import type { AgentRun } from "./types";
import {
  AGENT_RUNS,
  LAST_CONTEXT,
  applySlackAutoFill,
  applyTaskIntentGuards,
  createRunId,
  enqueueAgentRun,
  extractContextFromText,
  formatRunForClient,
  generateAgentPlan,
  getMissingInputQuestion,
  getOrCreateStepRecord,
  getSmallTalkReply,
  normalizeAgentSteps,
  recordPolicyVerdictEntry,
  trace,
  executeToolWithPolicy,
  LLM_AUDIT_LOGS,
} from "./agent/engine";
import {
  getGithubAccessToken,
  getAuth0ManagementClient,
  getAuth0Connections,
  hasGithubIdentity,
  hasSlackIdentity,
} from "./services/auth0";
import { githubListRepos } from "./services/github";
import { getToolIndex, listAllTools } from "./tools";

const LinkAccountBody = z.object({
  primaryUserId: z.string().min(1),
  secondaryUserId: z.string().min(1).optional(),
  provider: z.enum(["github", "slack", "google", "google-oauth2"]).optional(),
});

const UnlinkAccountBody = z.object({
  provider: z.string().min(1),
  providerUserId: z
    .union([z.string(), z.number()])
    .transform((value) => String(value)),
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

const PutAllowedBody = z.object({
  provider: z.enum(["github"]),
  resourceType: z.string().min(1),
  resources: z.array(z.string().min(1)),
});

const StepUpStartBody = z
  .object({
    requestedAtMs: z.number().finite().positive().optional(),
  })
  .optional();

function identityMatchesProvider(
  identity: any,
  provider: "github" | "slack" | "google" | "google-oauth2" | undefined,
  connections: { github: string; google: string; slack: string },
) {
  if (!provider) return true;
  const idProvider = String(identity?.provider || "").toLowerCase();
  const idConnection = String(identity?.connection || "").toLowerCase();
  if (provider === "github") {
    return (
      idProvider === "github" ||
      idConnection === String(connections.github || "").toLowerCase() ||
      idConnection === "github"
    );
  }
  if (provider === "slack") {
    return (
      idProvider === "slack" ||
      (idProvider === "oauth2" && idConnection.includes("slack")) ||
      idConnection === String(connections.slack || "").toLowerCase() ||
      idConnection.includes("slack")
    );
  }
  return (
    idProvider === "google-oauth2" ||
    idProvider === "google" ||
    idConnection === String(connections.google || "").toLowerCase() ||
    idConnection === "google-oauth2" ||
    idConnection === "google"
  );
}

function hasMfaEvidence(payload: any) {
  const amrRaw = payload?.amr;
  const acrRaw = payload?.acr;

  const amr = Array.isArray(amrRaw)
    ? amrRaw.map((v) => String(v).toLowerCase())
    : typeof amrRaw === "string"
      ? [amrRaw.toLowerCase()]
      : [];
  const acr = typeof acrRaw === "string" ? acrRaw.toLowerCase() : "";

  if (amr.includes("mfa")) return true;
  if (
    amr.some((value) =>
      ["otp", "totp", "webauthn", "sms", "push"].includes(value),
    )
  ) {
    return true;
  }
  if (acr.includes("multi-factor") || acr.includes("mfa")) return true;

  return false;
}

function hasFreshReauth(payload: any, requestedAtMs?: number) {
  if (typeof requestedAtMs !== "number" || !Number.isFinite(requestedAtMs)) {
    return false;
  }
  const iatRaw = payload?.iat;
  const iatSeconds = typeof iatRaw === "number" ? iatRaw : Number(iatRaw);
  if (!Number.isFinite(iatSeconds) || iatSeconds <= 0) {
    return false;
  }
  const tokenIssuedAtMs = iatSeconds * 1000;
  const allowedClockSkewMs = 15_000;
  return tokenIssuedAtMs + allowedClockSkewMs >= requestedAtMs;
}

export function registerRoutes(app: Express) {
  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/me", (req, res) => {
    const userId = (req as any).userId as string;
    Promise.all([
      hasGithubIdentity(userId).catch(() => false),
      hasSlackIdentity(userId).catch(() => false),
    ])
      .then(([hasGithub, hasSlack]) =>
        res.json({ userId, hasGithub, hasSlack }),
      )
      .catch(() => res.json({ userId, hasGithub: false, hasSlack: false }));
  });

  app.get("/debug/identities", async (req, res) => {
    const userId = (req as any).userId as string;
    try {
      const client = getAuth0ManagementClient();
      const userResponse: any = await client.users.get({ id: userId });
      const user = userResponse?.data ?? userResponse;
      const identities: any[] = user?.identities ?? [];

      res.json({
        userId,
        identities: identities.map((identity) => ({
          provider: identity?.provider ?? null,
          connection: identity?.connection ?? null,
          userId: identity?.user_id ?? null,
          hasAccessToken: Boolean(identity?.access_token),
        })),
      });
    } catch (err: any) {
      res.status(500).json({
        status: "error",
        reason: err?.message || "Failed to load identities",
      });
    }
  });

  app.post("/auth/link", async (req, res) => {
    const userId = (req as any).userId as string;
    const parsed = LinkAccountBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);

    const { primaryUserId, secondaryUserId, provider } = parsed.data;
    const canLinkFromSecondary = Boolean(
      secondaryUserId && userId === secondaryUserId,
    );
    const canLinkFromPrimary = userId === primaryUserId;
    if (!canLinkFromPrimary && !canLinkFromSecondary) {
      return res.status(403).json({
        status: "denied",
        reason: "Must link from primary or secondary account",
      });
    }

    try {
      const client = getAuth0ManagementClient();
      const primary = await client.users.get({ id: primaryUserId });

      const primaryUser: any = (primary as any)?.data ?? primary;
      const connections = getAuth0Connections();

      const existingOnPrimary = Array.isArray(primaryUser?.identities)
        ? primaryUser.identities.some((id: any) =>
            identityMatchesProvider(id, provider, connections),
          )
        : false;
      if (existingOnPrimary) {
        return res.json({ status: "linked" });
      }

      let secondaryUser: any = null;
      if (secondaryUserId && secondaryUserId !== primaryUserId) {
        const secondary = await client.users.get({ id: secondaryUserId });
        secondaryUser = (secondary as any)?.data ?? secondary;
      }

      const primaryEmail = String(primaryUser?.email || "").toLowerCase();
      const allowWithoutEmail =
        String(process.env.ALLOW_LINK_WITHOUT_EMAIL || "").toLowerCase() ===
        "true";

      if (!secondaryUser && provider && primaryEmail) {
        const response: any = await client.users.getAll({
          q: `email:"${primaryEmail}"`,
          search_engine: "v3",
          per_page: 50,
        } as any);
        const users = response?.data ?? response ?? [];
        if (Array.isArray(users)) {
          secondaryUser = users.find((u: any) => {
            if (!u || u.user_id === primaryUserId) return false;
            const identities = Array.isArray(u.identities) ? u.identities : [];
            return identities.some((id: any) =>
              identityMatchesProvider(id, provider, connections),
            );
          });
        }
      }

      if (!secondaryUser) {
        return res.status(400).json({
          status: "denied",
          reason: "No secondary identity found for provider",
        });
      }

      const secondaryEmail = String(secondaryUser?.email || "").toLowerCase();
      if (primaryEmail && secondaryEmail && primaryEmail !== secondaryEmail) {
        return res
          .status(400)
          .json({ status: "denied", reason: "Emails do not match" });
      }
      if (!primaryEmail && !secondaryEmail && !allowWithoutEmail) {
        return res.status(400).json({
          status: "denied",
          reason:
            "Email missing; enable email scope or set ALLOW_LINK_WITHOUT_EMAIL=true",
        });
      }

      const secondaryIdentity = Array.isArray(secondaryUser?.identities)
        ? secondaryUser.identities.find((id: any) => {
            return identityMatchesProvider(id, provider, connections);
          })
        : null;

      if (!secondaryIdentity) {
        return res.status(400).json({
          status: "denied",
          reason: "Secondary identity not found for provider",
        });
      }

      const existing = Array.isArray(primaryUser?.identities)
        ? primaryUser.identities.some(
            (id: any) =>
              id?.provider === secondaryIdentity.provider &&
              id?.user_id === secondaryIdentity.user_id,
          )
        : false;

      if (existing) {
        return res.json({ status: "linked" });
      }

      await client.users.link(
        { id: primaryUserId },
        {
          provider: secondaryIdentity.provider as any,
          user_id: secondaryIdentity.user_id,
        },
      );

      return res.json({ status: "linked" });
    } catch (err: any) {
      return res
        .status(500)
        .json({ status: "error", reason: err?.message || "Link failed" });
    }
  });

  app.post("/auth/unlink", async (req, res) => {
    const userId = (req as any).userId as string;
    const parsed = UnlinkAccountBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);

    const { provider, providerUserId } = parsed.data;

    try {
      const client = getAuth0ManagementClient();
      await client.users.unlink({
        id: userId,
        provider,
        user_id: providerUserId,
      } as any);

      return res.json({ status: "unlinked" });
    } catch (err: any) {
      return res
        .status(500)
        .json({ status: "error", reason: err?.message || "Unlink failed" });
    }
  });

  app.get("/policies", async (req, res) => {
    const userId = (req as any).userId as string;
    const policies = await prisma.toolPolicy.findMany({ where: { userId } });
    const tools = await listAllTools();

    const merged = new Map<string, any>();
    for (const tool of tools) {
      merged.set(tool.name, {
        userId,
        toolName: tool.name,
        riskLevel: tool.defaultRisk,
        mode: tool.defaultMode,
      });
    }

    for (const policy of policies) {
      merged.set(policy.toolName, policy);
    }

    return res.json(Array.from(merged.values()));
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

  app.put("/allowed-resources", async (req, res) => {
    const userId = (req as any).userId as string;
    const parsed = PutAllowedBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);

    const { provider, resourceType, resources } = parsed.data;

    let normalizedResources = resources
      .map((r) => r.trim())
      .filter((r) => r.length > 0);

    if (
      provider === "github" &&
      resourceType === "repo" &&
      normalizedResources.length
    ) {
      try {
        const githubToken = await getGithubAccessToken(userId);
        const repos = await githubListRepos(githubToken);
        const repoByName = new Map<string, string[]>();

        for (const repo of repos) {
          const fullName = String(repo.fullName || "").trim();
          const shortName = String(repo.name || "")
            .trim()
            .toLowerCase();
          if (!fullName || !shortName) continue;
          const existing = repoByName.get(shortName) || [];
          existing.push(fullName);
          repoByName.set(shortName, existing);
        }

        normalizedResources = normalizedResources.map((value) => {
          if (value.includes("/")) return value;
          const matches = repoByName.get(value.toLowerCase()) || [];
          return matches.length === 1 ? matches[0] : value;
        });
      } catch {
        // If GitHub lookup fails, preserve user-provided values.
      }
    }

    normalizedResources = Array.from(new Set(normalizedResources));

    await prisma.allowedResource.deleteMany({
      where: { userId, provider: provider as any, resourceType },
    });

    if (normalizedResources.length) {
      await prisma.allowedResource.createMany({
        data: normalizedResources.map((r) => ({
          userId,
          provider: provider as any,
          resourceType,
          resourceId: r,
        })),
      });
    }

    res.json({ ok: true, count: normalizedResources.length });
  });

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

  app.post("/step-up/start", async (req, res) => {
    const userId = (req as any).userId as string;
    const payload = (req as any).auth?.payload;

    const parsed = StepUpStartBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json(parsed.error);
    const requestedAtMs = parsed.data?.requestedAtMs;

    const hasMfa = hasMfaEvidence(payload);
    const hasRecentReauth = hasFreshReauth(payload, requestedAtMs);
    if (!hasMfa && !hasRecentReauth) {
      return res.status(403).json({
        status: "denied",
        reason:
          "Step-up denied: no MFA claim and token was not freshly reissued after challenge. Retry step-up.",
      });
    }

    const ttlMs = 2 * 60 * 1000;
    const now = Date.now();

    const session = await prisma.stepUpSession.create({
      data: {
        userId,
        expiresAt: new Date(now + ttlMs),
      },
    });

    res.json({ stepUpId: session.id, expiresAt: session.expiresAt });
  });

  app.post("/tools/execute", async (req, res) => {
    const userId = (req as any).userId as string;
    const body = (req.body ?? {}) as any;

    const requestId =
      typeof body.requestId === "string" ? body.requestId.trim() : "";
    const tool = typeof body.tool === "string" ? body.tool.trim() : "";
    const input =
      body.input && typeof body.input === "object" ? body.input : {};

    const approval = {
      confirmed: Boolean(body.approval?.confirmed),
      stepUpId:
        typeof body.approval?.stepUpId === "string"
          ? body.approval.stepUpId
          : null,
    };

    if (!requestId || !tool) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId: "unknown",
          toolName: tool || "unknown",
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: "Missing required requestId or tool",
          executed: false,
        },
      });
      return res
        .status(400)
        .json({ status: "denied", reason: "Missing requestId or tool" });
    }

    try {
      const response = await executeToolWithPolicy(
        userId,
        requestId,
        tool,
        input,
        approval,
      );
      return res.status(response.statusCode).json(response.body);
    } catch (err: any) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "ERROR",
          reason: err?.message || "Unexpected tool execution failure",
          reasoning: "Unhandled exception in /tools/execute route",
          executed: false,
        },
      });

      return res.status(500).json({
        status: "error",
        reason: err?.message || "Unexpected tool execution failure",
      });
    }
  });

  app.post("/agent/run", async (req, res) => {
    const userId = (req as any).userId as string;
    const body = (req.body ?? {}) as any;
    const requestId =
      typeof body.requestId === "string" ? body.requestId.trim() : "";
    const task = typeof body.task === "string" ? body.task.trim() : "";
    const incomingContext =
      body.context && typeof body.context === "object" ? body.context : {};

    const extracted = extractContextFromText(task);
    const context = {
      ...incomingContext,
      ...extracted,
    };

    if (!requestId || !task) {
      return res.status(400).json({
        status: "denied",
        reason: "Missing requestId or task",
      });
    }

    const smallTalk = getSmallTalkReply(task);
    if (smallTalk) {
      const run: AgentRun = {
        id: createRunId(),
        userId,
        task,
        context,
        status: "COMPLETED" as const,
        plan: [],
        steps: [],
        currentStep: 0,
        pendingStepIndex: null,
        messages: [
          { role: "user", text: task },
          { role: "agent", text: smallTalk },
        ],
        trace: [],
      };

      AGENT_RUNS.set(run.id, run);
      LAST_CONTEXT.set(userId, run.context);
      trace(run, "status", "Small talk reply");
      return res.json({ status: "started", run: formatRunForClient(run) });
    }

    const run: AgentRun = {
      id: createRunId(),
      userId,
      task,
      context,
      status: "PLANNING" as const,
      plan: [],
      steps: [],
      currentStep: 0,
      pendingStepIndex: null,
      messages: [{ role: "user", text: task }],
      trace: [],
    };

    AGENT_RUNS.set(run.id, run);
    LAST_CONTEXT.set(userId, run.context);
    trace(run, "thought", "Planning next steps");

    try {
      const tools = await listAllTools();
      const toolIndex = getToolIndex(tools);
      const plan = await generateAgentPlan(task, context, tools, {
        userId,
        runId: run.id,
        requestId,
      });
      const guardedSteps = applyTaskIntentGuards(task, plan.steps);
      const missing = getMissingInputQuestion(guardedSteps, context, toolIndex);
      if (missing) {
        run.status = "NEEDS_INPUT";
        run.plan = guardedSteps;
        trace(run, "status", "Waiting for user input");
        run.messages.push({ role: "agent", text: missing });
        return res.json({ status: "started", run: formatRunForClient(run) });
      }

      run.plan = normalizeAgentSteps(guardedSteps, context, toolIndex);
      run.status = "RUNNING";
      trace(run, "thought", "Plan ready, executing");
      enqueueAgentRun(run.id);

      return res.json({ status: "started", run: formatRunForClient(run) });
    } catch (err: any) {
      run.status = "ERROR";
      run.lastError = err?.message || "Agent planning failed";
      trace(run, "status", run.lastError ?? "Unknown error");
      run.messages.push({ role: "agent", text: `Error: ${run.lastError}` });
      return res.status(500).json({
        status: "error",
        reason: run.lastError,
        run: formatRunForClient(run),
      });
    }
  });

  app.get("/llm-audit", async (req, res) => {
    const userId = (req as any).userId as string;
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const llmAuditModel = (prisma as any).llmAuditLog;

    if (llmAuditModel) {
      const rows = await llmAuditModel.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      return res.json(
        rows.map((row: any) => ({
          id: row.id,
          userId: row.userId,
          runId: row.runId,
          requestId: row.requestId,
          callType: row.callType,
          model: row.model,
          input: JSON.parse(row.inputJson || "{}"),
          output: JSON.parse(row.outputJson || "{}"),
          createdAt: row.createdAt,
        })),
      );
    }

    const logs = LLM_AUDIT_LOGS.get(userId) || [];
    return res.json(logs.slice(0, limit));
  });

  app.get("/agent/runs/:id", async (req, res) => {
    const userId = (req as any).userId as string;
    const runId = String(req.params.id || "");
    const run = AGENT_RUNS.get(runId);
    if (!run || run.userId !== userId) {
      return res.status(404).json({ status: "not_found" });
    }
    return res.json({ status: "ok", run: formatRunForClient(run) });
  });

  app.post("/agent/continue", async (req, res) => {
    const userId = (req as any).userId as string;
    const body = (req.body ?? {}) as any;
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const approval = {
      confirmed: Boolean(body.approval?.confirmed),
      stepUpId:
        typeof body.approval?.stepUpId === "string"
          ? body.approval.stepUpId
          : null,
    };

    const run = AGENT_RUNS.get(runId);
    if (!run || run.userId !== userId) {
      return res.status(404).json({ status: "not_found" });
    }

    if (message) {
      run.messages.push({ role: "user", text: message });
      const extracted = extractContextFromText(message);
      if (extracted.repo) run.context.repo = extracted.repo;
      if (extracted.repoCandidate)
        run.context.repoCandidate = extracted.repoCandidate;
      if (extracted.issueNumber)
        run.context.issueNumber = extracted.issueNumber;
      if (extracted.issueNumbers)
        run.context.issueNumbers = extracted.issueNumbers;
      if (extracted.state) run.context.state = extracted.state;
      if (extracted.title) run.context.title = extracted.title;
      if (extracted.assignee) run.context.assignee = extracted.assignee;
      if (extracted.assigneeEmail)
        run.context.assigneeEmail = extracted.assigneeEmail;
      if (extracted.channel) run.context.channel = extracted.channel;
      if (extracted.comment) run.context.comment = extracted.comment;
      if (!run.context.title) {
        const lastAgent = run.messages
          .slice()
          .reverse()
          .find((m) => m.role === "agent");
        if (lastAgent?.text?.toLowerCase().includes("issue title")) {
          const cleaned = message.trim().replace(/^['"]|['"]$/g, "");
          if (cleaned) run.context.title = cleaned;
        }
      }
      LAST_CONTEXT.set(userId, run.context);
    }

    if (message) {
      const smallTalk = getSmallTalkReply(message);
      if (smallTalk) {
        run.messages.push({ role: "agent", text: smallTalk });
        trace(run, "status", "Small talk reply");
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }
    }

    if (run.status === "NEEDS_INPUT" && message) {
      trace(run, "thought", "Updating context from user input");
      try {
        const tools = await listAllTools();
        const toolIndex = getToolIndex(tools);
        const plan = await generateAgentPlan(run.task, run.context, tools, {
          userId,
          runId: run.id,
          requestId: `${run.id}:replan`,
        });
        const guardedSteps = applyTaskIntentGuards(run.task, plan.steps);
        const missing = getMissingInputQuestion(
          guardedSteps,
          run.context,
          toolIndex,
        );
        if (missing) {
          run.status = "NEEDS_INPUT";
          run.plan = guardedSteps;
          run.messages.push({ role: "agent", text: missing });
          return res.json({ status: "ok", run: formatRunForClient(run) });
        }

        run.plan = normalizeAgentSteps(guardedSteps, run.context, toolIndex);
        run.steps = [];
        run.currentStep = 0;
        run.pendingStepIndex = null;
        run.status = "RUNNING";
        enqueueAgentRun(run.id);
        return res.json({ status: "ok", run: formatRunForClient(run) });
      } catch (err: any) {
        run.status = "ERROR";
        run.lastError = err?.message || "Agent planning failed";
        run.messages.push({ role: "agent", text: `Error: ${run.lastError}` });
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }
    }

    if (run.status === "WAITING_APPROVAL" && run.pendingStepIndex !== null) {
      const stepIndex = run.pendingStepIndex;
      const step = run.plan[stepIndex];
      const stepRecord = getOrCreateStepRecord(run, stepIndex, step);

      if (!approval.confirmed) {
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }

      await applySlackAutoFill(run, stepIndex);

      const response = await executeToolWithPolicy(
        userId,
        `${run.id}:${stepIndex + 1}`,
        step.tool,
        step.input,
        approval,
      );

      const responseBody = response.body || {};
      const policyVerdict =
        responseBody.status === "executed"
          ? "ALLOWED"
          : responseBody.status === "confirm_required"
            ? "CONFIRM_REQUIRED"
            : responseBody.status === "step_up_required"
              ? "STEP_UP_REQUIRED"
              : response.statusCode >= 400
                ? "ERROR"
                : "BLOCKED";
      recordPolicyVerdictEntry(
        userId,
        `${run.id}:${stepIndex + 1}`,
        step.tool,
        step.input,
        policyVerdict,
        String(responseBody.reason || responseBody.status || "Policy decision"),
      );

      if (
        responseBody.status === "confirm_required" ||
        responseBody.status === "step_up_required"
      ) {
        stepRecord.status = "APPROVAL_REQUIRED";
        stepRecord.result = responseBody;
        stepRecord.reason = responseBody.reason || "Approval required";
        run.status = "WAITING_APPROVAL";
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }

      if (response.statusCode >= 400 && responseBody.status !== "executed") {
        stepRecord.status = "ERROR";
        stepRecord.result = responseBody;
        stepRecord.reason = responseBody.reason || "Agent step failed";
        run.status = "ERROR";
        run.lastError = responseBody.reason || "Agent step failed";
        run.messages.push({ role: "agent", text: `Error: ${run.lastError}` });
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }

      stepRecord.status = "EXECUTED";
      stepRecord.result = responseBody;
      run.pendingStepIndex = null;
      run.currentStep += 1;
      run.status = "RUNNING";
      enqueueAgentRun(run.id);
      return res.json({ status: "ok", run: formatRunForClient(run) });
    }

    return res.json({ status: "ok", run: formatRunForClient(run) });
  });
}
