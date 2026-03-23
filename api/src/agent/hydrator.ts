import { getGithubAccessToken, getSlackAccessToken } from "../services/auth0";
import { AgentStep, ToolDefinition } from "../types";
import { normalizeFields, resolveRepoFields } from "./fieldRegistry";

export interface HydrationContext {
  auth0UserId: string;
  githubUsername?: string;
  githubOrg?: string;
  slackUserId?: string;
  slackWorkspace?: string;
  previousStepOutputs: Record<string, any>;
  sessionMetadata: Record<string, string>;
}

export type SemanticFieldClass =
  | "IDENTITY_OWNER"
  | "IDENTITY_USERNAME"
  | "IDENTITY_ORG"
  | "IDENTITY_WORKSPACE"
  | "PREVIOUS_OUTPUT"
  | "UNKNOWN";

function textOf(fieldName: string, fieldSchema: any) {
  const description = String(fieldSchema?.description || "").toLowerCase();
  const name = String(fieldName || "").toLowerCase();
  return `${name} ${description}`;
}

function containsAny(source: string, words: string[]) {
  return words.some((word) => source.includes(word));
}

export function classifyField(fieldName: string, fieldSchema: any): SemanticFieldClass {
  const text = textOf(fieldName, fieldSchema);

  if (
    containsAny(text, ["owner", "author", "creator", "user", "assignee", " me ", " my ", " self"]) ||
    text.includes("the authenticated user") ||
    text.includes("repository owner")
  ) {
    return "IDENTITY_OWNER";
  }

  if (containsAny(text, ["username", "login", "handle", "account"])) {
    return "IDENTITY_USERNAME";
  }

  if (
    containsAny(text, ["org", "organization", "company", "workspace", "team"]) ||
    text.includes("your organization")
  ) {
    return "IDENTITY_ORG";
  }

  if (containsAny(text, ["workspace", "channel_id", "team_id"])) {
    return "IDENTITY_WORKSPACE";
  }

  if (containsAny(text, ["issue_number", "repo_name", "pr_number", " id", " ref"])) {
    return "PREVIOUS_OUTPUT";
  }

  return "UNKNOWN";
}

function isEmpty(value: any) {
  return value === undefined || value === null || String(value).trim() === "";
}

function findFromPreviousOutputs(fieldName: string, previousStepOutputs: Record<string, any>) {
  const needle = String(fieldName || "").toLowerCase();
  const entries = Object.entries(previousStepOutputs || {});

  for (const [, output] of entries.reverse()) {
    if (!output || typeof output !== "object") continue;
    const pairs = Object.entries(output as Record<string, any>);
    for (const [key, value] of pairs) {
      const keyLower = key.toLowerCase();
      if (
        keyLower.includes(needle) ||
        (needle.includes("number") && keyLower.includes("number")) ||
        (needle.includes("repo") && keyLower.includes("repo")) ||
        (needle.includes("id") && keyLower.endsWith("id"))
      ) {
        if (!isEmpty(value)) return value;
      }
    }
  }

  return undefined;
}

function logHydration(stepTool: string, field: string, value: any) {
  const preview =
    typeof value === "string" ? value.slice(0, 80) : JSON.stringify(value).slice(0, 80);
  console.info(`[HYDRATOR] tool=${stepTool} field=${field} value=${preview}`);
}

export class ContextHydrator {
  hydrate(
    steps: AgentStep[],
    tools: ToolDefinition[],
    context: HydrationContext,
  ): AgentStep[] {
    const toolIndex = new Map(tools.map((tool) => [tool.name, tool]));

    return steps.map((step) => {
      const toolInfo = toolIndex.get(step.tool);
      if (!toolInfo) return step;

      const schema = (toolInfo.inputSchema || {}) as Record<string, any>;
      const properties =
        schema.properties && typeof schema.properties === "object"
          ? (schema.properties as Record<string, any>)
          : {};

      const input =
        step.input && typeof step.input === "object"
          ? resolveRepoFields(normalizeFields({ ...step.input }))
          : {};
      const hydratedFields = Array.isArray(step.hydratedFields)
        ? [...step.hydratedFields]
        : [];

      for (const [fieldName, fieldSchema] of Object.entries(properties)) {
        if (!isEmpty(input[fieldName])) continue;

        const semanticClass = classifyField(fieldName, fieldSchema);
        let nextValue: any = undefined;

        if (semanticClass === "IDENTITY_OWNER") {
          nextValue = context.githubUsername || context.githubOrg;
        } else if (semanticClass === "IDENTITY_USERNAME") {
          nextValue = context.githubUsername;
        } else if (semanticClass === "IDENTITY_ORG") {
          nextValue = context.githubOrg || context.slackWorkspace;
        } else if (semanticClass === "IDENTITY_WORKSPACE") {
          nextValue = context.slackWorkspace;
        } else if (semanticClass === "PREVIOUS_OUTPUT") {
          nextValue = findFromPreviousOutputs(fieldName, context.previousStepOutputs);
        }

        if (!isEmpty(nextValue)) {
          input[fieldName] = nextValue;
          hydratedFields.push(fieldName);
          logHydration(step.tool, fieldName, nextValue);
        }
      }

      return {
        ...step,
        input: resolveRepoFields(normalizeFields(input)),
        hydratedFields,
      };
    });
  }
}

async function resolveGithubIdentity(userId: string) {
  try {
    const token = await getGithubAccessToken(userId);
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) return { githubUsername: undefined, githubOrg: undefined };
    const data = (await response.json()) as { login?: string; company?: string };
    return {
      githubUsername: data?.login ? String(data.login) : undefined,
      githubOrg: data?.company ? String(data.company) : undefined,
    };
  } catch {
    return { githubUsername: undefined, githubOrg: undefined };
  }
}

async function resolveSlackIdentity(userId: string) {
  try {
    const token = await getSlackAccessToken(userId);
    const response = await fetch("https://slack.com/api/auth.test", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) return { slackUserId: undefined, slackWorkspace: undefined };
    const data = (await response.json()) as { user_id?: string; team?: string; ok?: boolean };
    if (!data?.ok) return { slackUserId: undefined, slackWorkspace: undefined };
    return {
      slackUserId: data.user_id ? String(data.user_id) : undefined,
      slackWorkspace: data.team ? String(data.team) : undefined,
    };
  } catch {
    return { slackUserId: undefined, slackWorkspace: undefined };
  }
}

export async function buildHydrationContext(
  auth0UserId: string,
  previousOutputs: Record<string, any>,
): Promise<HydrationContext> {
  const [githubIdentity, slackIdentity] = await Promise.all([
    resolveGithubIdentity(auth0UserId),
    resolveSlackIdentity(auth0UserId),
  ]);

  return {
    auth0UserId,
    githubUsername: githubIdentity.githubUsername,
    githubOrg: githubIdentity.githubOrg,
    slackUserId: slackIdentity.slackUserId,
    slackWorkspace: slackIdentity.slackWorkspace,
    previousStepOutputs: previousOutputs || {},
    sessionMetadata: {},
  };
}
