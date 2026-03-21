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
    user?: string | null;
    updatedAt?: string;
  }>,
  limit: number,
  stateLabel: string,
  repo?: string,
) {
  const safeLimit = Math.max(1, limit);
  const state = (stateLabel || "open").toLowerCase();
  const repoLabel = repo ? ` for ${repo}` : "";

  if (!issues.length) {
    return `Issue summary${repoLabel} (${state}): 0 issues found.`;
  }

  const top = issues.slice(0, safeLimit);
  const lines = top.map((issue) => {
    const num = typeof issue.number === "number" ? `#${issue.number}` : "#?";
    const title = issue.title || "untitled";
    const byUser = issue.user ? ` by @${issue.user}` : "";
    const updated = issue.updatedAt
      ? `, updated ${new Date(issue.updatedAt).toISOString().slice(0, 10)}`
      : "";
    const link = issue.htmlUrl ? `\n  ${issue.htmlUrl}` : "";
    return `- ${num} ${title}${byUser}${updated}${link}`;
  });

  const shownCount = Math.min(issues.length, safeLimit);
  const remainder =
    issues.length > safeLimit ? `\n...and ${issues.length - safeLimit} more issue(s).` : "";

  return [
    `Issue summary${repoLabel} (${state}): ${issues.length} issue(s).`,
    `Top ${shownCount}:`,
    lines.join("\n"),
    remainder,
  ]
    .join("\n")
    .trim();
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
