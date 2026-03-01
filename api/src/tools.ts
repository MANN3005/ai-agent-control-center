import { ToolDefinition } from "./types";
import { getGithubAccessToken, getSlackAccessToken } from "./services/auth0";
import {
  githubCloseIssue,
  githubCreateIssue,
  githubCreateIssueWithAssignee,
  githubListIssues,
  githubListRepos,
  parseRepo,
} from "./services/github";
import {
  slackLookupUserByEmail,
  slackOpenDm,
  slackPostMessage,
} from "./services/slack";
import { buildGithubSummary } from "./services/summaries";

export function listLocalTools(): ToolDefinition[] {
  return [
    {
      name: "list_repos",
      needsRepo: false,
      defaultRisk: "LOW",
      defaultMode: "AUTO",
      description: "List GitHub repositories for the connected user.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async (userId) => {
        const accessToken = await getGithubAccessToken(userId);
        const repos = await githubListRepos(accessToken);
        return { repos };
      },
    },
    {
      name: "list_issues",
      needsRepo: true,
      defaultRisk: "LOW",
      defaultMode: "AUTO",
      description: "List GitHub issues for a repo.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
        },
        required: ["repo"],
      },
      handler: async (userId, input) => {
        const accessToken = await getGithubAccessToken(userId);
        const repo = String(input.repo || "");
        const { owner, name } = parseRepo(repo);
        const state = String(input.state || "open");
        const issues = await githubListIssues(accessToken, owner, name, state);
        return { issues };
      },
    },
    {
      name: "create_issue",
      needsRepo: true,
      defaultRisk: "MEDIUM",
      defaultMode: "CONFIRM",
      description: "Create a GitHub issue.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["repo", "title"],
      },
      handler: async (userId, input) => {
        const accessToken = await getGithubAccessToken(userId);
        const repo = String(input.repo || "");
        const { owner, name } = parseRepo(repo);
        const title = String(input.title || "");
        const body = input.body ? String(input.body) : undefined;
        const issue = await githubCreateIssue(
          accessToken,
          owner,
          name,
          title,
          body,
        );
        return { issue };
      },
    },
    {
      name: "create_issue_and_notify",
      needsRepo: true,
      defaultRisk: "HIGH",
      defaultMode: "STEP_UP",
      description:
        "Create a GitHub issue and DM the assignee on Slack (by email).",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          assignee: { type: "string" },
          assigneeEmail: { type: "string" },
        },
        required: ["repo", "title", "assignee", "assigneeEmail"],
        additionalProperties: false,
      },
      handler: async (userId, input) => {
        const repo = String(input.repo || "");
        const { owner, name } = parseRepo(repo);
        const title = String(input.title || "");
        const body = input.body ? String(input.body) : undefined;
        const assignee = String(input.assignee || "");
        const assigneeEmail = String(input.assigneeEmail || "");
        if (!assignee) throw new Error("Missing assignee");
        if (!assigneeEmail) throw new Error("Missing assigneeEmail");

        const githubToken = await getGithubAccessToken(userId);
        const issue = await githubCreateIssueWithAssignee(
          githubToken,
          owner,
          name,
          title,
          body,
          assignee,
        );

        const slackToken = await getSlackAccessToken(userId);
        const slackUser = await slackLookupUserByEmail(
          slackToken,
          assigneeEmail,
        );
        if (!slackUser.id) throw new Error("Slack user not found for email");
        const dmChannel = await slackOpenDm(slackToken, slackUser.id);
        if (!dmChannel) throw new Error("Failed to open Slack DM channel");

        const messageText = `You have been assigned a GitHub issue: #${issue.number} ${issue.title}\n${issue.html_url}`;
        const dmResult = await slackPostMessage(
          slackToken,
          dmChannel,
          messageText,
        );

        return {
          issue: {
            id: issue.id,
            number: issue.number,
            title: issue.title,
            state: issue.state,
            htmlUrl: issue.html_url,
            assignee,
          },
          slack: {
            ok: dmResult.ok,
            channel: dmResult.channel,
          },
        };
      },
    },
    {
      name: "close_issue",
      needsRepo: true,
      defaultRisk: "HIGH",
      defaultMode: "STEP_UP",
      description: "Close a GitHub issue.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          issueNumber: { type: "number" },
        },
        required: ["repo", "issueNumber"],
      },
      handler: async (userId, input) => {
        const accessToken = await getGithubAccessToken(userId);
        const repo = String(input.repo || "");
        const { owner, name } = parseRepo(repo);
        const issueNumber = Number(input.issueNumber);
        const issue = await githubCloseIssue(
          accessToken,
          owner,
          name,
          issueNumber,
        );
        return { issue };
      },
    },
    {
      name: "close_issues",
      needsRepo: true,
      defaultRisk: "HIGH",
      defaultMode: "STEP_UP",
      description: "Close multiple GitHub issues.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string" },
          issueNumbers: { type: "array", items: { type: "number" } },
        },
        required: ["repo", "issueNumbers"],
        additionalProperties: false,
      },
      handler: async (userId, input) => {
        const accessToken = await getGithubAccessToken(userId);
        const repo = String(input.repo || "");
        const { owner, name } = parseRepo(repo);
        const issueNumbers = Array.isArray((input as any).issueNumbers)
          ? (input as any).issueNumbers
              .map((n: any) => Number(n))
              .filter((n: number) => Number.isInteger(n) && n > 0)
          : [];
        if (!issueNumbers.length) {
          throw new Error("Missing or invalid issueNumbers for close_issues");
        }

        const results = await Promise.all(
          issueNumbers.map((issueNumber: number) =>
            githubCloseIssue(accessToken, owner, name, issueNumber),
          ),
        );

        return { issues: results };
      },
    },
    {
      name: "slack_post_message",
      needsRepo: false,
      defaultRisk: "HIGH",
      defaultMode: "STEP_UP",
      description: "Post a message to Slack.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string" },
          text: { type: "string" },
        },
        required: ["channel", "text"],
      },
      handler: async (userId, input) => {
        const accessToken = await getSlackAccessToken(userId);
        const channel = String(input.channel || "");
        const text = String(input.text || "");
        if (!channel) throw new Error("Missing channel");
        if (!text) throw new Error("Missing text");
        const result = await slackPostMessage(accessToken, channel, text);
        return { message: result };
      },
    },
    {
      name: "summarize_github_to_slack",
      needsRepo: false,
      defaultRisk: "HIGH",
      defaultMode: "STEP_UP",
      description: "Summarize GitHub repos and post to Slack.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string" },
          limit: { type: "number" },
        },
        required: ["channel"],
        additionalProperties: false,
      },
      handler: async (userId, input) => {
        const channel = String(input.channel || "");
        const limit = Number(
          input.limit || process.env.GITHUB_SUMMARY_LIMIT || 10,
        );
        if (!channel) throw new Error("Missing channel");
        const [githubToken, slackToken] = await Promise.all([
          getGithubAccessToken(userId),
          getSlackAccessToken(userId),
        ]);
        const repos = await githubListRepos(githubToken);
        const summary = buildGithubSummary(
          repos,
          Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 10,
        );
        const result = await slackPostMessage(slackToken, channel, summary);
        return { message: result, count: repos.length };
      },
    },
  ];
}

export function listAllTools(): ToolDefinition[] {
  return listLocalTools();
}

export function getToolIndex(tools: ToolDefinition[]) {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export function formatToolListForPrompt(tools: ToolDefinition[]) {
  return tools
    .map((tool) => {
      const desc = tool.description ? ` - ${tool.description}` : "";
      const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema) : "{}";
      return `${tool.name}${desc} inputSchema=${schema} defaultRisk=${tool.defaultRisk} defaultMode=${tool.defaultMode}`;
    })
    .join("\n");
}
