import crypto from "crypto";
import { prisma } from "../db";
import { AGENT_MAX_STEPS } from "../config";
import { getGroqClient } from "../services/llm";
import { getGithubAccessToken, getSlackAccessToken } from "../services/auth0";
import { githubGetIssue, parseRepo } from "../services/github";
import {
  buildGithubSummary,
  buildIssuesSummary,
  buildSingleIssueSummary,
} from "../services/summaries";
import {
  AgentRun,
  AgentStep,
  AgentStepRecord,
  AgentTraceItem,
  ToolDefinition,
  ToolName,
} from "../types";
import { formatToolListForPrompt, getToolIndex, listAllTools } from "../tools";

export const AGENT_RUNS = new Map<string, AgentRun>();
export const ACTIVE_AGENT_RUNS = new Set<string>();
export const LAST_CONTEXT = new Map<string, Record<string, any>>();

export function createRunId() {
  return `run_${crypto.randomUUID()}`;
}

export function trace(
  run: AgentRun,
  type: AgentTraceItem["type"],
  text: string,
) {
  run.trace.push({ type, text, at: new Date().toISOString() });
}

export function safeJsonParse(value: string, fallback: any) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function formatRunForClient(run: AgentRun) {
  return {
    id: run.id,
    task: run.task,
    status: run.status,
    currentStep: run.currentStep,
    plan: run.plan,
    steps: run.steps,
    lastError: run.lastError,
    messages: run.messages,
    trace: run.trace,
  };
}

export async function generateAgentPlan(
  task: string,
  context: Record<string, any>,
  tools: ToolDefinition[],
) {
  const client = getGroqClient();
  const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";
  const toolList = formatToolListForPrompt(tools);

  const system =
    "You are a Policy-Gated Agent. Only output JSON with keys {steps, question}. " +
    "You solve tasks by planning tool calls. Available tools are listed below. " +
    "You operate within an allow-list; if a repo is not provided, do not assume it. " +
    "If required info is missing, return steps: [] and a short question asking the user. " +
    "Use input fields: repo, state (open|closed|all), title, body, issueNumber, issueNumbers. " +
    "Never assume a tool call succeeded without output. " +
    "Never use issueNumber 0. Only use close_issue with a valid issueNumber. " +
    "Only use create_issue if the task explicitly asks to create a new issue and a title is present. " +
    "If the task asks to close multiple issues, use close_issues with issueNumbers. " +
    "If the task asks to summarize GitHub and send to Slack, prefer summarize_github_to_slack. " +
    "Treat natural phrases like update, digest, snapshot, recap, report, or send to Slack as summary intent. " +
    "If the task asks to create an issue and notify someone on Slack (by email), prefer create_issue_and_notify and do not call list_repos or list_issues. " +
    "If policy requires CONFIRM or STEP_UP, the system will pause; do not plan around bypassing approvals. " +
    "Summarize your plan with minimal steps. " +
    `\n\nTOOLS:\n${toolList}`;

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
  const parsed = safeJsonParse(content, null);

  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error("Agent plan missing steps");
  }

  return {
    steps: parsed.steps as AgentStep[],
    question: typeof parsed.question === "string" ? parsed.question.trim() : "",
  };
}

