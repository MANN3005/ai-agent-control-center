const rawCorsOrigin =
  process.env.CORS_ORIGIN || process.env.WEB_ORIGIN || "http://localhost:5173";

function normalizeOrigin(value: string) {
  return String(value || "")
    .trim()
    .replace(/\/$/, "");
}

export const corsOrigins = rawCorsOrigin
  .split(",")
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);

export const AGENT_MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 8);

export const AUTH0_GITHUB_CONNECTION =
  process.env.AUTH0_GITHUB_CONNECTION || "github";
export const AUTH0_SLACK_CONNECTION =
  process.env.AUTH0_SLACK_CONNECTION || "slack";
export const AUTH0_GOOGLE_CONNECTION =
  process.env.AUTH0_GOOGLE_CONNECTION || "google-oauth2";

export function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}
