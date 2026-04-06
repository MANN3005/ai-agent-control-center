import {
  createJsonObjectCompletion,
  getGroqClient,
  getLlmModel,
} from "../services/llm";
import { AgentStep, ToolDefinition } from "../types";
import { buildIntentPrompt } from "./prompts/intent";
import { normalizeFields, resolveRepoFields } from "./fieldRegistry";

function safeJsonParse(value: string, fallback: any) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeStepInput(input: Record<string, any>) {
  return resolveRepoFields(normalizeFields(input || {}));
}

export type IntentCandidate = {
  toolName: string;
  description: string;
  requiredFields: string[];
  optionalFields: string[];
};

export function buildIntentTaxonomy(tools: ToolDefinition[]): IntentCandidate[] {
  return tools.map((tool) => {
    const schema = (tool.inputSchema || {}) as Record<string, any>;
    const requiredFields = Array.isArray(schema.required)
      ? (schema.required as string[])
      : [];
    const optionalFields =
      schema.properties && typeof schema.properties === "object"
        ? Object.keys(schema.properties as Record<string, any>).filter(
            (key) => !requiredFields.includes(key),
          )
        : [];

    return {
      toolName: tool.name,
      description: String(tool.description || "No description"),
      requiredFields,
      optionalFields,
    };
  });
}

function buildInputFromContext(candidate: IntentCandidate, context: Record<string, any>) {
  const input: Record<string, any> = {};
  for (const field of [...candidate.requiredFields, ...candidate.optionalFields]) {
    const value = context[field];
    if (value !== undefined && value !== null && String(value) !== "") {
      input[field] = value;
    }
  }

  if (!input.repo && context.repoCandidate) input.repo = context.repoCandidate;
  if (!input.query && context.query) input.query = context.query;

  return input;
}

function deterministicResolve(
  task: string,
  context: Record<string, any>,
  candidates: IntentCandidate[],
): { steps: AgentStep[]; question: string; confidence: number } {
  const normalized = task.toLowerCase();
  const has = (toolName: string) => candidates.find((c) => c.toolName === toolName);

  if (
    /\b(create|make|new)\b/.test(normalized) &&
    /\b(repo|repository)\b/.test(normalized) &&
    has("intent_create_repository")
  ) {
    const candidate = has("intent_create_repository")!;
    const input = buildInputFromContext(candidate, context);
    if (!input.name) {
      const quoted = task.match(/(?:named|called)\s+["']([^"']+)["']/i)?.[1];
      const plain = task.match(/(?:named|called)\s+([A-Za-z0-9._-]+)/i)?.[1];
      if (quoted) input.name = quoted.trim();
      else if (plain) input.name = plain.trim();
    }
    return {
      steps: [{ tool: "intent_create_repository", input }],
      question: "",
      confidence: 0.99,
    };
  }

  if (
    /\b(create|make|new)\b/.test(normalized) &&
    normalized.includes("branch") &&
    has("intent_create_branch")
  ) {
    const candidate = has("intent_create_branch")!;
    const input = buildInputFromContext(candidate, context);
    if (!input.branchName) {
      const branchMatch = task.match(
        /branch\s+(?:named|name|called)?\s*([A-Za-z0-9._/-]+)/i,
      );
      if (branchMatch?.[1]) input.branchName = branchMatch[1].trim();
    }
    if (!input.fromBranch) {
      const fromMatch = task.match(/(?:from|off|based on)\s+([A-Za-z0-9._/-]+)/i);
      if (fromMatch?.[1]) input.fromBranch = fromMatch[1].trim();
    }
    return {
      steps: [{ tool: "intent_create_branch", input }],
      question: "",
      confidence: 0.98,
    };
  }

  if (
    /\b(delete|remove)\b/.test(normalized) &&
    normalized.includes("branch") &&
    has("intent_delete_branch")
  ) {
    const candidate = has("intent_delete_branch")!;
    const input = buildInputFromContext(candidate, context);
    if (!input.branchName) {
      const branchMatch = task.match(
        /branch\s+(?:named|name|called)?\s*([A-Za-z0-9._/-]+)/i,
      );
      if (branchMatch?.[1]) input.branchName = branchMatch[1].trim();
    }
    return {
      steps: [{ tool: "intent_delete_branch", input }],
      question: "",
      confidence: 0.99,
    };
  }

  const mentionsIssue = normalized.includes("issue");
  const asksListIssues =
    /\b(list|show|get|view|see|fetch)\b/.test(normalized) ||
    /^open issues\b/.test(normalized) ||
    /^closed issues\b/.test(normalized) ||
    /all open issues|all closed issues/.test(normalized);
  const asksIssueMutation =
    /\b(create|open issue|close|reopen|comment|delete|remove)\b/.test(
      normalized,
    );

  if ((normalized.includes("all my repos") || normalized.includes("list my repos")) && has("intent_list_my_repos")) {
    return {
      steps: [{ tool: "intent_list_my_repos", input: buildInputFromContext(has("intent_list_my_repos")!, context) }],
      question: "",
      confidence: 0.98,
    };
  }

  if ((normalized.includes("find") || normalized.includes("search") || normalized.includes("named")) && normalized.includes("repo") && !/\b(create|make|new)\b/.test(normalized) && has("intent_find_my_repos")) {
    const candidate = has("intent_find_my_repos")!;
    const input = buildInputFromContext(candidate, context);
    if (!input.query) {
      const named = normalized.match(/(?:named|name)\s+([a-z0-9._-]+)/i)?.[1];
      if (named) input.query = named;
    }
    return {
      steps: [{ tool: "intent_find_my_repos", input }],
      question: "",
      confidence: 0.95,
    };
  }

  if (mentionsIssue && asksListIssues && !asksIssueMutation && has("intent_list_repo_issues")) {
    const candidate = has("intent_list_repo_issues")!;
    const input = buildInputFromContext(candidate, context);
    if (!input.state) {
      if (normalized.includes("closed")) input.state = "closed";
      else if (normalized.includes("all")) input.state = "all";
      else input.state = "open";
    }
    return {
      steps: [{ tool: "intent_list_repo_issues", input }],
      question: "",
      confidence: 0.97,
    };
  }

  if (normalized.includes("issue") && has("intent_manage_issue")) {
    const candidate = has("intent_manage_issue")!;
    const input = buildInputFromContext(candidate, context);
    if (!input.action) {
      if (normalized.includes("create") || normalized.includes("open")) input.action = "create";
      else if (normalized.includes("close")) input.action = "close";
      else if (normalized.includes("delete") || normalized.includes("remove")) input.action = "close";
      else if (normalized.includes("reopen")) input.action = "reopen";
      else if (normalized.includes("comment")) input.action = "comment";
    }
    return {
      steps: [{ tool: "intent_manage_issue", input }],
      question: "",
      confidence: 0.92,
    };
  }

  return { steps: [], question: "", confidence: 0 };
}

