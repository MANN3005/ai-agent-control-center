const API_BASE = "http://localhost:4000";

type Policy = {
  toolName: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  mode: "AUTO" | "CONFIRM" | "STEP_UP";
};

async function authedFetch(
  path: string,
  accessToken: string,
  init?: RequestInit,
) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

// ----- existing -----
export async function getMe(accessToken: string) {
  const res = await authedFetch("/me", accessToken);
  return res.json();
}

export async function getPolicies(accessToken: string) {
  const res = await authedFetch("/policies", accessToken);
  return res.json();
}

export async function putPolicies(accessToken: string, policies: Policy[]) {
  const res = await authedFetch("/policies", accessToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policies }),
  });
  return res.json();
}

// ----- allow-list -----
export async function getAllowedRepos(accessToken: string) {
  const res = await authedFetch(
    "/allowed-resources?provider=github&resourceType=repo",
    accessToken,
  );
  return res.json();
}

export async function putAllowedRepos(accessToken: string, repos: string[]) {
  const res = await authedFetch("/allowed-resources", accessToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "github",
      resourceType: "repo",
      resources: repos,
    }),
  });
  return res.json();
}

// ----- step-up -----
export async function startStepUp(accessToken: string) {
  const res = await authedFetch("/step-up/start", accessToken, {
    method: "POST",
  });
  return res.json();
}

// ----- tool execute -----
export async function executeTool(
  accessToken: string,
  body: {
    requestId: string;
    tool: string;
    input: Record<string, unknown>;
    approval?: { confirmed?: boolean; stepUpId?: string | null };
  },
) {
  const res = await authedFetch("/tools/execute", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ----- agent run -----
export async function runAgent(
  accessToken: string,
  body: {
    requestId: string;
    task: string;
    context?: Record<string, unknown>;
  },
) {
  const res = await authedFetch("/agent/run", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function getAgentRun(accessToken: string, runId: string) {
  const res = await authedFetch(`/agent/runs/${runId}`, accessToken);
  return res.json();
}

export async function continueAgent(
  accessToken: string,
  body: {
    runId: string;
    message?: string;
    approval?: { confirmed?: boolean; stepUpId?: string | null };
  },
) {
  const res = await authedFetch("/agent/continue", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ----- audit -----
export async function getAudit(accessToken: string, limit = 50) {
  const res = await authedFetch(`/audit?limit=${limit}`, accessToken);
  if (!res.ok) return []; // prevent JSON parse crash
  return res.json();
}

// ----- identities -----
export async function getIdentities(accessToken: string) {
  const res = await authedFetch("/debug/identities", accessToken);
  return res.json();
}

// ----- identity link/unlink -----
export async function linkIdentity(
  accessToken: string,
  body: { primaryUserId: string; secondaryUserId: string; provider?: string },
) {
  const res = await authedFetch("/auth/link", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.reason || "Link failed.");
  }
  return data;
}

export async function unlinkIdentity(
  accessToken: string,
  body: { provider: string; providerUserId: string },
) {
  const res = await authedFetch("/auth/unlink", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.reason || "Unlink failed.");
  }
  return data;
}
