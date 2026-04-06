import crypto from "crypto";
import { prisma } from "../db";
import { AGENT_MAX_STEPS } from "../config";
import {
  createChatCompletionWithFallback,
  createJsonObjectCompletion,
  getGroqClient,
  getLlmModel,
} from "../services/llm";
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
import { getToolIndex, listAllTools } from "../tools";
import { buildHydrationContext, ContextHydrator } from "./hydrator";
import { extractFieldsFromText } from "./contextExtractor";
import {
  CF,
  normalizeAction,
  normalizeFields,
  resolveRepoFields,
} from "./fieldRegistry";
import {
  getCachedIntentPlan,
  makeIntentCacheKey,
  setCachedIntentPlan,
} from "./intentCache";
import { resolveIntentToPlan } from "./intentRouter";
import { rectify } from "./rectify";
import { validateAllSteps } from "./validator";
import {
  slackLookupUserByEmail,
  slackOpenDm,
  slackPostMessage,
} from "../services/slack";

export const AGENT_RUNS = new Map<string, AgentRun>();
export const ACTIVE_AGENT_RUNS = new Set<string>();
export const LAST_CONTEXT = new Map<string, Record<string, any>>();
const TOOL_CALL_HISTORY = new Map<string, number[]>();
const GITHUB_LOGIN_CACHE = new Map<string, string>();
const CIRCUIT_WINDOW_MS = 10_000;
const CIRCUIT_LIMIT = 5;

const TOOL_CALL_OUTPUT_RULES = `
----------------------------------------------------------------------
TOOL CALL OUTPUT RULES - FOLLOW THESE PRECISELY:

1. Always respond with a single JSON object in this exact shape:
  {
    "tool": "<exact_mcp_tool_name>",
    "input": { <parameters> }
  }
  No explanation. No markdown. No extra keys. Just this JSON.

2. For owner/repo:
  - If the user wrote "owner/repo" together (e.g. "h202201297/my-app"),
    set input.owner = "h202201297" and input.repo = "my-app" separately.
  - Never put "owner/repo" as a combined string in input.repo.
  - If owner is not in the user message, leave input.owner out entirely.
    The system will inject it from the user's GitHub account.

3. For issue_number and pull_number:
  - Always output as a number (integer), never a string.
  - "#1" -> 1, "issue 42" -> 42, "PR #5" -> 5.

4. For state when user says "delete", "remove", "close", or "resolve"
  an issue:
  - The correct tool is github_update_issue.
  - Set input.state = "closed". Never use "deleted" or "removed".

5. For state when user says "reopen":
  - The correct tool is github_update_issue.
  - Set input.state = "open".

6. Never output null, undefined, or empty string "" for any field.
  If you do not have a value for an optional field, omit that field
  entirely from input.

7. Never invent values the user did not provide.
  If a required field is missing from the user message, omit it.
  The system will ask the user for it.

TOOL NAME REFERENCE:
github_add_issue_comment, github_create_branch, github_create_issue,
github_create_or_update_file, github_create_pull_request,
github_create_pull_request_review, github_create_repository,
github_fork_repository, github_get_file_contents, github_get_issue,
github_get_pull_request, github_get_pull_request_comments,
github_get_pull_request_files, github_get_pull_request_reviews,
github_get_pull_request_status, github_list_commits,
github_list_issues, github_list_pull_requests,
github_merge_pull_request, github_push_files, github_search_code,
github_search_issues, github_search_repositories, github_search_users,
github_update_issue, github_update_pull_request_branch
----------------------------------------------------------------------`;

async function resolveGithubLogin(userId: string): Promise<string | null> {
  const cached = GITHUB_LOGIN_CACHE.get(userId);
  if (cached) return cached;

  try {
    const accessToken = await getGithubAccessToken(userId);
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { login?: string };
    const login = String(payload?.login || "").trim();
    if (!login) return null;
    GITHUB_LOGIN_CACHE.set(userId, login);
    return login;
  } catch {
    return null;
  }
}