function missingRequiredFields(step: AgentStep, candidate: IntentCandidate | undefined) {
  const required = candidate?.requiredFields || [];
  return required.filter((field) => {
    const value = step.input?.[field];
    return value === undefined || value === null || String(value).trim() === "";
  });
}

function questionFor(field: string) {
  if (field === "repo") return "Which repository should I use (owner/repo)?";
  if (field === "name") return "What should the repository be named?";
  if (field === "query") return "What exact repo name or keyword should I search for?";
  if (field === "action") return "What issue action should I take (create, close, reopen, or comment)?";
  if (field === "branchName") return "What should the new branch be named?";
  if (field === "fromBranch") return "Which existing branch should I branch from?";
  if (field === "title") return "What should the issue title be?";
  if (field === "issueNumbers") return "Which issue number(s) should I target?";
  if (field === "comment") return "What comment should I post?";
  return `I need the ${field} to proceed.`;
}

export async function resolveIntentToPlan(
  task: string,
  context: Record<string, any>,
  tools: ToolDefinition[],
): Promise<{ steps: AgentStep[]; question: string }> {
  const candidates = buildIntentTaxonomy(tools);
  const deterministic = deterministicResolve(task, context, candidates);
  if (deterministic.confidence >= 0.9 && deterministic.steps.length > 0) {
    const step = deterministic.steps[0];
    step.input = normalizeStepInput(step.input || {});
    const candidate = candidates.find((c) => c.toolName === step.tool);
    const missing = missingRequiredFields(step, candidate);
    if (missing.length > 0) {
      step.missingFields = missing;
      step.clarificationQuestion = questionFor(missing[0]);
    }
    return { steps: [step], question: step.clarificationQuestion || "" };
  }

  const client = getGroqClient();
  const model = getLlmModel("gemini-3.1-pro-preview");
  const prompt = buildIntentPrompt(task, context, candidates);

  const completion = await createJsonObjectCompletion(
    client,
    model,
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    0.1,
  );

  const content = completion.choices[0]?.message?.content || "{}";
  const parsed = safeJsonParse(content, {}) as {
    tool?: string;
    input?: Record<string, any>;
    question?: string;
  };

  const selectedTool = String(parsed.tool || "").trim();
  const candidate = candidates.find((c) => c.toolName === selectedTool);
  if (!candidate) {
    return {
      steps: [],
      question:
        String(parsed.question || "").trim() ||
        "I need one more detail to route this safely. What exact resource should I target?",
    };
  }

  const step: AgentStep = {
    tool: selectedTool,
    input:
      parsed.input && typeof parsed.input === "object"
        ? { ...buildInputFromContext(candidate, context), ...parsed.input }
        : buildInputFromContext(candidate, context),
  };

  step.input = normalizeStepInput(step.input || {});

  const missing = missingRequiredFields(step, candidate);
  if (missing.length > 0) {
    step.missingFields = missing;
    step.clarificationQuestion = questionFor(missing[0]);
  }

  return {
    steps: [step],
    question: step.clarificationQuestion || String(parsed.question || "").trim(),
  };
}