export function normalizeAgentSteps(
  steps: AgentStep[],
  context: Record<string, any>,
  toolIndex: Map<string, ToolDefinition>,
) {
  const normalized: AgentStep[] = [];
  const hasIssueNumber = Number.isInteger(Number(context.issueNumber));
  const hasIssueNumbers =
    Array.isArray(context.issueNumbers) && context.issueNumbers.length > 0;
  const wantsSlack = steps.some(
    (step) =>
      step.tool === "slack_post_message" ||
      step.tool === "summarize_github_to_slack",
  );
  const hasCreateAndNotify = steps.some(
    (step) => step.tool === "create_issue_and_notify",
  );

  for (const step of steps) {
    const tool = step?.tool as ToolName;
    const toolInfo = toolIndex.get(tool);
    if (!tool || !toolInfo) {
      throw new Error("Agent selected an unsupported tool");
    }

    if (tool === "list_issues" && hasIssueNumber && wantsSlack) {
      continue;
    }

    if (
      hasCreateAndNotify &&
      (tool === "list_repos" || tool === "list_issues")
    ) {
      continue;
    }

    const input =
      step?.input && typeof step.input === "object" ? step.input : {};

    if (toolInfo.needsRepo) {
      if (!input.repo && context.repo) input.repo = context.repo;
      if (!input.repo) {
        throw new Error("Missing repo for repo-scoped tool");
      }
    }

    if (tool === "close_issue" && !input.issueNumber && context.issueNumber) {
      input.issueNumber = context.issueNumber;
    }

    if (tool === "close_issues" && !input.issueNumbers && hasIssueNumbers) {
      input.issueNumbers = context.issueNumbers;
    }

    if (tool === "close_issue") {
      const issueNumber = Number(input.issueNumber);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error("Missing or invalid issueNumber for close_issue");
      }
    }

    if (tool === "close_issues") {
      const issueNumbers = Array.isArray(input.issueNumbers)
        ? input.issueNumbers
            .map((n: any) => Number(n))
            .filter((n: number) => Number.isInteger(n) && n > 0)
        : [];
      if (!issueNumbers.length) {
        throw new Error("Missing or invalid issueNumbers for close_issues");
      }
      input.issueNumbers = issueNumbers;
    }

    if (tool === "create_issue") {
      if (!input.title && context.title) input.title = context.title;
      if (!input.body && context.body) input.body = context.body;
    }

    if (tool === "create_issue_and_notify") {
      if (!input.title && context.title) input.title = context.title;
      if (!input.body && context.body) input.body = context.body;
      if (!input.assignee && context.assignee)
        input.assignee = context.assignee;
      if (!input.assigneeEmail && context.assigneeEmail) {
        input.assigneeEmail = context.assigneeEmail;
      }
    }

    if (tool === "list_issues" && !input.state && context.state) {
      input.state = context.state;
    }

    if (
      (tool === "slack_post_message" || tool === "summarize_github_to_slack") &&
      !input.channel &&
      context.channel
    ) {
      input.channel = context.channel;
    }

    normalized.push({ tool, input });
  }

  return normalized;
}

