const API_BASE = "http://localhost:4000";

async function authedFetch(path: string, accessToken: string, init?: RequestInit) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

export async function getMe(accessToken: string) {
  const res = await authedFetch("/me", accessToken);
  return res.json();
}

export async function getPolicies(accessToken: string) {
  const res = await authedFetch("/policies", accessToken);
  return res.json();
}

export async function putPolicies(accessToken: string, policies: any[]) {
  const res = await authedFetch("/policies", accessToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policies }),
  });
  return res.json();
}