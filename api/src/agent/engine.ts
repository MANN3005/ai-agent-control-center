import crypto from "crypto";
import { prisma } from "../db";
import { AGENT_MAX_STEPS } from "../config";
import { getGroqClient } from "../services/llm";
import {
  getAuth0UserEmail,
  getGithubAccessToken,
  getSlackAccessToken,
} from "../services/auth0";
import { githubGetIssue, githubListRepos, parseRepo } from "../services/github";
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
import {
  slackLookupUserByEmail,
  slackOpenDm,
  slackPostMessage,
} from "../services/slack";

export const AGENT_RUNS = new Map<string, AgentRun>();
export const ACTIVE_AGENT_RUNS = new Set<string>();
export const LAST_CONTEXT = new Map<string, Record<string, any>>();
const TOOL_CALL_HISTORY = new Map<string, number[]>();
const CIRCUIT_WINDOW_MS = 10_000;
const CIRCUIT_LIMIT = 5;

export type LlmAuditEntry = {
  id: string;
  userId: string;
  runId: string | null;
  requestId: string | null;
  callType: "plan" | "recovery" | "reply";
  model: string;
  input: Record<string, any>;
  output: Record<string, any>;
  createdAt: string;
};

export const LLM_AUDIT_LOGS = new Map<string, LlmAuditEntry[]>();

function clip(value: string, max = 1000) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function recordLlmAudit(entry: Omit<LlmAuditEntry, "id" | "createdAt">) {
  if (!entry.userId) return;
  const next: LlmAuditEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...entry,
    input: JSON.parse(clip(JSON.stringify(entry.input || {}), 4000)),
    output: JSON.parse(clip(JSON.stringify(entry.output || {}), 4000)),
  };
  const current = LLM_AUDIT_LOGS.get(entry.userId) || [];
  current.unshift(next);
  LLM_AUDIT_LOGS.set(entry.userId, current.slice(0, 200));
}

function buildDecisionReason(tool: string, input: Record<string, any>) {
  if (tool === "github_explorer") {
    const resource = String(input.resource || "repos");
    const repo = input.repo ? ` in ${input.repo}` : "";
    return `Explore ${resource}${repo}.`;
  }
  if (tool === "manage_issues") {
    const action = String(input.action || "");
    const repo = input.repo ? ` in ${input.repo}` : "";
    if (action === "create") return `Create issue${repo}.`;
    if (action === "close") return `Close issues${repo}.`;
    if (action === "reopen") return `Reopen issues${repo}.`;
    if (action === "comment") return `Comment on issues${repo}.`;
    return `Manage issues${repo}.`;
  }
  if (tool === "slack_notifier") {
    const action = String(input.action || "post");
    const channel = input.channel ? ` to #${input.channel}` : "";
    return `${action === "summary" ? "Post summary" : "Post message"}${channel}.`;
  }
  return "Execute tool.";
}

function isCircuitTripped(userId: string, tool: string) {
  if (tool !== "manage_issues") return false;
  const key = `${userId}:${tool}`;
  const now = Date.now();
  const history = (TOOL_CALL_HISTORY.get(key) || []).filter(
    (ts) => now - ts <= CIRCUIT_WINDOW_MS,
  );
  history.push(now);
  TOOL_CALL_HISTORY.set(key, history);
  return history.length > CIRCUIT_LIMIT;
}