export function extractContextFromText(text: string) {
  const context: Record<string, any> = {};
  const pushRange = (start: number, end: number, out: number[]) => {
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    for (let n = min; n <= max; n += 1) out.push(n);
  };
  const repoMatch = text.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  if (repoMatch) context.repo = repoMatch[1];
  const issueMatch = text.match(/issue\s+#?(\d+)/i);
  if (issueMatch) context.issueNumber = Number(issueMatch[1]);
  const issueNumbers: number[] = [];
  const hashMatches = Array.from(text.matchAll(/#(\d+)/g)).map((m) =>
    Number(m[1]),
  );
  hashMatches.forEach(
    (n) => Number.isInteger(n) && n > 0 && issueNumbers.push(n),
  );

  const hashRangeMatches = Array.from(
    text.matchAll(/#(\d+)\s*(?:-|to|through)\s*#?(\d+)/gi),
  );
  hashRangeMatches.forEach((m) => {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (Number.isInteger(start) && Number.isInteger(end)) {
      pushRange(start, end, issueNumbers);
    }
  });

  const wordRangeMatches = Array.from(
    text.matchAll(/issues?\s+(\d+)\s*(?:-|to|through|and)\s*(\d+)/gi),
  );
  wordRangeMatches.forEach((m) => {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (Number.isInteger(start) && Number.isInteger(end)) {
      pushRange(start, end, issueNumbers);
    }
  });

  const uniqueNumbers = Array.from(new Set(issueNumbers)).filter(
    (n) => Number.isInteger(n) && n > 0,
  );
  if (uniqueNumbers.length) context.issueNumbers = uniqueNumbers;
  const stateMatch = text.match(/\b(open|closed|all)\b/i);
  if (stateMatch) context.state = stateMatch[1].toLowerCase();
  const titleMatch = text.match(/titled\s+["“”']?([^"”']+)["“”']?/i);
  if (titleMatch) context.title = titleMatch[1].trim();
  const assigneeMatch = text.match(/assign(?:ed)?\s+to\s+([A-Za-z0-9_.-]+)/i);
  if (assigneeMatch) context.assignee = assigneeMatch[1].trim();
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) context.assigneeEmail = emailMatch[0].trim();
  const channelMatch = text.match(/#([A-Za-z0-9_-]+)/);
  if (channelMatch) context.channel = channelMatch[1];
  return context;
}

export function getSmallTalkReply(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  if (/^(hi|hello|hey)([!\.\s]*)$/.test(normalized)) {
    return "Hi! How can I help?";
  }

  if (/^(thanks|thank you|thx|ty)([!\.\s]*)$/.test(normalized)) {
    return "You are welcome! Anything else you want me to do?";
  }

  return null;
}

function isMeaningfulTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  if (normalized.length < 5) return false;
  const banned = ["create issue", "new issue", "issue", "todo", "task"];
  return !banned.includes(normalized);
}

export function getMissingInputQuestion(
  steps: AgentStep[],
  context: Record<string, any>,
  toolIndex: Map<string, ToolDefinition>,
): string | null {
  for (const step of steps) {
    const toolInfo = toolIndex.get(step.tool);
    if (toolInfo?.needsRepo) {
      if (!step.input?.repo && !context.repo) {
        return "Which repo should I use? Please share it as owner/repo (it must be in the allow-list).";
      }
    }
    if (step.tool === "create_issue") {
      const title = String(step.input?.title || context.title || "").trim();
      if (!title || !isMeaningfulTitle(title)) {
        return "What issue title should I use?";
      }
    }
    if (step.tool === "close_issue") {
      const issueNumber = Number(
        step.input?.issueNumber || context.issueNumber,
      );
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        return "Which issue number should I close?";
      }
    }
    if (step.tool === "close_issues") {
      const issueNumbers = Array.isArray(step.input?.issueNumbers)
        ? step.input.issueNumbers
        : context.issueNumbers;
      if (!Array.isArray(issueNumbers) || issueNumbers.length === 0) {
        return "Which issue numbers should I close?";
      }
    }
    if (
      (step.tool === "slack_post_message" ||
        step.tool === "summarize_github_to_slack") &&
      !step.input?.channel &&
      !context.channel
    ) {
      return "Which Slack channel should I use?";
    }
  }
  return null;
}

export async function generateRecoveryAction(
  task: string,
  context: Record<string, any>,
  failedStep: AgentStep,
  error: string,
  tools: ToolDefinition[],
) {
  const client = getGroqClient();
  const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";
  const toolList = formatToolListForPrompt(tools);

  const system =
    "You help recover from a failed tool call. Only output JSON with keys {action, step, question}. " +
    "Actions: retry, ask_user, abort. " +
    "If retry, include step {tool, input}. " +
    "If ask_user, include a short question. " +
    `Use only these tools:\n${toolList}`;

  const user = JSON.stringify({ task, context, failedStep, error });

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
  const parsed = safeJsonParse(content, null);

  if (!parsed || typeof parsed.action !== "string") {
    return { action: "abort" as const };
  }

  return parsed as
    | { action: "retry"; step: AgentStep }
    | { action: "ask_user"; question: string }
    | { action: "abort" };
}

export async function generateAgentReply(
  task: string,
  step: AgentStep,
  result: any,
) {
  const client = getGroqClient();
  const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";

  const system =
    "You are an assistant summarizing a tool call result for the user. " +
    "Be concise, 1-2 sentences, no markdown. " +
    "If the result includes a list, mention how many items and one example.";

  const user = JSON.stringify({ task, step, result });

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
  });

  const content = completion.choices[0]?.message?.content || "";
  return content.trim() || "Step completed.";
}

