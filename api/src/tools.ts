import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolDefinition } from "./types";
import { getGithubAccessToken, getSlackAccessToken } from "./services/auth0";
import {
  githubCloseIssue,
  githubCommentIssue,
  githubCreateIssue,
  githubCreateIssueWithAssignee,
  githubListIssues,
  githubListPulls,
  githubListRepos,
  githubReopenIssue,
  parseRepo,
} from "./services/github";
import {
  slackLookupUserByEmail,
  slackOpenDm,
  slackPostMessage,
} from "./services/slack";
import { recordAnnouncement } from "./slack-intake";

type SupportedProvider = "github" | "slack";

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, any> | null;
};

type RiskLevel = ToolDefinition["defaultRisk"];
const MCP_DISCOVERY_TIMEOUT_MS = Number(
  process.env.MCP_DISCOVERY_TIMEOUT_MS || 2500,
);
const TOOLS_CACHE_TTL_MS = Number(process.env.TOOLS_CACHE_TTL_MS || 60000);
const TOOLS_CACHE = new Map<
  string,
  { at: number; tools: ToolDefinition[] }
>();
const TOOLS_INFLIGHT = new Map<string, Promise<ToolDefinition[]>>();

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function getListedToolsArray(listed: any): McpTool[] {
  if (Array.isArray(listed)) return listed as McpTool[];
  if (Array.isArray(listed?.tools)) return listed.tools as McpTool[];
  return [];
}

async function createMcpClient(
  userId: string,
  provider: SupportedProvider,
): Promise<Client | null> {
  try {
    const command = "npx";
    let args: string[] = [];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string | undefined>),
    } as Record<string, string>;

    if (provider === "github") {
      const token = await getGithubAccessToken(userId);
      args = ["-y", "@modelcontextprotocol/server-github"];
      env["GITHUB_PERSONAL_ACCESS_TOKEN"] = token;
    } else if (provider === "slack") {
      const token = await getSlackAccessToken(userId);
      args = ["-y", "@modelcontextprotocol/server-slack"];
      env["SLACK_BOT_TOKEN"] = token;
    }

    const transport = new StdioClientTransport({
      command,
      args,
      env,
      stderr: "pipe",
    });

    const client = new Client(
      { name: "ai-agent-control-center", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  } catch (error) {
    console.error(`[MCP] Failed to connect to ${provider} MCP server:`, error);
    return null;
  }
}

function inferNeedsRepo(provider: SupportedProvider, tool: McpTool) {
  if (provider !== "github") return false;
  const haystack = `${tool.name} ${tool.description || ""}`.toLowerCase();
  // Repository catalog/discovery tools should be usable without owner/repo context.
  if (
    /list[_\s-]*repositor|search[_\s-]*repositor|repositor(?:y|ies)[_\s-]*list|list[_\s-]*repos\b|search[_\s-]*repos\b/.test(
      haystack,
    )
  ) {
    return false;
  }
  return /issue|pull\s*request|\bpr\b|commit|branch|tag|release|tree|content|file|blob|compare/.test(
    haystack,
  );
}

function inferRiskLevel(tool: McpTool): RiskLevel {
  const haystack = `${tool.name} ${tool.description || ""}`.toLowerCase();
  if (/delete|remove|reopen|close/.test(haystack)) return "HIGH";
  if (/create|update|post|manage|comment/.test(haystack)) return "MEDIUM";
  return "LOW";
}

function mapDefaultMode(risk: RiskLevel): ToolDefinition["defaultMode"] {
  if (risk === "HIGH") return "STEP_UP";
  if (risk === "MEDIUM") return "CONFIRM";
  return "AUTO";
}

async function listProviderTools(
  userId: string,
  provider: SupportedProvider,
): Promise<Array<{ provider: SupportedProvider; tool: McpTool }>> {
  const client = await withTimeout(
    createMcpClient(userId, provider),
    MCP_DISCOVERY_TIMEOUT_MS,
    `[MCP] connect:${provider}`,
  ).catch((error) => {
    console.warn(`[MCP] Discovery connect fallback for ${provider}:`, error);
    return null;
  });
  if (!client) return [];

  try {
    const listed = (await withTimeout(
      client.listTools() as Promise<any>,
      MCP_DISCOVERY_TIMEOUT_MS,
      `[MCP] listTools:${provider}`,
    )) as any;
    const tools = getListedToolsArray(listed);

    return tools
      .filter((tool: any) => tool && typeof tool.name === "string")
      .map((tool: any) => ({ provider, tool: tool as McpTool }));
  } finally {
    if (typeof (client as any).close === "function") {
      await (client as any).close();
    }
  }
}

