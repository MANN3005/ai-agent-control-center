export function parseRepo(repo: string) {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error("Invalid repo format. Expected owner/repo");
  }
  return { owner, name };
}

async function githubRequest<T>(
  accessToken: string,
  url: string,
  init?: RequestInit,
) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ai-agent-control-center",
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!res.ok) {
    const message = data?.message || `GitHub API error ${res.status}`;
    throw new Error(message);
  }

  return data as T;
}

export async function githubListIssues(
  accessToken: string,
  owner: string,
  repo: string,
  state: string,
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}`;
  const items = await githubRequest<any[]>(accessToken, url);
  const issues = items.filter((i) => !i.pull_request);

  return issues.map((i) => ({
    id: i.id,
    number: i.number,
    title: i.title,
    state: i.state,
    htmlUrl: i.html_url,
    user: i.user?.login ?? null,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  }));
}

export async function githubCreateIssue(
  accessToken: string,
  owner: string,
  repo: string,
  title: string,
  body?: string,
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues`;
  const created = await githubRequest<any>(accessToken, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  });

  return {
    id: created.id,
    number: created.number,
    title: created.title,
    state: created.state,
    htmlUrl: created.html_url,
  };
}

export async function githubCloseIssue(
  accessToken: string,
  owner: string,
  repo: string,
  issueNumber: number,
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
  const updated = await githubRequest<any>(accessToken, url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });

  return {
    id: updated.id,
    number: updated.number,
    title: updated.title,
    state: updated.state,
    htmlUrl: updated.html_url,
  };
}

export async function githubGetIssue(
  accessToken: string,
  owner: string,
  repo: string,
  issueNumber: number,
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
  const issue = await githubRequest<any>(accessToken, url);
  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees.map((a: any) => a?.login).filter(Boolean)
    : [];
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    htmlUrl: issue.html_url,
    assignees,
  };
}

export async function githubListRepos(accessToken: string) {
  const url = "https://api.github.com/user/repos?per_page=100&sort=updated";
  const repos = await githubRequest<any[]>(accessToken, url);

  return repos.map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    htmlUrl: r.html_url,
    owner: r.owner?.login ?? null,
    updatedAt: r.updated_at,
  }));
}

export async function githubCreateIssueWithAssignee(
  accessToken: string,
  owner: string,
  repo: string,
  title: string,
  body: string | undefined,
  assignee: string,
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues`;
  return githubRequest<any>(accessToken, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, assignees: [assignee] }),
  });
}