export function getOrCreateStepRecord(
  run: AgentRun,
  index: number,
  step: AgentStep,
) {
  const existing = run.steps[index];
  if (existing) return existing;
  const record: AgentStepRecord = {
    tool: step.tool,
    input: step.input,
    status: "PLANNED",
    retries: 0,
  };
  run.steps[index] = record;
  return record;
}

export function enqueueAgentRun(runId: string) {
  if (ACTIVE_AGENT_RUNS.has(runId)) return;
  ACTIVE_AGENT_RUNS.add(runId);
  setImmediate(() => runAgentLoop(runId));
}

export async function runAgentLoop(runId: string) {
  try {
    while (true) {
      const run = AGENT_RUNS.get(runId);
      if (!run) return;
      if (run.status !== "RUNNING") return;

      if (run.currentStep >= run.plan.length) {
        run.status = "COMPLETED";
        trace(run, "status", "Task completed.");
        run.messages.push({ role: "agent", text: "Task completed." });
        return;
      }

      if (run.currentStep >= AGENT_MAX_STEPS) {
        run.status = "ERROR";
        run.lastError = `Agent exceeded max steps (${AGENT_MAX_STEPS}).`;
        trace(run, "status", run.lastError ?? "Unknown error");
        return;
      }

      const stepIndex = run.currentStep;
      const step = run.plan[stepIndex];
      const stepRecord = getOrCreateStepRecord(run, stepIndex, step);

      if (step.tool === "slack_post_message" && !step.input?.text) {
        const previous = run.steps[stepIndex - 1];
        const repos = previous?.result?.result?.repos;
        const issues = previous?.result?.result?.issues;
        if (run.context.repo && run.context.issueNumber) {
          const accessToken = await getGithubAccessToken(run.userId);
          const { owner, name } = parseRepo(String(run.context.repo));
          const issue = await githubGetIssue(
            accessToken,
            owner,
            name,
            Number(run.context.issueNumber),
          );
          step.input.text = buildSingleIssueSummary(issue);
        } else if (Array.isArray(repos) && repos.length) {
          step.input.text = buildGithubSummary(repos, 10);
        } else if (Array.isArray(issues) && issues.length) {
          const stateLabel = String(previous?.input?.state || "open");
          step.input.text = buildIssuesSummary(issues, 10, stateLabel);
        } else if (run.context.repo && run.context.issueNumber) {
          const accessToken = await getGithubAccessToken(run.userId);
          const { owner, name } = parseRepo(String(run.context.repo));
          const issue = await githubGetIssue(
            accessToken,
            owner,
            name,
            Number(run.context.issueNumber),
          );
          step.input.text = buildSingleIssueSummary(issue);
        }
      }

      trace(run, "action", `Calling ${step.tool}`);

      const response = await executeToolWithPolicy(
        run.userId,
        `${run.id}:${stepIndex + 1}`,
        step.tool,
        step.input,
        { confirmed: false, stepUpId: null },
      );

      const responseBody = response.body || {};

      if (
        responseBody.status === "confirm_required" ||
        responseBody.status === "step_up_required"
      ) {
        stepRecord.status = "APPROVAL_REQUIRED";
        stepRecord.result = responseBody;
        stepRecord.reason = responseBody.reason || "Approval required";
        run.pendingStepIndex = stepIndex;
        run.status = "WAITING_APPROVAL";
        trace(run, "status", "Waiting for approval");
        run.messages.push({
          role: "agent",
          text: "Approval required. Please confirm in the UI to continue.",
        });
        return;
      }

      if (response.statusCode >= 400 && responseBody.status !== "executed") {
        stepRecord.status = "ERROR";
        stepRecord.result = responseBody;
        stepRecord.reason = responseBody.reason || "Tool error";

        if (responseBody.reason === "Repo not allow-listed") {
          run.status = "NEEDS_INPUT";
          trace(run, "status", "Waiting for allow-listed repo");
          run.messages.push({
            role: "agent",
            text: "That repo is not in your allow-list. Add it on the Allow-list page or provide a different allow-listed repo.",
          });
          return;
        }

        if (stepRecord.retries < 1) {
          const tools = await listAllTools();
          const toolIndex = getToolIndex(tools);
          const recovery = await generateRecoveryAction(
            run.task,
            run.context,
            step,
            responseBody.reason || "Tool error",
            tools,
          );

          if (recovery.action === "retry" && recovery.step) {
            try {
              const normalized = normalizeAgentSteps(
                [recovery.step],
                run.context,
                toolIndex,
              )[0];
              run.plan[stepIndex] = normalized;
              stepRecord.retries += 1;
              stepRecord.status = "PLANNED";
              stepRecord.reason = "Retrying with corrected step";
              trace(run, "status", "Retrying after error");
              continue;
            } catch (err: any) {
              run.status = "ERROR";
              run.lastError = err?.message || "Recovery failed";
              trace(run, "status", run.lastError ?? "Unknown error");
              return;
            }
          }

          if (recovery.action === "ask_user" && recovery.question) {
            run.status = "NEEDS_INPUT";
            trace(run, "status", "Waiting for user input");
            run.messages.push({ role: "agent", text: recovery.question });
            return;
          }
        }

        run.status = "ERROR";
        run.lastError = responseBody.reason || "Agent step failed";
        trace(run, "status", run.lastError ?? "Unknown error");
        run.messages.push({ role: "agent", text: `Error: ${run.lastError}` });
        return;
      }

      stepRecord.status = "EXECUTED";
      stepRecord.result = responseBody;
      run.currentStep += 1;

      try {
        const reply = await generateAgentReply(run.task, step, responseBody);
        run.messages.push({ role: "agent", text: reply });
      } catch {
        run.messages.push({ role: "agent", text: "Step completed." });
      }
    }
  } finally {
    ACTIVE_AGENT_RUNS.delete(runId);
  }
}

