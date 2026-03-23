import { z } from "zod";
import { Express } from "express";
import { prisma } from "./db";
import type { AgentRun } from "./types";
import {
  AGENT_RUNS,
  LAST_CONTEXT,
  applySlackAutoFill,
  createRunId,
  enqueueAgentRun,
  extractContextFromText,
  formatRunForClient,
  generateAgentPlan,
  getGithubUsernameFromVault,
  getMissingInputQuestion,
  getOrCreateStepRecord,
  getSmallTalkReply,
  getToolAwareValidationPrompt,
  normalizeAgentSteps,
  parsePendingFieldAnswer,
  trace,
  executeToolWithPolicy,
} from "./agent/engine";
import { extractFieldsFromText } from "./agent/contextExtractor";
import { normalizeFields, resolveRepoFields } from "./agent/fieldRegistry";
import { rectify } from "./agent/rectify";
import { validateAllSteps } from "./agent/validator";
import {
  getAuth0ManagementClient,
  getAuth0Connections,
  hasGithubIdentity,
  hasSlackIdentity,
} from "./services/auth0";
import { getToolIndex, listAllTools } from "./tools";

const LinkAccountBody = z.object({
  primaryUserId: z.string().min(1),
  secondaryUserId: z.string().min(1),
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
    if (userId !== secondaryUserId) {
      return res
        .status(403)
        .json({ status: "denied", reason: "Must link from secondary account" });
    }

    try {
      const client = getAuth0ManagementClient();
      const primary = await client.users.get({ id: primaryUserId });
      const secondary = await client.users.get({ id: secondaryUserId });

      const primaryUser: any = (primary as any)?.data ?? primary;
      const secondaryUser: any = (secondary as any)?.data ?? secondary;

      const primaryEmail = String(primaryUser?.email || "").toLowerCase();
      const secondaryEmail = String(secondaryUser?.email || "").toLowerCase();
      const allowWithoutEmail =
        String(process.env.ALLOW_LINK_WITHOUT_EMAIL || "").toLowerCase() ===
        "true";

      if (primaryEmail && secondaryEmail) {
        if (primaryEmail !== secondaryEmail) {
          return res
            .status(400)
            .json({ status: "denied", reason: "Emails do not match" });
        }
      } else if (!allowWithoutEmail) {
        return res.status(400).json({
          status: "denied",
          reason:
            "Email missing; enable email scope or set ALLOW_LINK_WITHOUT_EMAIL=true",
        });
      }

      const connections = getAuth0Connections();
      const secondaryIdentity = Array.isArray(secondaryUser?.identities)
        ? secondaryUser.identities.find((id: any) => {
            if (!provider) return true;
            if (provider === "github") {
              return (
                id?.provider === "github" ||
                id?.connection === connections.github
              );
            }
            if (provider === "google" || provider === "google-oauth2") {
              return (
                id?.provider === "google-oauth2" ||
                id?.connection === connections.google
              );
            }
            return (
              id?.provider === "slack" || id?.connection === connections.slack
            );
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
    res.json(policies);
  });

  app.get("/tools", async (req, res) => {
    const userId = (req as any).userId as string;
    try {
      const tools = await listAllTools(userId);
      res.json(
        tools.map((tool) => ({
          toolName: tool.name,
          needsRepo: tool.needsRepo,
          defaultRisk: tool.defaultRisk,
          defaultMode: tool.defaultMode,
          description: tool.description || null,
        })),
      );
    } catch (err: any) {
      res.status(500).json({
        status: "error",
        reason: err?.message || "Failed to load tools",
      });
    }
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
    const response = await executeToolWithPolicy(
      userId,
      requestId,
      tool,
      input,
      approval,
    );
    return res.status(response.statusCode).json(response.body);
  });

  app.post("/agent/run", async (req, res) => {
    const userId = (req as any).userId as string;
    const body = (req.body ?? {}) as any;
    const requestId =
      typeof body.requestId === "string" ? body.requestId.trim() : "";
    const task = typeof body.task === "string" ? body.task.trim() : "";
    const incomingContext =
      body.context && typeof body.context === "object" ? body.context : {};

    const previousContext = LAST_CONTEXT.get(userId) || {};
    const extracted = extractContextFromText(task);
    const textExtractedContext = resolveRepoFields(
      normalizeFields(extractFieldsFromText(task) as Record<string, any>),
    );
    const context = {
      ...previousContext,
      ...incomingContext,
      ...extracted,
      textExtractedContext: {
        ...(previousContext.textExtractedContext || {}),
        ...textExtractedContext,
      },
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
        pendingFieldCapture: null,
        pendingRectify: null,
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
      pendingFieldCapture: null,
      pendingRectify: null,
      messages: [{ role: "user", text: task }],
      trace: [],
    };

    AGENT_RUNS.set(run.id, run);
    LAST_CONTEXT.set(userId, run.context);
    trace(run, "thought", "Planning next steps");

    try {
      const tools = await listAllTools(userId);
      const toolIndex = getToolIndex(tools);
      const plan = await generateAgentPlan(task, context, tools, userId);

      if (!plan.steps.length) {
        run.status = "NEEDS_INPUT";
        run.plan = [];
        trace(run, "status", "Planner requested more input");
        run.messages.push({
          role: "agent",
          text:
            plan.question ||
            "I need one required input to proceed. Please provide more details.",
        });
        return res.json({ status: "started", run: formatRunForClient(run) });
      }

      run.plan = normalizeAgentSteps(plan.steps, context, toolIndex);
      const validation = validateAllSteps(run.plan, tools);
      if (!validation.valid) {
        run.status = "NEEDS_INPUT";
        run.pendingFieldCapture = {
          field: String(validation.missingField || ""),
          stepIndex: Number(validation.stepIndex || 0),
          frozenSteps: run.plan.map((step) => ({ ...step, input: { ...step.input } })),
        };
        trace(run, "status", "Waiting for user input");
        run.messages.push({
          role: "agent",
          text:
            validation.missingFieldQuestion ||
            `I need ${validation.missingField} to proceed.`,
        });
        return res.json({ status: "started", run: formatRunForClient(run) });
      }

      run.pendingFieldCapture = null;
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
      const textExtracted = resolveRepoFields(
        normalizeFields(extractFieldsFromText(message) as Record<string, any>),
      );
      run.context.followUpText = message.trim();
      run.context.textExtractedContext = {
        ...(run.context.textExtractedContext || {}),
        ...textExtracted,
      };
      const lastAgent = run.messages
        .slice()
        .reverse()
        .find((m) => m.role === "agent");
      const agentAskedForGithubIdentity = Boolean(
        lastAgent?.text
          ?.toLowerCase()
          .match(/github\s+(username|account|organization)|parameter named 'query'|provide.*query/),
      );
      const bareUsername = message.trim().match(/^[A-Za-z0-9-]{2,39}$/);

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
      if ((extracted as any).action) run.context.action = (extracted as any).action;
      if (extracted.githubUsername)
        run.context.githubUsername = extracted.githubUsername;
      if (extracted.githubOrg)
        run.context.githubOrg = extracted.githubOrg;
      if (extracted.owner) run.context.owner = extracted.owner;
      if ((extracted as any).query) run.context.query = (extracted as any).query;

      if (agentAskedForGithubIdentity && bareUsername) {
        const username = bareUsername[0];
        run.context.githubUsername = username;
        run.context.owner = username;
        run.context.query = `user:${username}`;
      }

      if (!run.context.title) {
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

    if (run.status === "NEEDS_INPUT" && message && run.pendingFieldCapture) {
      const tools = await listAllTools(userId);
      const capture = run.pendingFieldCapture;
      const frozenSteps = capture.frozenSteps.map((step) => ({
        ...step,
        input: { ...step.input },
      }));

      const step = frozenSteps[capture.stepIndex];
      if (!step) {
        run.pendingFieldCapture = null;
      } else {
        step.input[capture.field] = parsePendingFieldAnswer(capture.field, message);
        step.input = resolveRepoFields(normalizeFields(step.input));

        const validation = validateAllSteps(frozenSteps, tools);
        if (!validation.valid) {
          run.pendingFieldCapture = {
            field: String(validation.missingField || ""),
            stepIndex: Number(validation.stepIndex || 0),
            frozenSteps,
          };
          run.status = "NEEDS_INPUT";
          run.plan = frozenSteps;
          run.messages.push({
            role: "agent",
            text:
              validation.missingFieldQuestion ||
              `I need ${validation.missingField} to proceed.`,
          });
          return res.json({ status: "ok", run: formatRunForClient(run) });
        }

        run.pendingFieldCapture = null;
        run.plan = frozenSteps;
        run.steps = [];
        run.currentStep = 0;
        run.pendingStepIndex = null;
        run.status = "RUNNING";
        enqueueAgentRun(run.id);
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }
    }

    if (run.status === "NEEDS_INPUT" && message && run.pendingRectify) {
      const capture = run.pendingRectify;
      const frozenToolCall = {
        tool: String(capture.frozenToolCall.tool || ""),
        input: { ...(capture.frozenToolCall.input || {}) },
      };

      let parsedAnswer: any = message.trim();
      if (
        capture.missingField === "issue_number" ||
        capture.missingField === "pull_number"
      ) {
        const numeric = parseInt(parsedAnswer.replace(/[^0-9]/g, ""), 10);
        if (!Number.isNaN(numeric)) parsedAnswer = numeric;
      }

      frozenToolCall.input[capture.missingField] = parsedAnswer;
      run.pendingRectify = null;

      const githubUsername = await getGithubUsernameFromVault(userId);
      const retried = rectify(frozenToolCall, message, githubUsername || undefined);

      if (retried.type === "NEEDS_INPUT") {
        run.pendingRectify = {
          frozenToolCall: retried.frozenToolCall || frozenToolCall,
          missingField: String(retried.missingField || ""),
        };
        run.status = "NEEDS_INPUT";
        run.messages.push({
          role: "agent",
          text:
            retried.question ||
            `I need ${retried.missingField || "additional input"} to proceed.`,
        });
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }

      if (retried.toolCall) {
        run.plan = [
          {
            tool: retried.toolCall.tool,
            input: retried.toolCall.input,
          },
        ];
      }

      run.pendingFieldCapture = null;
      run.steps = [];
      run.currentStep = 0;
      run.pendingStepIndex = null;
      run.status = "RUNNING";
      enqueueAgentRun(run.id);
      return res.json({ status: "ok", run: formatRunForClient(run) });
    }

    if (run.status === "NEEDS_INPUT" && message) {
      trace(run, "thought", "Updating context from user input");
      try {
        const tools = await listAllTools(userId);
        const toolIndex = getToolIndex(tools);
        const plan = await generateAgentPlan(
          run.task,
          run.context,
          tools,
          userId,
        );

        if (!plan.steps.length) {
          run.status = "NEEDS_INPUT";
          run.plan = [];
          run.messages.push({
            role: "agent",
            text:
              plan.question ||
              "I still need one required input to continue. Please provide more details.",
          });
          return res.json({ status: "ok", run: formatRunForClient(run) });
        }

        run.plan = normalizeAgentSteps(plan.steps, run.context, toolIndex);
        const validation = validateAllSteps(run.plan, tools);
        if (!validation.valid) {
          run.status = "NEEDS_INPUT";
          run.pendingFieldCapture = {
            field: String(validation.missingField || ""),
            stepIndex: Number(validation.stepIndex || 0),
            frozenSteps: run.plan.map((step) => ({ ...step, input: { ...step.input } })),
          };
          run.messages.push({
            role: "agent",
            text:
              validation.missingFieldQuestion ||
              `I need ${validation.missingField} to proceed.`,
          });
          return res.json({ status: "ok", run: formatRunForClient(run) });
        }

        run.pendingFieldCapture = null;
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

      const tools = await listAllTools(userId);
      const validation = validateAllSteps([step], tools);
      if (!validation.valid) {
        run.status = "NEEDS_INPUT";
        run.pendingFieldCapture = {
          field: String(validation.missingField || ""),
          stepIndex,
          frozenSteps: run.plan.map((s) => ({ ...s, input: { ...s.input } })),
        };
        run.messages.push({
          role: "agent",
          text:
            validation.missingFieldQuestion ||
            `I need ${validation.missingField} to proceed.`,
        });
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }

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

        if (
          String(responseBody.reason || "")
            .toLowerCase()
            .startsWith("issues disabled in repository:")
        ) {
          run.status = "NEEDS_INPUT";
          run.lastError = undefined;
          run.messages.push({
            role: "agent",
            text:
              "That repository has GitHub Issues disabled, so I cannot create an issue there. Share another repository with Issues enabled, and I will retry.",
          });
          return res.json({ status: "ok", run: formatRunForClient(run) });
        }

        if (
          String(responseBody.reason || "")
            .toLowerCase()
            .startsWith("input validation failed")
        ) {
          run.status = "NEEDS_INPUT";
          run.lastError = undefined;
          run.messages.push({
            role: "agent",
            text: getToolAwareValidationPrompt(
              step.tool,
              String(responseBody.reason || ""),
            ),
          });
          return res.json({ status: "ok", run: formatRunForClient(run) });
        }

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