async function callGithubMcpTool(
  userId: string,
  candidates: string[],
  args: Record<string, any>,
) {
  const client = await createMcpClient(userId, "github");
  if (!client) {
    throw new Error("Unable to connect to github MCP server");
  }

  try {
    const listed = (await client.listTools()) as any;
    const tools = getListedToolsArray(listed);
    const lowerCandidates = candidates.map((name) => name.toLowerCase());

    const matched = tools.find((tool) => {
      const name = String(tool.name || "").toLowerCase();
      return lowerCandidates.includes(name);
    });

    if (!matched) {
      throw new Error(
        `No matching github MCP tool for candidates: ${candidates.join(", ")}`,
      );
    }

    const result = await client.callTool({
      name: matched.name,
      arguments: args,
    });

    return {
      executedTool: matched.name,
      provider: "github",
      content: result.content,
    };
  } finally {
    if (typeof (client as any).close === "function") {
      await (client as any).close();
    }
  }
}

export function listLocalTools(): ToolDefinition[] {
  return [
    {
      name: "github_explorer",
      domain: "github",
      needsRepo: false,
      defaultRisk: "LOW",
      defaultMode: "AUTO",
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async (handlerUserId: string) => {
        const token = await getGithubAccessToken(handlerUserId);
        const userRes = await fetch("https://api.github.com/user", {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
          },
        });
        if (!userRes.ok) {
          throw new Error("Unable to resolve GitHub profile for current user");
        }
        const userData = (await userRes.json()) as { login?: string };
        const login = String(userData?.login || "").trim();
        if (!login) {
          throw new Error("GitHub login was not available for current user");
        }

        const repos: Array<{
          id: number;
          name: string;
          fullName: string;
          private: boolean;
          htmlUrl: string;
          updatedAt: string | null;
        }> = [];

        for (let page = 1; page <= 10; page += 1) {
          const repoRes = await fetch(
            `https://api.github.com/user/repos?visibility=all&affiliation=owner&sort=updated&per_page=100&page=${page}`,
            {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
              },
            },
          );

          if (!repoRes.ok) {
            throw new Error("Failed to list repositories from GitHub API");
          }

          const pageRepos = (await repoRes.json()) as Array<any>;
          if (!Array.isArray(pageRepos) || pageRepos.length === 0) {
            break;
          }

          repos.push(
            ...pageRepos.map((repo) => ({
              id: Number(repo.id),
              name: String(repo.name || ""),
              fullName: String(repo.full_name || repo.name || ""),
              private: Boolean(repo.private),
              htmlUrl: String(repo.html_url || ""),
              updatedAt: repo.updated_at ? String(repo.updated_at) : null,
            })),
          );

          if (pageRepos.length < 100) {
            break;
          }
        }

        return {
          executedTool: "github_user_repos",
          provider: "github",
          owner: login,
          total: repos.length,
          repos,
        };
      },
    },
    {
      name: "intent_create_repository",
      description:
        "Use this to create a new GitHub repository. Requires repository name.",
      needsRepo: false,
      defaultRisk: "MEDIUM",
      defaultMode: "CONFIRM",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          private: { type: "boolean" },
          auto_init: { type: "boolean" },
        },
        required: ["name"],
      },
      handler: async (handlerUserId: string, input: Record<string, any>) => {
        const token = await getGithubAccessToken(handlerUserId);
        const name = String(input.name || "").trim();
        if (!name) {
          throw new Error("INPUT_VALIDATION:name:Repository name is required.");
        }

        const createRes = await fetch("https://api.github.com/user/repos", {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name,
            description: input.description
              ? String(input.description)
              : undefined,
            private: Boolean(input.private),
            auto_init: Boolean(input.auto_init),
          }),
        });

        if (!createRes.ok) {
          const payload = (await createRes.json().catch(() => ({}))) as {
            message?: string;
          };
          throw new Error(
            payload.message ||
              `Failed to create repository '${name}' (status ${createRes.status})`,
          );
        }

        const repo = (await createRes.json()) as {
          name?: string;
          full_name?: string;
          html_url?: string;
          private?: boolean;
        };

        return {
          executedTool: "github_create_repository",
          provider: "github",
          name: String(repo.name || name),
          fullName: String(repo.full_name || ""),
          htmlUrl: String(repo.html_url || ""),
          private: Boolean(repo.private),
        };
      },
    },
    {
      name: "intent_list_repo_issues",
      description:
        "Use this to list issues for a repository. Requires repo, optional state=open|closed|all.",
      needsRepo: true,
      defaultRisk: "LOW",
      defaultMode: "AUTO",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
        },
        required: ["repo"],
      },
      handler: async (handlerUserId: string, input: Record<string, any>) => {
        const repoValue = String(input.repo || "").trim();
        const [owner, repo] = repoValue.includes("/")
          ? repoValue.split("/")
          : ["", ""];
        if (!owner || !repo) {
          throw new Error("repo must be provided as owner/repo");
        }

        const state = String(input.state || "open").toLowerCase();
        if (!["open", "closed", "all"].includes(state)) {
          throw new Error(
            "INPUT_VALIDATION:state:state must be open, closed, or all",
          );
        }

        const token = await getGithubAccessToken(handlerUserId);
        const issues: Array<{
          number: number;
          title: string;
          state: string;
          htmlUrl: string;
          createdAt: string | null;
          updatedAt: string | null;
        }> = [];

        for (let page = 1; page <= 10; page += 1) {
          const issuesRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=100&page=${page}`,
            {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
              },
            },
          );

          if (!issuesRes.ok) {
            throw new Error(
              `Failed to list issues for ${owner}/${repo} (status ${issuesRes.status})`,
            );
          }

          const pageIssues = (await issuesRes.json()) as Array<any>;
          if (!Array.isArray(pageIssues) || pageIssues.length === 0) {
            break;
          }

          const filtered = pageIssues.filter((item) => !item?.pull_request);
          issues.push(
            ...filtered.map((item) => ({
              number: Number(item.number),
              title: String(item.title || ""),
              state: String(item.state || ""),
              htmlUrl: String(item.html_url || ""),
              createdAt: item.created_at ? String(item.created_at) : null,
              updatedAt: item.updated_at ? String(item.updated_at) : null,
            })),
          );

          if (pageIssues.length < 100) break;
        }

        return {
          executedTool: "github_list_repo_issues",
          provider: "github",
          repo: `${owner}/${repo}`,
          state,
          total: issues.length,
          issues,
        };
      },
    },
    {
      name: "intent_create_branch",
      description:
        "Use this to create a new branch in a repository. Requires repo and branchName, optional fromBranch.",
      domain: "github",
      needsRepo: true,
      defaultRisk: "LOW",
      defaultMode: "AUTO",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          branchName: { type: "string" },
          fromBranch: { type: "string" },
        },
        required: ["repo", "branchName"],
      },
      handler: async (handlerUserId: string, input: Record<string, any>) => {
        const repoValue = String(input.repo || "").trim();
        const [owner, repo] = repoValue.includes("/")
          ? repoValue.split("/")
          : ["", ""];
        if (!owner || !repo) {
          throw new Error("repo must be provided as owner/repo");
        }

        const branchName = String(input.branchName || "").trim();
        if (!branchName) {
          throw new Error(
            "INPUT_VALIDATION:branchName:branchName is required to create a branch.",
          );
        }
        if (!/^[A-Za-z0-9._/-]+$/.test(branchName)) {
          throw new Error(
            "INPUT_VALIDATION:branchName:branchName contains invalid characters.",
          );
        }

        const token = await getGithubAccessToken(handlerUserId);
        let fromBranch = String(input.fromBranch || "").trim();

        if (!fromBranch) {
          const repoRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}`,
            {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
              },
            },
          );
          if (!repoRes.ok) {
            throw new Error(
              `Failed to load repository metadata for ${owner}/${repo} (status ${repoRes.status})`,
            );
          }
          const repoMeta = (await repoRes.json()) as {
            default_branch?: string;
          };
          fromBranch =
            String(repoMeta.default_branch || "main").trim() || "main";
        }

        const baseRefRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token}`,
            },
          },
        );
        if (!baseRefRes.ok) {
          throw new Error(
            `INPUT_VALIDATION:fromBranch:Base branch '${fromBranch}' was not found in ${owner}/${repo}.`,
          );
        }
        const baseRef = (await baseRefRes.json()) as {
          object?: { sha?: string };
        };
        const sha = String(baseRef?.object?.sha || "").trim();
        if (!sha) {
          throw new Error("Failed to resolve base branch commit SHA");
        }

        const createRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/refs`,
          {
            method: "POST",
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ref: `refs/heads/${branchName}`,
              sha,
            }),
          },
        );

        if (!createRes.ok) {
          const payload = (await createRes.json().catch(() => ({}))) as {
            message?: string;
          };
          const message = String(payload?.message || "");
          if (/reference already exists/i.test(message)) {
            throw new Error(
              `INPUT_VALIDATION:branchName:Branch '${branchName}' already exists in ${owner}/${repo}.`,
            );
          }
          throw new Error(
            `Failed to create branch '${branchName}' in ${owner}/${repo} (status ${createRes.status})`,
          );
        }

        return {
          executedTool: "github_create_branch",
          provider: "github",
          repo: `${owner}/${repo}`,
          branchName,
          fromBranch,
          baseSha: sha,
        };
      },
    },
    {
      name: "intent_delete_branch",
      description:
        "Use this to delete an existing branch from a repository. Requires repo and branchName.",
      needsRepo: true,
      defaultRisk: "HIGH",
      defaultMode: "STEP_UP",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          branchName: { type: "string" },
        },
        required: ["branchName", "repo"],
      },
      handler: async (handlerUserId: string, input: Record<string, any>) => {
        const repoValue = String(input.repo || "").trim();
        const [owner, repo] = repoValue.includes("/")
          ? repoValue.split("/")
          : ["", ""];
        if (!owner || !repo) {
          throw new Error("repo must be provided as owner/repo");
        }

        const branchName = String(input.branchName || "").trim();
        if (!branchName) {
          throw new Error(
            "INPUT_VALIDATION:branchName:branchName is required to delete a branch.",
          );
        }

        const protectedNames = new Set(["main", "master", "develop", "dev"]);
        if (protectedNames.has(branchName.toLowerCase())) {
          throw new Error(
            `INPUT_VALIDATION:branchName:Refusing to delete protected branch '${branchName}'.`,
          );
        }

        const token = await getGithubAccessToken(handlerUserId);
        const encodedBranch = encodeURIComponent(branchName);

        const branchRefRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodedBranch}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token}`,
            },
          },
        );

        if (!branchRefRes.ok) {
          throw new Error(
            `INPUT_VALIDATION:branchName:Branch '${branchName}' was not found in ${owner}/${repo}.`,
          );
        }

        const deleteRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodedBranch}`,
          {
            method: "DELETE",
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token}`,
            },
          },
        );

        if (deleteRes.status !== 204) {
          const payload = (await deleteRes.json().catch(() => ({}))) as {
            message?: string;
          };
          const message = String(payload?.message || "");
          if (/reference does not exist/i.test(message)) {
            throw new Error(
              `INPUT_VALIDATION:branchName:Branch '${branchName}' was not found in ${owner}/${repo}.`,
            );
          }
          throw new Error(
            `Failed to delete branch '${branchName}' in ${owner}/${repo} (status ${deleteRes.status})`,
          );
        }

        return {
          executedTool: "github_delete_branch",
          provider: "github",
          repo: `${owner}/${repo}`,
          branchName,
        };
      },
    },
    {
      name: "intent_manage_issue",
      description:
        "Use this to create, close, reopen, or comment on issues. Requires repo and action.",
      needsRepo: true,
      defaultRisk: "MEDIUM",
      defaultMode: "CONFIRM",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "close", "reopen", "comment"],
          },
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          issue_number: { type: "number" },
          comment: { type: "string" },
        },
        required: ["action", "repo"],
      },
      handler: async (handlerUserId: string, input: Record<string, any>) => {
        const action = String(input.action || "").toLowerCase();
        const repoValue = String(input.repo || "");
        const [owner, repo] = repoValue.includes("/")
          ? repoValue.split("/")
          : ["", ""];
        if (!owner || !repo) {
          throw new Error("repo must be provided as owner/repo");
        }

        if (action === "create") {
          const title = String(input.title || "").trim();
          if (!title) {
            throw new Error(
              "INPUT_VALIDATION:title:Issue title is required to create an issue.",
            );
          }
          if (title.length < 3) {
            throw new Error(
              "INPUT_VALIDATION:title:Issue title must be at least 3 characters.",
            );
          }

          const token = await getGithubAccessToken(handlerUserId);
          const repoMetaRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}`,
            {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
              },
            },
          );

          if (repoMetaRes.ok) {
            const repoMeta = (await repoMetaRes.json()) as {
              has_issues?: boolean;
            };
            if (repoMeta.has_issues === false) {
              throw new Error(
                `ISSUES_DISABLED:${owner}/${repo}:GitHub Issues is disabled for this repository`,
              );
            }
          }

          try {
            return await callGithubMcpTool(
              handlerUserId,
              ["create_issue", "post_issue", "github_create_issue"],
              {
                owner,
                repo,
                title,
                body: input.body ? String(input.body) : undefined,
              },
            );
          } catch (err: any) {
            const message = String(err?.message || "");
            if (/validation\s+failed/i.test(message)) {
              throw new Error(
                "INPUT_VALIDATION:title:GitHub rejected the issue payload. Provide a specific title and try again.",
              );
            }
            if (
              /issues\s+has\s+been\s+disabled\s+in\s+this\s+repository/i.test(
                message,
              )
            ) {
              throw new Error(
                `ISSUES_DISABLED:${owner}/${repo}:GitHub Issues is disabled for this repository`,
              );
            }
            throw err;
          }
        }

        const issueNumber = Number(
          input.issue_number || input.issueNumber || 0,
        );
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
          throw new Error(
            "issue_number is required for close, reopen, or comment",
          );
        }

        if (action === "comment") {
          return callGithubMcpTool(
            handlerUserId,
            [
              "create_issue_comment",
              "add_issue_comment",
              "comment_issue",
              "github_add_issue_comment",
            ],
            {
              owner,
              repo,
              issue_number: issueNumber,
              body: String(input.comment || input.body || "").trim(),
            },
          );
        }

        if (action === "close" || action === "reopen") {
          const state = action === "close" ? "closed" : "open";
          return callGithubMcpTool(
            handlerUserId,
            [
              "update_issue",
              "close_issue",
              "reopen_issue",
              "github_update_issue",
            ],
            {
              owner,
              repo,
              issue_number: issueNumber,
              state,
            },
          );
        }

        throw new Error("Unsupported action for intent_manage_issue");
      },
    },
    {
      name: "intent_find_my_repos",
      description:
        "Use this to find repositories by name within the user's own GitHub account. Requires a specific query.",
      domain: "slack",
      needsRepo: false,
      defaultRisk: "LOW",
      defaultMode: "AUTO",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      handler: async (handlerUserId: string, input: Record<string, any>) => {
        const token = await getGithubAccessToken(handlerUserId);
        const userRes = await fetch("https://api.github.com/user", {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
          },
        });
        if (!userRes.ok) {
          throw new Error("Unable to resolve GitHub profile for current user");
        }
        const userData = (await userRes.json()) as { login?: string };
        const login = String(userData?.login || "").trim();
        if (!login) {
          throw new Error("GitHub login was not available for current user");
        }

        const query = String(input.query || "")
          .trim()
          .toLowerCase();
        if (!query) {
          throw new Error("query is required for intent_find_my_repos");
        }

        const repos: Array<{
          id: number;
          name: string;
          fullName: string;
          private: boolean;
          htmlUrl: string;
          updatedAt: string | null;
        }> = [];

        for (let page = 1; page <= 10; page += 1) {
          const repoRes = await fetch(
            `https://api.github.com/user/repos?visibility=all&affiliation=owner&sort=updated&per_page=100&page=${page}`,
            {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
              },
            },
          );
          if (!repoRes.ok) {
            throw new Error("Failed to list repositories from GitHub API");
          }

          const pageRepos = (await repoRes.json()) as Array<any>;
          if (!Array.isArray(pageRepos) || pageRepos.length === 0) {
            break;
          }

          repos.push(
            ...pageRepos.map((repo) => ({
              id: Number(repo.id),
              name: String(repo.name || ""),
              fullName: String(repo.full_name || repo.name || ""),
              private: Boolean(repo.private),
              htmlUrl: String(repo.html_url || ""),
              updatedAt: repo.updated_at ? String(repo.updated_at) : null,
            })),
          );

          if (pageRepos.length < 100) break;
        }

        const filtered = repos.filter((repo) => {
          const nameLower = repo.name.toLowerCase();
          const fullLower = repo.fullName.toLowerCase();
          return nameLower.includes(query) || fullLower.includes(query);
        });

        return {
          executedTool: "github_find_user_repos",
          provider: "github",
          owner: login,
          query,
          total: filtered.length,
          repos: filtered,
        };
      },
    },
  ];
}

