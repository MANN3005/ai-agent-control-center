export enum CF {
  ISSUE_NUMBER = "issue_number",
  ISSUE_TITLE = "title",
  ISSUE_BODY = "body",
  ISSUE_ACTION = "action",
  REPO_OWNER = "owner",
  REPO_NAME = "repo",
  REPO_FULL = "full_repo",
  BRANCH_NAME = "branch",
  BASE_BRANCH = "base_branch",
  PR_NUMBER = "pr_number",
  ASSIGNEE = "assignee",
  LABEL = "label",
  QUERY = "query",
  MESSAGE = "message",
  CHANNEL = "channel",
  USERNAME = "username",
  ORG = "org",
  ACTION = "action",
}

export const FIELD_ALIASES: Record<string, CF> = {
  issue_number: CF.ISSUE_NUMBER,
  issueNumber: CF.ISSUE_NUMBER,
  issueNumbers: CF.ISSUE_NUMBER,
  issue_id: CF.ISSUE_NUMBER,
  number: CF.ISSUE_NUMBER,
  issueNo: CF.ISSUE_NUMBER,
  "#": CF.ISSUE_NUMBER,

  repository: CF.REPO_NAME,
  repo_name: CF.REPO_NAME,
  repoName: CF.REPO_NAME,

  owner: CF.REPO_OWNER,
  user: CF.REPO_OWNER,
  author: CF.REPO_OWNER,

  branch_name: CF.BRANCH_NAME,
  branchName: CF.BRANCH_NAME,
  ref: CF.BRANCH_NAME,
  head: CF.BRANCH_NAME,

  pr_number: CF.PR_NUMBER,
  prNumber: CF.PR_NUMBER,
  pullNumber: CF.PR_NUMBER,
  pull_number: CF.PR_NUMBER,

  action: CF.ACTION,
  operation: CF.ACTION,
  verb: CF.ACTION,

  text: CF.MESSAGE,
  content: CF.MESSAGE,
  channel_id: CF.CHANNEL,
  channelId: CF.CHANNEL,
};

const ACTION_ALIASES: Record<string, string> = {
  delete: "close",
  remove: "close",
  archive: "close",
  hide: "close",
  fix: "close",
  resolve: "close",
  reopen: "reopen",
  open: "reopen",
  unclose: "reopen",
  comment: "comment",
  reply: "comment",
  respond: "comment",
};

export function normalizeAction(action: string): string {
  return ACTION_ALIASES[String(action || "").toLowerCase()] ?? action;
}

export function normalizeFields(input: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(input || {})) {
    const canonical = FIELD_ALIASES[key] ?? key;
    if (result[canonical] == null || value != null) {
      result[canonical] = value;
    }
  }

  if (result[CF.ACTION]) {
    result[CF.ACTION] = normalizeAction(String(result[CF.ACTION]));
  }

  return result;
}

export function resolveRepoFields(input: Record<string, any>): Record<string, any> {
  const out = { ...(input || {}) };

  if (out[CF.REPO_FULL] && typeof out[CF.REPO_FULL] === "string") {
    const parts = out[CF.REPO_FULL].split("/");
    if (parts.length === 2) {
      out[CF.REPO_OWNER] = out[CF.REPO_OWNER] ?? parts[0];
      out[CF.REPO_NAME] = out[CF.REPO_NAME] ?? parts[1];
    }
  }

  if (out[CF.REPO_NAME] && String(out[CF.REPO_NAME]).includes("/")) {
    const parts = String(out[CF.REPO_NAME]).split("/");
    if (parts.length === 2) {
      out[CF.REPO_OWNER] = out[CF.REPO_OWNER] ?? parts[0];
      out[CF.REPO_NAME] = parts[1];
    }
  }

  return out;
}