export async function executeToolWithPolicy(
  userId: string,
  requestId: string,
  tool: ToolName,
  input: Record<string, any>,
  approval: { confirmed: boolean; stepUpId: string | null },
) {
  const tools = listAllTools();
  const toolIndex = getToolIndex(tools);
  const toolInfo = toolIndex.get(tool);
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

  const defaultPolicy = {
    riskLevel: toolInfo.defaultRisk,
    mode: toolInfo.defaultMode,
  } as const;

  const policy = existingPolicy ?? {
    userId,
    toolName: tool,
    riskLevel: defaultPolicy.riskLevel as any,
    mode: defaultPolicy.mode as any,
  };

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

    if (toolInfo.handler) {
      result = await toolInfo.handler(userId, input);
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

export async function applySlackAutoFill(run: AgentRun, stepIndex: number) {
  const step = run.plan[stepIndex];
  if (step.tool !== "slack_post_message" || step.input?.text) return;
  const previous = run.steps[stepIndex - 1];
  const repos = previous?.result?.result?.repos;
  const issues = previous?.result?.result?.issues;
  if (run.context.repo && run.context.issueNumber) {
    const accessToken = await getGithubAccessToken(run.userId);
    const { owner, name } = parseRepo(String(run.context.repo));
    const issue = await githubGetIssue(
      accessToken,
      owner,
      name,
      Number(run.context.issueNumber),
    );
    step.input.text = buildSingleIssueSummary(issue);
    return;
  }
  if (Array.isArray(repos) && repos.length) {
    step.input.text = buildGithubSummary(repos, 10);
    return;
  }
  if (Array.isArray(issues) && issues.length) {
    const stateLabel = String(previous?.input?.state || "open");
    step.input.text = buildIssuesSummary(issues, 10, stateLabel);
  }
}