async function notifyCircuitBreaker(userId: string, tool: string) {
  try {
    const email = await getAuth0UserEmail(userId);
    if (!email) return;
    const slackToken = await getSlackAccessToken(userId);
    const slackUser = await slackLookupUserByEmail(slackToken, email);
    if (!slackUser.id) return;
    const dmChannel = await slackOpenDm(slackToken, slackUser.id);
    if (!dmChannel) return;
    const message =
      `Circuit breaker tripped for ${tool}. ` +
      `More than ${CIRCUIT_LIMIT} calls in ${CIRCUIT_WINDOW_MS / 1000}s. ` +
      "Agent execution has been paused.";
    await slackPostMessage(slackToken, dmChannel, message);
  } catch {
    // Ignore notification failures.
  }
}

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
  meta?: { userId?: string; runId?: string; requestId?: string },
) {
  const client = getGroqClient();
  const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";
  const toolList = formatToolListForPrompt(tools);

  const system =
    "You are a Policy-Gated Agent. Only output JSON with keys {steps, question}. " +
    "You solve tasks by planning tool calls. Available tools are listed below. " +
    "You operate within an allow-list; if a repo is not provided, do not assume it. " +
    "If required info is missing, return steps: [] and a short question asking the user. " +
    "Use input fields: resource (repos|issues|prs), repo, state (open|closed|all), action (create|close|reopen|comment), issueNumbers, title, body, comment, assignee, assigneeEmail, channel, text, limit. " +
    "Use github_explorer for listing repos, issues, or PRs. " +
    "Use manage_issues for create/close/reopen/comment actions. " +
    "Use slack_notifier to post or summarize to Slack. " +
    "Only include assigneeEmail when the user explicitly provides a real email address. Never invent, guess, or use placeholder emails (like example.com). " +
    "Never assume a tool call succeeded without output. " +
    "Never use issueNumbers with 0. " +
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

  recordLlmAudit({
    userId: String(meta?.userId || ""),
    runId: meta?.runId || null,
    requestId: meta?.requestId || null,
    callType: "plan",
    model,
    input: {
      task,
      context,
      tools: tools.map((t) => t.name),
    },
    output: {
      question: typeof parsed.question === "string" ? parsed.question : "",
      stepsCount: Array.isArray(parsed.steps) ? parsed.steps.length : 0,
      steps: parsed.steps,
    },
  });

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
  const placeholderValues = new Set([
    "assignee",
    "user",
    "username",
    "someone",
    "channel",
    "slack",
    "slack-channel",
    "slack_channel",
  ]);
  const hasManagedCreateWithNotify = steps.some((step) => {
    if (
      String(step?.tool || "")
        .trim()
        .toLowerCase() !== "manage_issues"
    ) {
      return false;
    }
    const input =
      step?.input && typeof step.input === "object" ? step.input : {};
    const action = String((input as any).action || "").trim();
    return (
      action === "create" &&
      Boolean((input as any).assigneeEmail || context.assigneeEmail)
    );
  });

  for (const step of steps) {
    const rawTool = String(step?.tool || "")
      .trim()
      .toLowerCase();
    const tool = rawTool as ToolName;
    const toolInfo = toolIndex.get(tool);
    if (!tool || !toolInfo) {
      throw new Error("Agent selected an unsupported tool");
    }

    const input =
      step?.input && typeof step.input === "object" ? step.input : {};

    if (toolInfo.needsRepo) {
      if (!input.repo && context.repo) input.repo = context.repo;
      if (!input.repo && context.repoCandidate) {
        input.repo = context.repoCandidate;
      }
      if (!input.repo) {
        throw new Error("Missing repo for repo-scoped tool");
      }
    }

    if (tool === "github_explorer") {
      if (!input.resource) input.resource = "repos";
      const resource = String(input.resource || "repos");
      if ((resource === "issues" || resource === "prs") && !input.repo) {
        if (context.repo) input.repo = context.repo;
        if (!input.repo && context.repoCandidate) {
          input.repo = context.repoCandidate;
        }
        if (!input.repo) {
          throw new Error("Missing repo for exploration");
        }
      }
      if (!input.state && context.state) {
        input.state = context.state;
      }
    }

    if (tool === "manage_issues") {
      const action = String(input.action || "").trim();

      if (action === "create") {
        if (!input.title && context.title) input.title = context.title;
        if (!input.body && context.body) input.body = context.body;
        if (!input.assignee && context.assignee) {
          input.assignee = context.assignee;
        }
        if (!input.assigneeEmail && context.assigneeEmail) {
          input.assigneeEmail = context.assigneeEmail;
        }
        if (
          typeof input.assignee === "string" &&
          input.assignee.includes("@")
        ) {
          input.assigneeEmail = input.assignee;
          delete (input as any).assignee;
        }
        if (typeof input.assignee === "string") {
          const normalizedAssignee = input.assignee.trim().toLowerCase();
          if (placeholderValues.has(normalizedAssignee)) {
            delete (input as any).assignee;
          }
        }
        if (
          typeof input.assigneeEmail === "string" &&
          !input.assigneeEmail.includes("@")
        ) {
          delete (input as any).assigneeEmail;
        }
        if (typeof input.assigneeEmail === "string") {
          const normalizedEmail = input.assigneeEmail.trim().toLowerCase();
          if (
            normalizedEmail.endsWith("@example.com") ||
            normalizedEmail.includes("noreply") ||
            normalizedEmail.includes("placeholder")
          ) {
            delete (input as any).assigneeEmail;
          }
        }
      }

      if (action === "close" || action === "reopen" || action === "comment") {
        if (!input.issueNumbers && Array.isArray(context.issueNumbers)) {
          input.issueNumbers = context.issueNumbers;
        }
        const issueNumbers = Array.isArray(input.issueNumbers)
          ? input.issueNumbers
              .map((n: any) => Number(n))
              .filter((n: number) => Number.isInteger(n) && n > 0)
          : [];
        if (issueNumbers.length) {
          input.issueNumbers = issueNumbers;
        }
      }

      if (action === "comment") {
        if (!input.comment && context.comment) input.comment = context.comment;
      }
    }

    if (tool === "slack_notifier") {
      if (!input.action) input.action = "post";
      if (hasManagedCreateWithNotify && !input.channel) {
        continue;
      }
      if (typeof input.channel === "string") {
        const normalizedChannel = input.channel.trim().toLowerCase();
        if (placeholderValues.has(normalizedChannel)) {
          delete (input as any).channel;
        }
      }
      if (!input.channel && context.channel) {
        input.channel = context.channel;
      }
      if (!input.channel) {
        input.channel = "new-issues";
      }
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
  const titleMatch = text.match(/titled\s+["“”'‘’]?([^"”'‘’]+)["“”'‘’]?/i);
  const titleKeywordMatch = text.match(/title\s+["“”'‘’]([^"”'‘’]+)["“”'‘’]/i);
  if (titleMatch) context.title = titleMatch[1].trim();
  if (!context.title && titleKeywordMatch) {
    context.title = titleKeywordMatch[1].trim();
  }
  const assigneeMatch = text.match(/assign(?:ed)?\s+to\s+([A-Za-z0-9_.-]+)/i);
  if (assigneeMatch) context.assignee = assigneeMatch[1].trim();
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) context.assigneeEmail = emailMatch[0].trim();
  const commentMatch = text.match(/comment\s+["“”'‘’]?([^"”'‘’]+)["“”'‘’]?/i);
  if (commentMatch) context.comment = commentMatch[1].trim();
  const channelMatch = text.match(/#([A-Za-z0-9_-]+)/);
  if (channelMatch) context.channel = channelMatch[1];
  if (!context.repo && !context.repoCandidate) {
    const candidateMatch = text.match(/\b(?:on|in)\s+([A-Za-z0-9_.-]+)\b/i);
    const candidate = candidateMatch?.[1] || "";
    if (candidate && !candidate.includes("/")) {
      context.repoCandidate = candidate;
    }
  }
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
  if (normalized.length < 3) return false;
  const banned = ["create issue", "new issue", "issue", "todo", "task"];
  return !banned.includes(normalized);
}

export function getMissingInputQuestion(
  steps: AgentStep[],
  context: Record<string, any>,
  toolIndex: Map<string, ToolDefinition>,
): string | null {
  const placeholderValues = new Set([
    "assignee",
    "user",
    "username",
    "someone",
    "channel",
    "slack",
    "slack-channel",
    "slack_channel",
  ]);

  for (const step of steps) {
    const toolName = String(step.tool || "").toLowerCase();
    const toolInfo = toolIndex.get(toolName);
    if (toolInfo?.needsRepo) {
      if (!step.input?.repo && !context.repo && !context.repoCandidate) {
        return "Which repo should I use? Please share it as owner/repo (it must be in the allow-list).";
      }
    }
    if (toolName === "github_explorer") {
      const resource = String(step.input?.resource || "repos");
      if ((resource === "issues" || resource === "prs") && !step.input?.repo) {
        if (!context.repo && !context.repoCandidate) {
          return "Which repo should I inspect? Provide owner/repo.";
        }
      }
    }
    if (toolName === "manage_issues") {
      const action = String(step.input?.action || "");
      if (action === "create") {
        const title = String(step.input?.title || context.title || "").trim();
        if (!title || !isMeaningfulTitle(title)) {
          return "What issue title should I use?";
        }
      }
      if (action === "close" || action === "reopen" || action === "comment") {
        const issueNumbers = Array.isArray(step.input?.issueNumbers)
          ? step.input.issueNumbers
          : context.issueNumbers;
        if (!Array.isArray(issueNumbers) || issueNumbers.length === 0) {
          return "Which issue numbers should I update?";
        }
      }
      if (action === "comment") {
        const comment = String(
          step.input?.comment || context.comment || "",
        ).trim();
        if (!comment) {
          return "What comment should I add to those issues?";
        }
      }
    }
    if (
      toolName === "slack_notifier" &&
      !context.channel &&
      (!step.input?.channel ||
        (typeof step.input.channel === "string" &&
          placeholderValues.has(step.input.channel.trim().toLowerCase())))
    ) {
      continue;
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
  meta?: { userId?: string; runId?: string; requestId?: string },
) {
  const client = getGroqClient();
  const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";
  const toolList = formatToolListForPrompt(tools);

  const system =
    "You help recover from a failed tool call. Only output JSON with keys {action, step, question, rationale}. " +
    "Actions: retry, ask_user, abort. " +
    "If retry, include step {tool, input}. " +
    "If ask_user, include a short question. " +
    "If rationale, keep it short and avoid chain-of-thought. " +
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

  recordLlmAudit({
    userId: String(meta?.userId || ""),
    runId: meta?.runId || null,
    requestId: meta?.requestId || null,
    callType: "recovery",
    model,
    input: {
      task,
      context,
      failedStep,
      error,
      tools: tools.map((t) => t.name),
    },
    output: {
      action: parsed?.action || "abort",
      rationale: parsed?.rationale || "",
      question: parsed?.question || "",
      step: parsed?.step || null,
    },
  });

  if (!parsed || typeof parsed.action !== "string") {
    return { action: "abort" as const };
  }

  return parsed as
    | { action: "retry"; step: AgentStep; rationale?: string }
    | { action: "ask_user"; question: string; rationale?: string }
    | { action: "abort"; rationale?: string };
}

export async function generateAgentReply(
  task: string,
  step: AgentStep,
  result: any,
  meta?: { userId?: string; runId?: string; requestId?: string },
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
  recordLlmAudit({
    userId: String(meta?.userId || ""),
    runId: meta?.runId || null,
    requestId: meta?.requestId || null,
    callType: "reply",
    model,
    input: { task, step, result },
    output: { reply: content.trim() || "Step completed." },
  });
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

      const slackAction = String(step.input?.action || "post");
      if (
        step.tool === "slack_notifier" &&
        (slackAction === "post" || slackAction === "summary") &&
        !step.input?.text
      ) {
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

      trace(run, "action", `Step ${stepIndex + 1}: calling ${step.tool}`);

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
        trace(run, "status", `Step ${stepIndex + 1}: waiting for approval`);
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

        if (responseBody.reason === "Circuit breaker tripped") {
          run.status = "ERROR";
          run.lastError = responseBody.reason || "Circuit breaker tripped";
          trace(
            run,
            "status",
            `Step ${stepIndex + 1}: circuit breaker tripped`,
          );
          run.messages.push({
            role: "agent",
            text: "Circuit breaker tripped. The agent paused to prevent runaway actions.",
          });
          return;
        }

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
            {
              userId: run.userId,
              runId: run.id,
              requestId: `${run.id}:${stepIndex + 1}`,
            },
          );
          if (recovery.rationale) {
            trace(run, "status", `Recovery: ${recovery.rationale}`);
          }

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
              trace(
                run,
                "status",
                `Step ${stepIndex + 1}: retrying after error`,
              );
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
            trace(
              run,
              "status",
              `Step ${stepIndex + 1}: waiting for user input`,
            );
            run.messages.push({ role: "agent", text: recovery.question });
            return;
          }
        }

        run.status = "ERROR";
        run.lastError = responseBody.reason || "Agent step failed";
        trace(
          run,
          "status",
          `Step ${stepIndex + 1}: ${run.lastError ?? "Unknown error"}`,
        );
        run.messages.push({ role: "agent", text: `Error: ${run.lastError}` });
        return;
      }

      stepRecord.status = "EXECUTED";
      stepRecord.result = responseBody;
      run.currentStep += 1;
      trace(run, "status", `Step ${stepIndex + 1}: executed`);

      try {
        const reply = await generateAgentReply(run.task, step, responseBody, {
          userId: run.userId,
          runId: run.id,
          requestId: `${run.id}:${stepIndex + 1}`,
        });
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
    const reasoning = buildDecisionReason(tool, input);
    await prisma.auditLog.create({
      data: {
        userId,
        requestId,
        toolName: tool,
        inputJson: JSON.stringify(input),
        decision: "DENIED",
        reason: "Tool not in registry allow-list",
        reasoning,
        executed: false,
      },
    });
    return {
      statusCode: 400,
      body: { status: "denied", reason: "Tool not allowed" },
    };
  }

  if (isCircuitTripped(userId, tool)) {
    const reasoning = `Circuit breaker tripped for ${tool}.`;
    await prisma.auditLog.create({
      data: {
        userId,
        requestId,
        toolName: tool,
        inputJson: JSON.stringify(input),
        decision: "DENIED",
        reason: "Circuit breaker tripped",
        reasoning,
        executed: false,
      },
    });
    await notifyCircuitBreaker(userId, tool);
    return {
      statusCode: 429,
      body: { status: "denied", reason: "Circuit breaker tripped" },
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
  const action = String((input as any).action || "");
  const effectivePolicy = { ...policy };
  if (tool === "manage_issues" && (action === "close" || action === "reopen")) {
    effectivePolicy.mode = "STEP_UP" as any;
    effectivePolicy.riskLevel = "HIGH" as any;
  }

  if (toolInfo.needsRepo) {
    const repo = String((input as any).repo || "");
    if (!repo) {
      const reasoning = buildDecisionReason(tool, input);
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: "Missing required input.repo",
          reasoning,
          executed: false,
        },
      });
      return {
        statusCode: 400,
        body: { status: "denied", reason: "Missing repo" },
      };
    }

    let resolvedRepo = repo;
    if (!resolvedRepo.includes("/")) {
      const accessToken = await getGithubAccessToken(userId);
      const repos = await githubListRepos(accessToken);
      const normalized = resolvedRepo.toLowerCase();
      const matches = repos.filter((r) => {
        const fullName = (r.fullName || "").toLowerCase();
        const name = (r.name || "").toLowerCase();
        return name === normalized || fullName.endsWith(`/${normalized}`);
      });
      if (matches.length === 1 && matches[0].fullName) {
        resolvedRepo = matches[0].fullName;
        (input as any).repo = resolvedRepo;
      }
    }

    let allowed = await prisma.allowedResource.findUnique({
      where: {
        userId_provider_resourceType_resourceId: {
          userId,
          provider: "github",
          resourceType: "repo",
          resourceId: resolvedRepo,
        },
      },
    });

    if (!allowed) {
      const allowedRepos = await prisma.allowedResource.findMany({
        where: { userId, provider: "github", resourceType: "repo" },
      });
      const resolvedLower = resolvedRepo.toLowerCase();
      const resolvedName = resolvedLower.split("/").pop() || resolvedLower;
      const match = allowedRepos.find((r) => {
        const candidate = String(r.resourceId || "")
          .trim()
          .toLowerCase();
        if (!candidate) return false;
        if (candidate === resolvedLower) return true;
        if (!candidate.includes("/") && candidate === resolvedName) return true;
        if (
          candidate.includes("/") &&
          candidate.split("/").pop() === resolvedName
        )
          return true;
        return false;
      });
      if (match) {
        allowed = match as any;
        resolvedRepo = match.resourceId.includes("/")
          ? match.resourceId
          : resolvedRepo;
        (input as any).repo = resolvedRepo;
      }
    }

    if (!allowed) {
      const reasoning = buildDecisionReason(tool, input);
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: `Repo not allow-listed: ${resolvedRepo}`,
          reasoning,
          executed: false,
        },
      });
      return {
        statusCode: 403,
        body: { status: "denied", reason: "Repo not allow-listed" },
      };
    }
  }

  if (effectivePolicy.mode === "CONFIRM" && !approval.confirmed) {
    const reasoning = buildDecisionReason(tool, input);
    await prisma.auditLog.create({
      data: {
        userId,
        requestId,
        toolName: tool,
        inputJson: JSON.stringify(input),
        decision: "CONFIRM_REQUIRED",
        reason: "Policy requires confirmation",
        reasoning,
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

  if (effectivePolicy.mode === "STEP_UP") {
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
      const reasoning = buildDecisionReason(tool, input);
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "STEP_UP_REQUIRED",
          reason: "Policy requires step-up",
          reasoning,
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
      const reasoning = buildDecisionReason(tool, input);
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "STEP_UP_REQUIRED",
          reason: "Invalid or expired step-up session",
          reasoning,
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
      const reasoning = buildDecisionReason(tool, input);
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "CONFIRM_REQUIRED",
          reason: "High risk tool requires confirmation",
          reasoning,
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

  if (tool === "github_explorer") {
    const resource = String((input as any).resource || "repos");
    if (!"repos|issues|prs".split("|").includes(resource)) {
      const reasoning = buildDecisionReason(tool, input);
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: "Invalid input.resource; expected repos, issues, or prs",
          reasoning,
          executed: false,
        },
      });
      return {
        statusCode: 400,
        body: { status: "denied", reason: "Invalid resource" },
      };
    }

    if (resource === "issues" || resource === "prs") {
      let repo = String((input as any).repo || "");
      if (!repo) {
        const reasoning = buildDecisionReason(tool, input);
        await prisma.auditLog.create({
          data: {
            userId,
            requestId,
            toolName: tool,
            inputJson: JSON.stringify(input),
            decision: "DENIED",
            reason: "Missing required input.repo",
            reasoning,
            executed: false,
          },
        });
        return {
          statusCode: 400,
          body: { status: "denied", reason: "Missing repo" },
        };
      }

      if (!repo.includes("/")) {
        const accessToken = await getGithubAccessToken(userId);
        const repos = await githubListRepos(accessToken);
        const normalized = repo.toLowerCase();
        const matches = repos.filter((r) => {
          const fullName = (r.fullName || "").toLowerCase();
          const name = (r.name || "").toLowerCase();
          return name === normalized || fullName.endsWith(`/${normalized}`);
        });
        if (matches.length === 1 && matches[0].fullName) {
          repo = matches[0].fullName;
          (input as any).repo = repo;
        }
      }

      let allowed = await prisma.allowedResource.findUnique({
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
        const allowedRepos = await prisma.allowedResource.findMany({
          where: { userId, provider: "github", resourceType: "repo" },
        });
        const repoLower = repo.toLowerCase();
        const repoName = repoLower.split("/").pop() || repoLower;
        const match = allowedRepos.find((r) => {
          const candidate = String(r.resourceId || "")
            .trim()
            .toLowerCase();
          if (!candidate) return false;
          if (candidate === repoLower) return true;
          if (!candidate.includes("/") && candidate === repoName) return true;
          if (
            candidate.includes("/") &&
            candidate.split("/").pop() === repoName
          )
            return true;
          return false;
        });
        if (match) {
          allowed = match as any;
          repo = match.resourceId.includes("/") ? match.resourceId : repo;
          (input as any).repo = repo;
        }
      }
      if (!allowed) {
        const reasoning = buildDecisionReason(tool, input);
        await prisma.auditLog.create({
          data: {
            userId,
            requestId,
            toolName: tool,
            inputJson: JSON.stringify(input),
            decision: "DENIED",
            reason: `Repo not allow-listed: ${repo}`,
            reasoning,
            executed: false,
          },
        });
        return {
          statusCode: 403,
          body: { status: "denied", reason: "Repo not allow-listed" },
        };
      }

      try {
        parseRepo(repo);
      } catch (err: any) {
        const reasoning = buildDecisionReason(tool, input);
        await prisma.auditLog.create({
          data: {
            userId,
            requestId,
            toolName: tool,
            inputJson: JSON.stringify(input),
            decision: "DENIED",
            reason: err?.message || "Invalid repo format",
            reasoning,
            executed: false,
          },
        });
        return {
          statusCode: 400,
          body: { status: "denied", reason: err?.message },
        };
      }
    }

    const state = String((input as any).state || "open");
    if (!"open|closed|all".split("|").includes(state)) {
      const reasoning = buildDecisionReason(tool, input);
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: "Invalid input.state; expected open, closed, or all",
          reasoning,
          executed: false,
        },
      });
      return {
        statusCode: 400,
        body: { status: "denied", reason: "Invalid state" },
      };
    }
  }

  if (toolInfo.needsRepo) {
    const repo = String((input as any).repo || "");
    try {
      parseRepo(repo);
    } catch (err: any) {
      const reasoning = buildDecisionReason(tool, input);
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: err?.message || "Invalid repo format",
          reasoning,
          executed: false,
        },
      });
      return {
        statusCode: 400,
        body: { status: "denied", reason: err?.message },
      };
    }
  }

  if (tool === "manage_issues") {
    const actionValue = String((input as any).action || "");
    if (!"create|close|reopen|comment".split("|").includes(actionValue)) {
      const reasoning = buildDecisionReason(tool, input);
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason:
            "Invalid input.action; expected create, close, reopen, or comment",
          reasoning,
          executed: false,
        },
      });
      return {
        statusCode: 400,
        body: { status: "denied", reason: "Invalid action" },
      };
    }

    if (actionValue === "create") {
      const title = String((input as any).title || "");
      if (!title) {
        const reasoning = buildDecisionReason(tool, input);
        await prisma.auditLog.create({
          data: {
            userId,
            requestId,
            toolName: tool,
            inputJson: JSON.stringify(input),
            decision: "DENIED",
            reason: "Missing required input.title",
            reasoning,
            executed: false,
          },
        });
        return {
          statusCode: 400,
          body: { status: "denied", reason: "Missing title" },
        };
      }
    }

    if (
      actionValue === "close" ||
      actionValue === "reopen" ||
      actionValue === "comment"
    ) {
      const issueNumbers = Array.isArray((input as any).issueNumbers)
        ? (input as any).issueNumbers
            .map((n: any) => Number(n))
            .filter((n: number) => Number.isInteger(n) && n > 0)
        : [];
      if (!issueNumbers.length) {
        const reasoning = buildDecisionReason(tool, input);
        await prisma.auditLog.create({
          data: {
            userId,
            requestId,
            toolName: tool,
            inputJson: JSON.stringify(input),
            decision: "DENIED",
            reason: "Missing or invalid input.issueNumbers",
            reasoning,
            executed: false,
          },
        });
        return {
          statusCode: 400,
          body: { status: "denied", reason: "Invalid issueNumbers" },
        };
      }
    }

    if (actionValue === "comment") {
      const comment = String((input as any).comment || "");
      if (!comment) {
        const reasoning = buildDecisionReason(tool, input);
        await prisma.auditLog.create({
          data: {
            userId,
            requestId,
            toolName: tool,
            inputJson: JSON.stringify(input),
            decision: "DENIED",
            reason: "Missing required input.comment",
            reasoning,
            executed: false,
          },
        });
        return {
          statusCode: 400,
          body: { status: "denied", reason: "Missing comment" },
        };
      }
    }
  }

  if (tool === "slack_notifier") {
    const actionValue = String((input as any).action || "post");
    if (!"post|summary".split("|").includes(actionValue)) {
      const reasoning = buildDecisionReason(tool, input);
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: "Invalid input.action; expected post or summary",
          reasoning,
          executed: false,
        },
      });
      return {
        statusCode: 400,
        body: { status: "denied", reason: "Invalid action" },
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
        reasoning: buildDecisionReason(tool, input),
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
        reasoning: buildDecisionReason(tool, input),
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
  const slackAction = String(step.input?.action || "post");
  if (
    step.tool !== "slack_notifier" ||
    (slackAction !== "post" && slackAction !== "summary") ||
    step.input?.text
  ) {
    return;
  }
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