export async function getGithubUsernameFromVault(userId: string) {
  return resolveGithubLogin(userId);
export type LlmAuditEntry = {
  id: string;
  userId: string;
  runId: string | null;
  requestId: string | null;
  callType: "plan" | "recovery" | "reply" | "policy";
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

  const llmAuditModel = (prisma as any).llmAuditLog;
  if (!llmAuditModel) return;

  // Persist to DB without blocking request flow.
  void llmAuditModel
    .create({
      data: {
        userId: next.userId,
        runId: next.runId,
        requestId: next.requestId,
        callType: next.callType,
        model: next.model,
        inputJson: JSON.stringify(next.input || {}),
        outputJson: JSON.stringify(next.output || {}),
        createdAt: new Date(next.createdAt),
      },
    })
    .catch(() => {
      // Keep trace generation resilient if DB write fails.
    });
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

  const repo = String(input.repository || "").trim();
  const owner = String(input.owner || "").trim();
  const repoName = String(input.repo || "").trim();
  if (repo) {
    return `${tool} on ${repo}.`;
  }
  if (owner && repoName) {
    return `${tool} on ${owner}/${repoName}.`;
  }
  return "Execute tool.";
}

function extractRunIdFromRequestId(requestId: string) {
  const first = String(requestId || "").split(":")[0] || "";
  return first.startsWith("run_") ? first : null;
}

export function recordPolicyVerdictEntry(
  userId: string,
  requestId: string,
  tool: string,
  input: Record<string, any>,
  verdict:
    | "ALLOWED"
    | "BLOCKED"
    | "CONFIRM_REQUIRED"
    | "STEP_UP_REQUIRED"
    | "ERROR",
  reason: string,
) {
  recordLlmAudit({
    userId,
    runId: extractRunIdFromRequestId(requestId),
    requestId,
    callType: "policy",
    model: "policy-engine/v1",
    input: {
      tool,
      input,
    },
    output: {
      action: tool,
      verdict,
      reason,
    },
  });
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

function buildCompactToolSummary(tool: ToolDefinition) {
  const schema = (tool.inputSchema || {}) as Record<string, any>;
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? Object.keys(schema.properties as Record<string, any>).slice(0, 12)
      : [];
  const compactDescription = String(tool.description || "No description")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);

  return (
    `Tool: ${tool.name}\n` +
    `Description: ${compactDescription || "No description"}\n` +
    `Required: ${required.join(", ") || "none"}\n` +
    `Properties: ${properties.join(", ") || "none"}`
  );
}

function buildToolPromptBlock(tools: ToolDefinition[], maxChars = 6500) {
  const lines: string[] = [];
  let used = 0;

  for (const tool of tools) {
    const line = buildCompactToolSummary(tool);
    const cost = line.length + 2;
    if (used + cost > maxChars) break;
    lines.push(line);
    used += cost;
  }

  const omitted = tools.length - lines.length;
  if (omitted > 0) {
    lines.push(`... ${omitted} additional tools omitted for token safety.`);
  }

  return lines.join("\n\n");
}

function slimPlanningContext(context: Record<string, any>) {
  const entries = Object.entries(context || {}).slice(0, 20);
  const reduced: Record<string, any> = {};

  for (const [key, value] of entries) {
    if (typeof value === "string") {
      reduced[key] = value.slice(0, 200);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      reduced[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      reduced[key] = value.slice(0, 10);
      continue;
    }
    if (value && typeof value === "object") {
      reduced[key] = "[object]";
    }
  }

  return reduced;
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

async function generateLegacyPlan(
  task: string,
  context: Record<string, any>,
  tools: ToolDefinition[],
) {
  const client = getGroqClient();
  const model = getLlmModel("gemini-3.1-pro-preview");
  const toolDescriptions = buildToolPromptBlock(tools, 6500);

  const system = `You are an elite, Schema-Driven AI Agent Planner. Only output JSON with keys {steps, question}.
You MUST choose from the EXACT tool names listed below. 

OPERATIONAL GUIDELINES (CRITICAL FOR MISSION SUCCESS):
1. HIGH-UTILITY QUERIES: Never use wildcard ("*") or blank queries for search tools unless explicitly commanded. Extract specific nouns from the user's task to use as search terms.
2. CHAIN OF THOUGHT: If a user asks to "summarize the backend repo issues", you must first plan a step to SEARCH for the backend repo, then a step to LIST its issues.
3. FAIL GRACEFULLY: If you do not have enough specific information to form a HIGH-UTILITY query (e.g., you need a repo name but only have vague instructions), DO NOT guess. 

If you lack critical parameters, return an empty steps array: [] and write a highly specific, polite 'question' asking the user for the exact missing parameter.

AVAILABLE DYNAMIC TOOLS:
${toolDescriptions}

${TOOL_CALL_OUTPUT_RULES}`;

  const user = JSON.stringify({ task, context: slimPlanningContext(context) });

  const completion = await createJsonObjectCompletion(
    client,
    model,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    0.2,
  );

  const content = completion.choices[0]?.message?.content || "";
  const parsed = safeJsonParse(content, null);

  if (parsed && typeof parsed.tool === "string") {
    parsed.steps = [
      {
        tool: String(parsed.tool),
        input:
          parsed.input && typeof parsed.input === "object"
            ? parsed.input
            : {},
      },
    ];
  }

  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error("Agent plan missing steps");
  }

  const normalizedTask = String(task || "").toLowerCase();
  const isFindRepoIntent =
    /\b(find|search|locate)\b/.test(normalizedTask) &&
    /\brepo\b|\brepository\b/.test(normalizedTask);
  if (isFindRepoIntent) {
    const firstStep = (parsed.steps[0] || {}) as AgentStep;
    const firstTool = String(firstStep.tool || "").trim();
    if (firstTool === "intent_list_my_repos") {
      const extractedQuery =
        normalizedTask.match(/(?:named|name)\s+([a-z0-9._-]+)/i)?.[1] ||
        normalizedTask.match(/(?:repo|repository)\s+([a-z0-9._-]+)/i)?.[1] ||
        "";

      parsed.steps = [
        {
          tool: "intent_find_my_repos",
          input: {
            query: extractedQuery || String(context.followUpText || "").trim(),
          },
        },
      ];
    }
  }

  for (const step of parsed.steps as AgentStep[]) {
    const toolName = String(step?.tool || "").toLowerCase();
    const query =
      step?.input && typeof step.input === "object"
        ? String((step.input as any).query || "").trim()
        : "";
    if (toolName.includes("search") && (query === "*" || query === "")) {
      return {
        steps: [] as AgentStep[],
        question:
          "I want to search, but I need specific keywords or a repository name to avoid returning thousands of irrelevant results. What exactly should I look for?",
      };
    }
  }

  let finalQuestion =
    typeof parsed.question === "string" ? parsed.question.trim() : "";

  if (parsed.steps.length === 0 && finalQuestion.length < 15) {
    finalQuestion =
      "I don't have enough specific parameters to safely execute that task. Could you clarify exactly what resources or names I should target?";
  }

  return {
    steps: parsed.steps as AgentStep[],
    question: finalQuestion,
  };
}

function getStepMissingFields(
  step: AgentStep,
  toolInfo: ToolDefinition | undefined,
) {
  const inputSchema = toolInfo?.inputSchema as any;
  const requiredFields: string[] = Array.isArray(inputSchema?.required)
    ? inputSchema.required
    : [];
  return requiredFields.filter((field) => {
    const value = step.input?.[field];
    return value === undefined || value === null || String(value).trim() === "";
  });
}

function questionForField(field: string) {
  if (field === "repo") return "Which repository should I use (owner/repo)?";
  if (field === "name") return "What should the repository be named?";
  if (field === "query")
    return "What exact repo name or keyword should I search for?";
  if (field === "action")
    return "What issue action should I take (create, close, reopen, or comment)?";
  if (field === "branchName") return "What should the new branch be named?";
  if (field === "fromBranch")
    return "Which existing branch should I branch from?";
  if (field === "title") return "What should the issue title be?";
  if (field === "issueNumbers")
    return "Which issue number(s) should I target?";
  if (field === "comment") return "What comment should I post?";
  return `I need the ${field} to proceed.`;
}

function normalizeStepInput(input: Record<string, any>) {
  return resolveRepoFields(normalizeFields(input || {}));
}

function normalizeStep(step: AgentStep): AgentStep {
  return {
    ...step,
    input: normalizeStepInput(step.input || {}),
  };
}

function mergeTextExtractedContext(
  step: AgentStep,
  textExtractedContext: Record<string, any>,
): AgentStep {
  const merged = { ...step, input: { ...(step.input || {}) } };
  for (const [key, value] of Object.entries(textExtractedContext || {})) {
    if ((merged.input as any)[key] == null && value != null) {
      (merged.input as any)[key] = value;
    }
  }
  merged.input = normalizeStepInput(merged.input);
  return merged;
}

function isRateLimitError(err: any) {
  const message = String(err?.message || "");
  return (
    Number((err as any)?.status) === 429 ||
    Number((err as any)?.statusCode) === 429 ||
    /\b429\b/.test(message)
  );
}

export async function generateAgentPlan(
  task: string,
  context: Record<string, any>,
  tools: ToolDefinition[],
  userId?: string,
) {
  const extractedFromText = normalizeStepInput(extractFieldsFromText(task));
  const textExtractedContext = normalizeStepInput({
    ...(context.textExtractedContext || {}),
    ...extractedFromText,
  });
  context.textExtractedContext = textExtractedContext;

  const toolNames = tools.map((tool) => tool.name);
  const cacheKey = makeIntentCacheKey(task, context, toolNames);
  const cached = getCachedIntentPlan(cacheKey);
  if (cached) {
    return cached;
  }

  let routed;
  try {
    routed = await resolveIntentToPlan(task, context, tools);

    if (!routed.steps.length) {
      routed = await generateLegacyPlan(task, context, tools);
    }

    routed.steps = (routed.steps || []).map((step: AgentStep) =>
      normalizeStep(step),
    );
  } catch (err: any) {
    if (isRateLimitError(err)) {
      return {
        steps: [] as AgentStep[],
        question:
          "The planning model is temporarily rate-limited. Please retry in a few seconds, or rephrase with explicit repo and action.",
      };
    }
    throw err;
  }

  if (userId && routed.steps.length) {
    const previousOutputs =
      context.previousStepOutputs && typeof context.previousStepOutputs === "object"
        ? context.previousStepOutputs
        : {};
    const hydrationContext = await buildHydrationContext(userId, previousOutputs);
    const hydrator = new ContextHydrator();
    routed.steps = hydrator.hydrate(routed.steps, tools, hydrationContext);
  }

  routed.steps = (routed.steps || []).map((step: AgentStep) =>
    normalizeStep(step),
  );
  routed.steps = (routed.steps || []).map((step: AgentStep) =>
    mergeTextExtractedContext(step, textExtractedContext),
  );

  const validation = validateAllSteps(routed.steps, tools);
  if (!validation.valid && validation.stepIndex !== undefined) {
    const failingStep = routed.steps[validation.stepIndex];
    if (failingStep) {
      failingStep.missingFields = validation.missingField
        ? [String(validation.missingField)]
        : [];
      failingStep.clarificationQuestion =
        validation.missingFieldQuestion ||
        questionForField(String(validation.missingField || "input"));
    }
  }

  const output = {
    steps: routed.steps,
    question:
      validation.valid === false
        ? validation.missingFieldQuestion || routed.question
        : routed.question,
  };

  setCachedIntentPlan(cacheKey, output);
  return output;
  return steps.filter(
    (step) => String(step?.tool || "").toLowerCase() !== "slack_notifier",
  );
}

export function normalizeAgentSteps(
  steps: AgentStep[],
  context: Record<string, any>,
  toolIndex: Map<string, ToolDefinition>,
) {
  const normalized: AgentStep[] = [];

  for (const step of steps) {
    const toolName = String(step?.tool || "").trim();
    const toolInfo = toolIndex.get(toolName);
    if (!toolInfo) {
      throw new Error(`Agent selected an unsupported tool: ${toolName}`);
    }

    const input = normalizeStepInput(
      step?.input && typeof step.input === "object" ? step.input : {},
    );

    if (toolName === "intent_manage_issue" && !input.action) {
      if (context.action) {
        input.action = String(context.action);
      } else if (typeof context.followUpText === "string") {
        const follow = context.followUpText.toLowerCase();
        if (follow.includes("create")) input.action = "create";
        else if (follow.includes("close")) input.action = "close";
        else if (follow.includes("delete") || follow.includes("remove")) {
          input.action = "close";
        }
        else if (follow.includes("reopen")) input.action = "reopen";
        else if (follow.includes("comment")) input.action = "comment";
      }
    }

    if (input.action) {
      input.action = normalizeAction(String(input.action));
    }

    if (!input.repo && typeof context.followUpText === "string") {
      const followUpText = context.followUpText.trim();
      if (followUpText && followUpText.includes("/")) {
        input.repo = followUpText;
      }
    }

    if (
      String(toolName).toLowerCase().includes("search") &&
      !input.query &&
      typeof context.followUpText === "string"
    ) {
      const followUpText = context.followUpText.trim();
      if (followUpText) {
        input.query = followUpText;
      }
    }

    if (toolInfo.needsRepo) {
      if (!input.repo && context.repo) input.repo = context.repo;
      if (!input.repo && context.repoCandidate) {
        input.repo = context.repoCandidate;
      }
      if (!input.repo) {
        const missing = Array.isArray(step.missingFields)
          ? [...step.missingFields]
          : [];
        if (!missing.includes("repo")) missing.push("repo");
        normalized.push({
          tool: toolName,
          input,
          hydratedFields: step.hydratedFields,
          missingFields: missing,
          clarificationQuestion:
            step.clarificationQuestion ||
            "Which repository should I use (owner/repo)?",
        });
        continue;
      }
    }

    normalized.push({
      tool: toolName,
      input,
      hydratedFields: step.hydratedFields,
      missingFields: step.missingFields,
      clarificationQuestion: step.clarificationQuestion,
    });
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
  const branchNameMatch = text.match(
    /branch\s+(?:named|name|called)?\s*([A-Za-z0-9._/-]+)/i,
  );
  if (branchNameMatch) context.branchName = branchNameMatch[1].trim();
  const fromBranchMatch = text.match(/(?:from|off|based on)\s+([A-Za-z0-9._/-]+)/i);
  if (fromBranchMatch) context.fromBranch = fromBranchMatch[1].trim();
  const lower = text.toLowerCase();
  if (lower.includes("create issue") || lower.includes("open issue")) {
    context.action = "create";
  } else if (
    lower.includes("close issue") ||
    lower.includes("delete issue") ||
    lower.includes("remove issue")
  ) {
    context.action = "close";
  } else if (lower.includes("reopen issue")) {
    context.action = "reopen";
  } else if (lower.includes("comment on issue") || lower.startsWith("comment ")) {
    context.action = "comment";
  }
  const channelMatch = text.match(/#([A-Za-z0-9_-]+)/);
  if (channelMatch) context.channel = channelMatch[1];

  const namedRepoMatch = text.match(
    /(?:repo|repository)\s+(?:named|name)\s+([A-Za-z0-9._-]+)/i,
  );
  if (namedRepoMatch) {
    const repoName = namedRepoMatch[1].trim();
    context.repoCandidate = repoName;
    context.query = repoName;
  }

  const githubUserMatch = text.match(
    /(?:github\s*(?:user(?:name)?|handle)|username)\s*[:=-]?\s*([A-Za-z0-9-]+)/i,
  );
  if (githubUserMatch) {
    context.githubUsername = githubUserMatch[1].trim();
    context.owner = githubUserMatch[1].trim();
    context.query = `user:${githubUserMatch[1].trim()}`;
  }

  const githubUserQueryMatch = text.match(/\buser:([A-Za-z0-9-]+)\b/i);
  if (githubUserQueryMatch) {
    const username = githubUserQueryMatch[1].trim();
    context.githubUsername = username;
    context.owner = username;
    context.query = `user:${username}`;
  }

  const githubOrgMatch = text.match(
    /(?:github\s*(?:org|organization))\s*[:=-]?\s*([A-Za-z0-9-]+)/i,
  );
  if (githubOrgMatch) {
    context.githubOrg = githubOrgMatch[1].trim();
    context.owner = githubOrgMatch[1].trim();
    context.query = `org:${githubOrgMatch[1].trim()}`;
  }

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

export function parsePendingFieldAnswer(field: string, userAnswer: string) {
  const trimmed = String(userAnswer || "").trim();
  if (!trimmed) return trimmed;

  if (field === CF.ISSUE_NUMBER || field === CF.PR_NUMBER) {
    const num = parseInt(trimmed.replace(/[^0-9]/g, ""), 10);
    return Number.isNaN(num) ? trimmed : num;
  }

  return trimmed;
}

function isMeaningfulTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  if (normalized.length < 3) return false;
  const banned = ["create issue", "new issue", "issue", "todo", "task"];
  return !banned.includes(normalized);
}

export async function getMissingInputQuestion(
  steps: AgentStep[],
  context: Record<string, any>,
  toolIndex: Map<string, ToolDefinition>,
  userId?: string,
): Promise<string | null> {
  void userId;
  const workingSteps = steps.map((step) => ({
    ...step,
    input: normalizeStepInput(step.input || {}),
  }));

  if (typeof context.followUpText === "string" && context.followUpText.trim()) {
    const followUp = context.followUpText.trim();
    for (const step of workingSteps) {
      if (!step.input[CF.REPO_NAME] && followUp.includes("/")) {
        step.input[CF.REPO_NAME] = followUp;
      }
      if (!step.input[CF.BRANCH_NAME] && !followUp.includes("/")) {
        step.input[CF.BRANCH_NAME] = followUp;
      }
      if (!step.input[CF.QUERY] && !followUp.includes("/")) {
        step.input[CF.QUERY] = followUp;
      }
      step.input = normalizeStepInput(step.input);
    }
  }

  const validation = validateAllSteps(workingSteps, Array.from(toolIndex.values()));
  if (!validation.valid) {
    return validation.missingFieldQuestion || `I need the ${validation.missingField} to proceed.`;
  }

  for (let i = 0; i < steps.length; i += 1) {
    steps[i].input = workingSteps[i].input;
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
  const model = getLlmModel("gemini-3.1-pro-preview");
  const toolList = buildToolPromptBlock(tools, 3500);

  const system =
    "You help recover from a failed tool call. Only output JSON with keys {action, step, question, rationale}. " +
    "Actions: retry, ask_user, abort. " +
    "If retry, include step {tool, input}. " +
    "If ask_user, include a short question. " +
    "If rationale, keep it short and avoid chain-of-thought. " +
    `Use only these tools:\n${toolList}`;

  const user = JSON.stringify({
    task,
    context: slimPlanningContext(context),
    failedStep,
    error: String(error || "").slice(0, 300),
  });

  const completion = await createJsonObjectCompletion(
    client,
    model,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    0.2,
  );

  const content = completion.choices[0]?.message?.content || "";
  const parsed = safeJsonParse(content, null);

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
) {
  if (step.tool === "intent_create_repository") {
    const fullName = String(result?.result?.fullName || "").trim();
    const htmlUrl = String(result?.result?.htmlUrl || "").trim();
    const name = String(result?.result?.name || step.input?.name || "").trim();

    if (fullName && htmlUrl) {
      return `Created repository ${fullName}. ${htmlUrl}`;
    }
    if (fullName) {
      return `Created repository ${fullName}.`;
    }
    if (name) {
      return `Created repository ${name}.`;
    }
    return "Repository created successfully.";
  }

  if (step.tool === "intent_delete_branch") {
    const repo = String(result?.result?.repo || step.input?.repo || "").trim();
    const branchName = String(
      result?.result?.branchName || step.input?.branchName || "",
    ).trim();

    if (repo && branchName) {
      return `Deleted branch ${branchName} from ${repo}.`;
    }
    return "Branch deleted successfully.";
  }

  if (step.tool === "intent_create_branch") {
    const repo = String(result?.result?.repo || step.input?.repo || "").trim();
    const branchName = String(
      result?.result?.branchName || step.input?.branchName || "",
    ).trim();
    const fromBranch = String(
      result?.result?.fromBranch || step.input?.fromBranch || "",
    ).trim();

    if (repo && branchName && fromBranch) {
      return `Created branch ${branchName} in ${repo} from ${fromBranch}.`;
    }
    if (repo && branchName) {
      return `Created branch ${branchName} in ${repo}.`;
    }
    return "Branch created successfully.";
  }

  if (step.tool === "intent_list_my_repos") {
    const repos = Array.isArray(result?.result?.repos)
      ? (result.result.repos as Array<{ fullName?: string; name?: string }>)
      : [];

    if (!repos.length) {
      return "I could not find any repositories for your connected GitHub account.";
    }

    const names = repos
      .map((repo) => repo.fullName || repo.name || "")
      .filter(Boolean)
      .join(", ");

    return `I found ${repos.length} repositories: ${names}`;
  }

  if (step.tool === "intent_find_my_repos") {
    const repos = Array.isArray(result?.result?.repos)
      ? (result.result.repos as Array<{ fullName?: string; name?: string }>)
      : [];

    if (!repos.length) {
      return "I could not find any repositories matching that name in your account.";
    }

    const names = repos
      .map((repo) => repo.fullName || repo.name || "")
      .filter(Boolean)
      .join(", ");

    return `I found ${repos.length} matching repositories: ${names}`;
  }

  if (step.tool === "intent_list_repo_issues") {
    const issues = Array.isArray(result?.result?.issues)
      ? (result.result.issues as Array<{ number?: number; title?: string; state?: string }>)
      : [];
    const state = String(result?.result?.state || step.input?.state || "open");
    const repo = String(result?.result?.repo || step.input?.repo || "this repository");

    if (!issues.length) {
      return `I found no ${state} issues in ${repo}.`;
    }

    const preview = issues
      .slice(0, 8)
      .map((issue) => `#${issue.number} ${issue.title || "(untitled)"}`)
      .join(", ");

    return `I found ${issues.length} ${state} issues in ${repo}: ${preview}`;
  }

  const client = getGroqClient();
  const model = getLlmModel("gemini-3.1-pro-preview");

  const system =
    "You are an assistant summarizing a tool call result for the user. " +
    "Be concise, 1-2 sentences, no markdown. " +
    "If the result includes a list, mention how many items and one example.";

  const user = JSON.stringify({ task, step, result });

  const completion = await createChatCompletionWithFallback(
    client,
    model,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    0.2,
  );

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

export function getToolAwareValidationPrompt(tool: string, reason: string) {
  const normalizedTool = String(tool || "").toLowerCase();
  const normalizedReason = String(reason || "").toLowerCase();

  if (
    normalizedTool === "intent_create_branch" ||
    normalizedTool === "intent_delete_branch"
  ) {
    if (normalizedReason.includes("(branchname)")) {
      return "I could not complete the branch action because the branch name was invalid or not found. Please provide a valid branch name and I will retry.";
    }
    if (normalizedReason.includes("(repo)")) {
      return "I need the target repository (owner/repo) to continue the branch action.";
    }
    return "I could not complete the branch action because required fields were invalid. Please provide the repository and branch details and I will retry.";
  }

  if (normalizedTool === "intent_manage_issue") {
    if (normalizedReason.includes("(title)")) {
      return "I could not create the issue because the title was invalid. Please provide a clear issue title and I will retry.";
    }
    if (normalizedReason.includes("(issue_number)")) {
      return "I need a valid issue number to continue. Which issue number should I use?";
    }
    return "I could not complete the issue action because required fields were invalid. Please provide the missing issue details and I will retry.";
  }

  return "I could not complete this action because required fields were invalid. Please provide the missing details and I will retry.";
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
      let step = normalizeStep(run.plan[stepIndex]);
      run.plan[stepIndex] = step;
      const stepRecord = getOrCreateStepRecord(run, stepIndex, step);

      const availableTools = await listAllTools(run.userId);
      const validation = validateAllSteps([step], availableTools);
      if (!validation.valid) {
        run.status = "NEEDS_INPUT";
        run.pendingFieldCapture = {
          field: String(validation.missingField || ""),
          stepIndex,
          frozenSteps: run.plan.map((planStep) => normalizeStep(planStep)),
        };
        trace(run, "status", "Waiting for user input");
        run.messages.push({
          role: "agent",
          text:
            validation.missingFieldQuestion ||
            `I need ${validation.missingField} to proceed.`,
        });
        return;
      }

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
          const limit = Number(step.input?.limit || 10);
          const repo = String(previous?.input?.repo || run.context.repo || "");
          step.input.text = buildIssuesSummary(
            issues,
            limit,
            stateLabel,
            repo || undefined,
          );
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

      const githubUsername = await getGithubUsernameFromVault(run.userId);
      const rectifySourceMessage = String(
        run.context.followUpText || run.task || "",
      );
      const rectified = rectify(
        { tool: String(step.tool || ""), input: { ...(step.input || {}) } },
        rectifySourceMessage,
        githubUsername || undefined,
      );

      if (rectified.type === "NEEDS_INPUT") {
        run.status = "NEEDS_INPUT";
        run.pendingRectify = {
          frozenToolCall: rectified.frozenToolCall || {
            tool: String(step.tool || ""),
            input: { ...(step.input || {}) },
          },
          missingField: String(rectified.missingField || ""),
        };
        trace(run, "status", "Waiting for rectified required input");
        run.messages.push({
          role: "agent",
          text:
            rectified.question ||
            `I need ${rectified.missingField || "additional input"} to proceed.`,
        });
        return;
      }

      if (rectified.toolCall) {
        step = {
          ...step,
          tool: rectified.toolCall.tool,
          input: rectified.toolCall.input,
        };
        run.plan[stepIndex] = step;
        stepRecord.tool = step.tool;
        stepRecord.input = step.input;
      }
      run.pendingRectify = null;

      const response = await executeToolWithPolicy(
        run.userId,
        `${run.id}:${stepIndex + 1}`,
        step.tool,
        step.input,
        { confirmed: false, stepUpId: null },
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
        run.userId,
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

        if (
          String(responseBody.reason || "")
            .toLowerCase()
            .startsWith("issues disabled in repository:")
        ) {
          run.status = "NEEDS_INPUT";
          trace(run, "status", "Repository has issues disabled");
          run.messages.push({
            role: "agent",
            text:
              "That repository has GitHub Issues disabled, so I cannot create an issue there. Share another repository with Issues enabled, and I will retry.",
          });
          return;
        }

        if (
          String(responseBody.reason || "")
            .toLowerCase()
            .startsWith("input validation failed")
        ) {
          run.status = "NEEDS_INPUT";
          trace(run, "status", "Waiting for required issue input");
          run.messages.push({
            role: "agent",
            text: getToolAwareValidationPrompt(
              step.tool,
              String(responseBody.reason || ""),
            ),
          });
          return;
        }

        if (stepRecord.retries < 1) {
          const tools = await listAllTools(run.userId);
          const toolIndex = getToolIndex(tools);
          const recovery = await generateRecoveryAction(
            run.task,
            run.context,
            step,
            responseBody.reason || "Tool error",
            tools,
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
  executionContext?: { githubToken?: string | null },
) {
  input = normalizeStepInput(input || {});
  if ((input as any)[CF.BRANCH_NAME] && !(input as any).branchName) {
    (input as any).branchName = (input as any)[CF.BRANCH_NAME];
  }
  if ((input as any)[CF.BASE_BRANCH] && !(input as any).fromBranch) {
    (input as any).fromBranch = (input as any)[CF.BASE_BRANCH];
  }
  if ((input as any)[CF.ISSUE_NUMBER] && !(input as any).issueNumber) {
    (input as any).issueNumber = (input as any)[CF.ISSUE_NUMBER];
  }
  if (
    typeof (input as any)[CF.REPO_OWNER] === "string" &&
    typeof (input as any)[CF.REPO_NAME] === "string" &&
    !(String((input as any)[CF.REPO_NAME] || "").includes("/"))
  ) {
    (input as any)[CF.REPO_NAME] = `${String((input as any)[CF.REPO_OWNER]).trim()}/${String((input as any)[CF.REPO_NAME]).trim()}`;
  }

  const tools = await listAllTools(userId);
  const tools = await listAllTools();
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

  const githubTokenFromContext = executionContext?.githubToken || null;
  const resolveRepoFromInput = (value: Record<string, any>) => {
    const repository = String((value as any).repository || "").trim();
    if (repository) return repository;

    const owner = String((value as any).owner || "").trim();
    const repo = String((value as any).repo || "").trim();
    if (owner && repo) return `${owner}/${repo}`;

    return repo;
  };

  if (toolInfo.needsRepo && toolInfo.domain === "github") {
    const repo = resolveRepoFromInput(input);
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
      const accessToken =
        githubTokenFromContext || (await getGithubAccessToken(userId));
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
      } else if (matches.length === 0) {
        const reasoning = buildDecisionReason(tool, input);
        await prisma.auditLog.create({
          data: {
            userId,
            requestId,
            toolName: tool,
            inputJson: JSON.stringify(input),
            decision: "DENIED",
            reason: `Repo not found for name: ${resolvedRepo}`,
            reasoning,
            executed: false,
          },
        });
        return {
          statusCode: 400,
          body: {
            status: "denied",
            reason: "Repo not found in your GitHub list. Use owner/repo.",
          },
        };
      } else if (matches.length > 1) {
        const reasoning = buildDecisionReason(tool, input);
        await prisma.auditLog.create({
          data: {
            userId,
            requestId,
            toolName: tool,
            inputJson: JSON.stringify(input),
            decision: "DENIED",
            reason: `Multiple repos matched name: ${resolvedRepo}`,
            reasoning,
            executed: false,
          },
        });
        return {
          statusCode: 400,
          body: {
            status: "denied",
            reason: "Multiple repos matched that name. Use owner/repo.",
          },
        };
        if (!(input as any).repository) {
          (input as any).repository = resolvedRepo;
        }
        if (!(input as any).owner || !(input as any).repo) {
          const parsed = parseRepo(resolvedRepo);
          (input as any).owner = parsed.owner;
          (input as any).repo = parsed.name;
        }
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
        return false;
      });
      if (match) {
        allowed = match as any;
        resolvedRepo = match.resourceId.includes("/")
          ? match.resourceId
          : resolvedRepo;
        (input as any).repo = resolvedRepo;
        if (!(input as any).repository) {
          (input as any).repository = resolvedRepo;
        }
        if (!(input as any).owner || !(input as any).repo) {
          const parsed = parseRepo(resolvedRepo);
          (input as any).owner = parsed.owner;
          (input as any).repo = parsed.name;
        }
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
    const valid = Boolean(
      session && session.userId === userId && session.expiresAt > now,
    );

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
        } else if (matches.length === 0) {
          const reasoning = buildDecisionReason(tool, input);
          await prisma.auditLog.create({
            data: {
              userId,
              requestId,
              toolName: tool,
              inputJson: JSON.stringify(input),
              decision: "DENIED",
              reason: `Repo not found for name: ${repo}`,
              reasoning,
              executed: false,
            },
          });
          return {
            statusCode: 400,
            body: {
              status: "denied",
              reason: "Repo not found in your GitHub list. Use owner/repo.",
            },
          };
        } else if (matches.length > 1) {
          const reasoning = buildDecisionReason(tool, input);
          await prisma.auditLog.create({
            data: {
              userId,
              requestId,
              toolName: tool,
              inputJson: JSON.stringify(input),
              decision: "DENIED",
              reason: `Multiple repos matched name: ${repo}`,
              reasoning,
              executed: false,
            },
          });
          return {
            statusCode: 400,
            body: {
              status: "denied",
              reason: "Multiple repos matched that name. Use owner/repo.",
            },
          };
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

  if (toolInfo.needsRepo && (input as any).repo) {
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
    const rawMessage = String(err?.message || "Execution failed");
    const inputValidationMatch = rawMessage.match(
      /^INPUT_VALIDATION:([^:]+):(.+)$/,
    );
    const issuesDisabledMatch = rawMessage.match(
      /^ISSUES_DISABLED:([^:]+):(.+)$/,
    );
    const genericIssuesDisabled =
      !issuesDisabledMatch &&
      /issues\s+has\s+been\s+disabled\s+in\s+this\s+repository/i.test(
        rawMessage,
      );
    const repoFromInput = String((input as any)?.repo || "").trim();
    const normalizedReason = inputValidationMatch
      ? `Input validation failed (${inputValidationMatch[1]}): ${inputValidationMatch[2]}`
      : issuesDisabledMatch
        ? `Issues disabled in repository: ${issuesDisabledMatch[1]}`
        : genericIssuesDisabled
          ? `Issues disabled in repository: ${repoFromInput || "unknown repo"}`
          : rawMessage;

    await prisma.auditLog.create({
      data: {
        userId,
        requestId,
        toolName: tool,
        inputJson: JSON.stringify(input),
        decision: "ERROR",
        reason: normalizedReason,
        reasoning: buildDecisionReason(tool, input),
        executed: false,
      },
    });

    return {
      statusCode:
        inputValidationMatch
          ? 400
          : issuesDisabledMatch || genericIssuesDisabled
            ? 409
            : 500,
      body: { status: "error", reason: normalizedReason },
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
    const limit = Number(step.input?.limit || 10);
    const repo = String(previous?.input?.repo || run.context.repo || "");
    step.input.text = buildIssuesSummary(
      issues,
      limit,
      stateLabel,
      repo || undefined,
    );
  }
}
