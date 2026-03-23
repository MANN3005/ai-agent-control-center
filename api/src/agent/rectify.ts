export interface LLMToolCall {
  tool: string;
  input: Record<string, any>;
}

export interface RectifyResult {
  type: "READY" | "NEEDS_INPUT";
  toolCall?: LLMToolCall;
  missingField?: string;
  question?: string;
  frozenToolCall?: LLMToolCall;
}

const FIELD_ALIASES: Record<string, string> = {
  issueNumber: "issue_number",
  issueNumbers: "issue_number",
  issue_id: "issue_number",
  issueNo: "issue_number",
  number: "issue_number",

  prNumber: "pull_number",
  pullNumber: "pull_number",
  pr_number: "pull_number",

  repository: "repo",
  repo_name: "repo",
  repoName: "repo",

  username: "owner",
  user: "owner",
  author: "owner",

  branch_name: "branch",
  branchName: "branch",
  ref: "branch",
  head_ref: "head",

  text: "body",
  content: "body",
  comment: "body",
  description: "body",

  channel_id: "channel",
  channelId: "channel",
};

const ACTION_TO_STATE: Record<string, string> = {
  close: "closed",
  delete: "closed",
  remove: "closed",
  resolve: "closed",
  reopen: "open",
  open: "open",
  unclose: "open",
};

const REQUIRED_FIELDS: Record<string, string[]> = {
  github_list_issues: ["repo"],
  github_get_issue: ["repo", "issue_number"],
  github_update_issue: ["repo", "issue_number"],
  github_add_issue_comment: ["repo", "issue_number", "body"],
  github_create_issue: ["repo", "title"],
  github_list_pull_requests: ["repo"],
  github_get_pull_request: ["repo", "pull_number"],
  github_get_pull_request_comments: ["repo", "pull_number"],
  github_get_pull_request_files: ["repo", "pull_number"],
  github_get_pull_request_reviews: ["repo", "pull_number"],
  github_get_pull_request_status: ["repo", "pull_number"],
  github_merge_pull_request: ["repo", "pull_number"],
  github_update_pull_request_branch: ["repo", "pull_number"],
  github_create_pull_request: ["repo", "title", "head", "base"],
  github_create_pull_request_review: ["repo", "pull_number", "event"],
  github_create_branch: ["repo", "branch"],
  github_list_commits: ["repo"],
  github_get_file_contents: ["repo", "path"],
  github_create_or_update_file: ["repo", "path", "content", "message", "branch"],
  github_push_files: ["repo", "branch", "files", "message"],
  github_search_repositories: ["query"],
  github_search_issues: ["query"],
  github_search_code: ["query"],
  github_search_users: ["query"],
  github_create_repository: ["name"],
  github_fork_repository: ["owner", "repo"],
};

const FIELD_QUESTIONS: Record<string, string> = {
  repo: "Which repository?",
  issue_number: "Which issue number?",
  pull_number: "Which PR number?",
  branch: "What should the branch be named?",
  base: "Which branch should this merge into? (target/base branch)",
  head: "Which branch should be merged? (source branch)",
  title: "What should the title be?",
  body: "What should the content/message be?",
  path: "What is the file path? (e.g. src/index.ts)",
  content: "What should the file content be?",
  message: "What should the commit message be?",
  event: "What type of review? (APPROVE / REQUEST_CHANGES / COMMENT)",
  query: "What should I search for?",
  files: "What files and their content should I push?",
  name: "What should the repository be named?",
  owner: "Who is the owner of the repository?",
};

export function rectify(
  rawLLMOutput: LLMToolCall,
  userMessage: string,
  auth0GithubUsername?: string,
): RectifyResult {
  let { tool, input } = rawLLMOutput;
  input = { ...(input || {}) };
  const isGithubTool = String(tool || "").startsWith("github_");

  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (input[alias] != null && input[canonical] == null) {
      input[canonical] = input[alias];
    }
    delete input[alias];
  }

  if (typeof input.repo === "string" && input.repo.includes("/")) {
    const parts = input.repo.split("/");
    if (parts.length === 2) {
      input.owner = input.owner ?? parts[0];
      input.repo = parts[1];
    }
  }

  if (!input.owner || !input.repo) {
    const fullRepoMatch = userMessage.match(/\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\b/);
    if (fullRepoMatch) {
      input.owner = input.owner ?? fullRepoMatch[1];
      input.repo = input.repo ?? fullRepoMatch[2];
    }
  }

  if (input.issue_number == null) {
    const m =
      userMessage.match(/issue\s*#\s*(\d+)/i) ||
      userMessage.match(/#(\d+)/) ||
      userMessage.match(/issue\s+(\d+)/i);
    if (m) input.issue_number = parseInt(m[1], 10);
  }

  if (input.pull_number == null) {
    const m = userMessage.match(/(?:PR|pull\s*request)\s*#?\s*(\d+)/i);
    if (m) input.pull_number = parseInt(m[1], 10);
  }

  if (input.issue_number != null) {
    input.issue_number = parseInt(String(input.issue_number), 10);
  }
  if (input.pull_number != null) {
    input.pull_number = parseInt(String(input.pull_number), 10);
  }

  if (tool === "github_update_issue" && input.action != null) {
    const normalizedState = ACTION_TO_STATE[String(input.action).toLowerCase()];
    if (normalizedState) {
      input.state = normalizedState;
    }
    delete input.action;
  }

  if (tool === "github_update_issue" && input.state != null) {
    const normalized = ACTION_TO_STATE[String(input.state).toLowerCase()];
    if (normalized) input.state = normalized;
  }

  if (tool === "github_update_issue" && input.state == null) {
    if (/\b(close|delete|remove|resolve|archive)\b/i.test(userMessage)) {
      input.state = "closed";
    }
    if (/\b(reopen|re-open|unclose)\b/i.test(userMessage)) {
      input.state = "open";
    }
  }

  if (isGithubTool && input.owner == null && auth0GithubUsername) {
    input.owner = auth0GithubUsername;
  }

  for (const key of Object.keys(input)) {
    if (input[key] == null || input[key] === "") {
      delete input[key];
    }
  }

  const required = REQUIRED_FIELDS[tool] ?? [];
  for (const field of required) {
    if (input[field] == null) {
      return {
        type: "NEEDS_INPUT",
        missingField: field,
        question:
          FIELD_QUESTIONS[field] || `I need a value for "${field}" to proceed.`,
        frozenToolCall: { tool, input },
      };
    }
  }

  return {
    type: "READY",
    toolCall: { tool, input },
  };
}
