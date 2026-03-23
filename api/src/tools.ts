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
import { slackPostMessage } from "./services/slack";
import { slackLookupUserByEmail, slackOpenDm } from "./services/slack";
import { recordAnnouncement } from "./slack-intake";

export function listLocalTools(): ToolDefinition[] {
  return [
    {
      name: "github_explorer",
      domain: "github",
      needsRepo: false,
      defaultRisk: "LOW",
      defaultMode: "AUTO",
      description: "Explore GitHub resources (repos, issues, or PRs).",
      inputSchema: {
        type: "object",
        properties: {
          resource: { type: "string", enum: ["repos", "issues", "prs"] },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
        },
        required: ["resource"],
        additionalProperties: false,
      },
      handler: async (userId, input) => {
        const accessToken = await getGithubAccessToken(userId);
        const resource = String(input.resource || "repos");
        if (resource === "repos") {
          const repos = await githubListRepos(accessToken);
          return { repos };
        }

        const repo = String(input.repo || "");
        const { owner, name } = parseRepo(repo);
        const state = String(input.state || "open");
        if (resource === "prs") {
          const pulls = await githubListPulls(accessToken, owner, name, state);
          return { pulls };
        }

        const issues = await githubListIssues(accessToken, owner, name, state);
        return { issues };
      },
    },
    {
      name: "manage_issues",
      domain: "github",
      needsRepo: true,
      defaultRisk: "MEDIUM",
      defaultMode: "CONFIRM",
      description:
        "Create, close, reopen, or comment on GitHub issues (optionally notify via Slack).",
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
          comment: { type: "string" },
          issueNumbers: { type: "array", items: { type: "number" } },
          assignee: { type: "string" },
          assigneeEmail: { type: "string" },
        },
        required: ["action", "repo"],
        additionalProperties: false,
      },
      handler: async (userId, input) => {
        const action = String(input.action || "");
        const repo = String(input.repo || "");
        const { owner, name } = parseRepo(repo);

        if (action === "create") {
          const title = String(input.title || "");
          const body = input.body ? String(input.body) : undefined;
          let assignee = input.assignee ? String(input.assignee) : undefined;
          let assigneeEmail = input.assigneeEmail
            ? String(input.assigneeEmail)
            : undefined;
          const fallbackChannel = "new-issues";
          if (assignee && assignee.includes("@") && !assigneeEmail) {
            assigneeEmail = assignee;
            assignee = undefined;
          }

          const githubToken = await getGithubAccessToken(userId);
          const issue = assignee
            ? await githubCreateIssueWithAssignee(
                githubToken,
                owner,
                name,
                title,
                body,
                assignee,
              )
            : await githubCreateIssue(githubToken, owner, name, title, body);

          const intro = assignee
            ? "You have been assigned a GitHub issue:"
            : "A new GitHub issue was created:";
          const detailLines = [
            intro,
            `Repo: ${owner}/${name}`,
            `Title: ${issue.title}`,
            `Number: #${issue.number}`,
            `Link: ${issue.htmlUrl}`,
          ];
          const bodyLine = body ? `Body: ${body.slice(0, 500)}` : null;
          if (bodyLine) detailLines.push(bodyLine);
          const messageText = detailLines.join("\n");
          const channelMessageText = `If anyone is free, please look into this issue.\n${messageText}`;

          if (assigneeEmail) {
            const slackToken = await getSlackAccessToken(userId);
            const slackUser = await slackLookupUserByEmail(
              slackToken,
              assigneeEmail,
            );
            if (!slackUser.id) {
              throw new Error("Slack user not found for email");
            }
            const dmChannel = await slackOpenDm(slackToken, slackUser.id);
            if (!dmChannel) throw new Error("Failed to open Slack DM channel");
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
                htmlUrl: issue.htmlUrl,
                assignee: assignee ?? null,
              },
              slack: {
                ok: dmResult.ok,
                channel: dmResult.channel,
                mode: "dm",
              },
            };
          }

          if (fallbackChannel) {
            const slackToken = await getSlackAccessToken(userId);
            const channelResult = await slackPostMessage(
              slackToken,
              fallbackChannel,
              channelMessageText,
            );
            recordAnnouncement({
              channelId: channelResult.channel,
              threadTs: channelResult.ts,
              userId,
              owner,
              repo: name,
              issueNumber: issue.number,
            });
            return {
              issue: {
                id: issue.id,
                number: issue.number,
                title: issue.title,
                state: issue.state,
                htmlUrl: issue.htmlUrl,
                assignee: assignee ?? null,
              },
              slack: {
                ok: channelResult.ok,
                channel: channelResult.channel,
                mode: "channel",
              },
            };
          }

          return {
            issue: {
              id: issue.id,
              number: issue.number,
              title: issue.title,
              state: issue.state,
              htmlUrl: issue.htmlUrl,
              assignee: assignee ?? null,
            },
          };
        }

        if (action === "close") {
          const issueNumbers = Array.isArray((input as any).issueNumbers)
            ? (input as any).issueNumbers
                .map((n: any) => Number(n))
                .filter((n: number) => Number.isInteger(n) && n > 0)
            : [];
          if (!issueNumbers.length) {
            throw new Error("Missing or invalid issueNumbers for close");
          }
          const githubToken = await getGithubAccessToken(userId);
          const results = await Promise.all(
            issueNumbers.map((issueNumber: number) =>
              githubCloseIssue(githubToken, owner, name, issueNumber),
            ),
          );
          return { issues: results };
        }

        if (action === "reopen") {
          const issueNumbers = Array.isArray((input as any).issueNumbers)
            ? (input as any).issueNumbers
                .map((n: any) => Number(n))
                .filter((n: number) => Number.isInteger(n) && n > 0)
            : [];
          if (!issueNumbers.length) {
            throw new Error("Missing or invalid issueNumbers for reopen");
          }
          const githubToken = await getGithubAccessToken(userId);
          const results = await Promise.all(
            issueNumbers.map((issueNumber: number) =>
              githubReopenIssue(githubToken, owner, name, issueNumber),
            ),
          );
          return { issues: results };
        }

        if (action === "comment") {
          const issueNumbers = Array.isArray((input as any).issueNumbers)
            ? (input as any).issueNumbers
                .map((n: any) => Number(n))
                .filter((n: number) => Number.isInteger(n) && n > 0)
            : [];
          if (!issueNumbers.length) {
            throw new Error("Missing or invalid issueNumbers for comment");
          }
          const comment = String(input.comment || "");
          if (!comment) {
            throw new Error("Missing comment text");
          }
          const githubToken = await getGithubAccessToken(userId);
          const results = await Promise.all(
            issueNumbers.map((issueNumber: number) =>
              githubCommentIssue(
                githubToken,
                owner,
                name,
                issueNumber,
                comment,
              ),
            ),
          );
          return { comments: results };
        }

        throw new Error("Unsupported manage_issues action");
      },
    },
    {
      name: "slack_notifier",
      domain: "slack",
      needsRepo: false,
      defaultRisk: "MEDIUM",
      defaultMode: "CONFIRM",
      description: "Post a message or summary to Slack.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["post", "summary"] },
          channel: { type: "string" },
          text: { type: "string" },
          limit: { type: "number" },
        },
        required: ["action", "channel"],
        additionalProperties: false,
      },
      handler: async (userId, input) => {
        const action = String(input.action || "post");
        const channel = String(input.channel || "");
        const text = String(input.text || "");

        if (!channel) {
          throw new Error("Missing Slack channel");
        }
        if (!text) {
          throw new Error("Missing Slack message text");
        }

        const slackToken = await getSlackAccessToken(userId);
        const result = await slackPostMessage(slackToken, channel, text);
        return { ok: result.ok, channel, action };
      },
    },
  ];
}

export async function listAllTools() {
  return listLocalTools();
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