export async function listAllTools(userId?: string): Promise<ToolDefinition[]> {
  const facadeTools = listLocalTools();
  if (!userId) {
    return facadeTools;
  }

  const now = Date.now();
  const cached = TOOLS_CACHE.get(userId);
  if (cached && now - cached.at < TOOLS_CACHE_TTL_MS) {
    return cached.tools;
  }

  const inflight = TOOLS_INFLIGHT.get(userId);
  if (inflight) {
    return inflight;
  }

  const resolveTools = (async () => {
    const discovered = await Promise.all([
      listProviderTools(userId, "github"),
      listProviderTools(userId, "slack"),
    ]).catch((error) => {
      console.warn("[MCP] Discovery fallback to local tools:", error);
      return [[], []] as Array<
        Array<{ provider: SupportedProvider; tool: McpTool }>
      >;
    });

    const mappedMcpTools = discovered
      .flat()
      .map(({ provider, tool: mcpTool }) => {
        const defaultRisk = inferRiskLevel(mcpTool);
        let enrichedDescription = mcpTool.description || "";
        const name = mcpTool.name.toLowerCase();

        if (name.includes("search")) {
          enrichedDescription +=
            "\n\nCRITICAL RULE: NEVER use generic wildcards like '*'. You MUST extract specific nouns from the user's prompt for the query.";
        } else if (name.includes("create") || name.includes("post")) {
          enrichedDescription +=
            "\n\nCRITICAL RULE: You MUST provide highly specific, non-generic data for titles and descriptions based on user intent.";
        }

        return {
          name: `${provider}_${mcpTool.name}`,
          description: enrichedDescription,
          inputSchema: mcpTool.inputSchema ?? null,
          needsRepo: inferNeedsRepo(provider, mcpTool),
          defaultRisk,
          defaultMode: mapDefaultMode(defaultRisk),
          handler: async (handlerUserId: string, input: Record<string, any>) => {
            const client = await createMcpClient(handlerUserId, provider);
            if (!client) {
              throw new Error(`Unable to connect to ${provider} MCP server`);
            }
            try {
              const result = await client.callTool({
                name: mcpTool.name,
                arguments: input,
              });
              return {
                executedTool: mcpTool.name,
                provider,
                content: result.content,
              };
            } finally {
              if (typeof (client as any).close === "function") {
                await (client as any).close();
              }
            }
          },
        };
      });

    // Keep only safe/simple raw MCP tools to reduce prompt/context bloat.
    const filteredRawTools = mappedMcpTools.filter((tool) =>
      tool.name.startsWith("slack_"),
    );

    const merged = [...facadeTools, ...filteredRawTools];
    TOOLS_CACHE.set(userId, { at: Date.now(), tools: merged });
    return merged;
  })();

  TOOLS_INFLIGHT.set(userId, resolveTools);

  try {
    return await resolveTools;
  } finally {
    TOOLS_INFLIGHT.delete(userId);
  }
}

export function getToolIndex(tools: ToolDefinition[]) {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export function formatToolListForPrompt(tools: ToolDefinition[]) {
  return tools
    .map((tool) => {
      const description = tool.description ? ` - ${tool.description}` : "";
      const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema) : "{}";
      return `${tool.name}${description}\n  inputSchema: ${schema}`;
    })
    .join("\n");
}
