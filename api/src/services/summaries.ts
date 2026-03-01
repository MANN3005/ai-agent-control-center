export function buildGithubSummary(
  repos: Array<{
    fullName?: string;
    name?: string;
    updatedAt?: string;
    private?: boolean;
  }>,
  limit: number,
) {
  const sorted = [...repos].sort((a, b) => {
    const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bTime - aTime;
  });

  const top = sorted.slice(0, limit);
  const lines = top.map((repo) => {
    const name = repo.fullName || repo.name || "unknown";
    const updated = repo.updatedAt
      ? new Date(repo.updatedAt).toLocaleDateString()
      : "unknown";
    const visibility = repo.private ? "private" : "public";
    return `- ${name} (${visibility}, updated ${updated})`;
  });

  const remainder =
    repos.length > limit ? `\n...and ${repos.length - limit} more` : "";
  return `GitHub summary: ${repos.length} repos.\n${lines.join("\n")}${remainder}`;
}

export function buildIssuesSummary(
  issues: Array<{
    number?: number;
    title?: string;
    state?: string;
    htmlUrl?: string;
  }>,
  limit: number,
  stateLabel: string,
) {
  const top = issues.slice(0, limit);
  const lines = top.map((issue) => {
    const num = typeof issue.number === "number" ? `#${issue.number}` : "#?";
    const title = issue.title || "untitled";
    return `- ${num} ${title}`;
  });
  const remainder =
    issues.length > limit ? `\n...and ${issues.length - limit} more` : "";
  return `GitHub ${stateLabel} issues: ${issues.length}.\n${lines.join("\n")}${remainder}`;
}

export function buildSingleIssueSummary(issue: {
  number?: number;
  title?: string;
  state?: string;
  htmlUrl?: string;
  assignees?: string[];
}) {
  const num = typeof issue.number === "number" ? `#${issue.number}` : "#?";
  const title = issue.title || "untitled";
  const state = issue.state || "unknown";
  const assignees =
    Array.isArray(issue.assignees) && issue.assignees.length
      ? `\nAssignees: ${issue.assignees.join(", ")}`
      : "\nAssignees: none";
  const link = issue.htmlUrl ? `\n${issue.htmlUrl}` : "";
  return `GitHub issue ${num} (${state}): ${title}${assignees}${link}`;
}
