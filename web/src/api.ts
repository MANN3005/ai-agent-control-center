const API_BASE = "http://localhost:4000";

export async function getMe() {
  const res = await fetch(`${API_BASE}/me`);
  return res.json();
}

export async function getPolicies() {
  const res = await fetch(`${API_BASE}/policies`);
  return res.json();
}

export async function putPolicies(policies: any[]) {
  const res = await fetch(`${API_BASE}/policies`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policies }),
  });
  return res.json();
}