import { ManagementClient } from "auth0";
import {
  AUTH0_GITHUB_CONNECTION,
  AUTH0_GOOGLE_CONNECTION,
  AUTH0_SLACK_CONNECTION,
  requireEnv,
} from "../config";

let auth0ManagementClient: ManagementClient | null = null;

function userHasGithubIdentity(user: any) {
  const identities = Array.isArray(user?.identities) ? user.identities : [];
  return identities.some((identity: any) => {
    const provider = String(identity?.provider || "").toLowerCase();
    const connection = String(identity?.connection || "").toLowerCase();
    return (
      provider === "github" ||
      provider.includes("github") ||
      connection === String(AUTH0_GITHUB_CONNECTION || "").toLowerCase() ||
      connection === "github" ||
      connection.includes("github")
    );
  });
}

export function getAuth0ManagementClient() {
  if (auth0ManagementClient) return auth0ManagementClient;

  const domain = requireEnv("AUTH0_DOMAIN");
  const clientId = requireEnv("AUTH0_M2M_CLIENT_ID");
  const clientSecret = requireEnv("AUTH0_M2M_CLIENT_SECRET");
  const audience =
    process.env.AUTH0_MANAGEMENT_AUDIENCE || `https://${domain}/api/v2/`;

  auth0ManagementClient = new ManagementClient({
    domain,
    clientId,
    clientSecret,
    audience,
    scope: "read:users read:user_idp_tokens update:users",
  } as any);

  return auth0ManagementClient;
}

export async function getGithubAccessToken(userId: string) {
  const client = getAuth0ManagementClient();
  const userResponse: any = await client.users.get({ id: userId });
  const user = userResponse?.data ?? userResponse;
  const identities: any[] = user?.identities ?? [];
  const githubIdentity = identities.find(
    (identity) =>
      identity?.provider === "github" ||
      identity?.connection === AUTH0_GITHUB_CONNECTION,
  );
  const accessToken = githubIdentity?.access_token;

  if (!accessToken) {
    throw new Error("GitHub identity not connected in Auth0 Token Vault");
  }

  return accessToken as string;
}

export async function hasGithubIdentity(userId: string) {
  const client = getAuth0ManagementClient();
  const userResponse: any = await client.users.get({ id: userId });
  const user = userResponse?.data ?? userResponse;
  const identities: any[] = user?.identities ?? [];
  return identities.some(
    (identity) =>
      identity?.provider === "github" ||
      identity?.connection === AUTH0_GITHUB_CONNECTION,
  );
}

export async function getSlackAccessToken(userId: string) {
  const client = getAuth0ManagementClient();
  const userResponse: any = await client.users.get({ id: userId });
  const user = userResponse?.data ?? userResponse;
  const identities: any[] = user?.identities ?? [];
  const slackIdentity = identities.find(
    (identity) =>
      identity?.provider === "slack" ||
      identity?.connection === AUTH0_SLACK_CONNECTION,
  );
  const accessToken = slackIdentity?.access_token;

  if (!accessToken) {
    throw new Error("Slack identity not connected in Auth0 Token Vault");
  }

  return accessToken as string;
}

export async function getAuth0UserEmail(userId: string) {
  const client = getAuth0ManagementClient();
  const userResponse: any = await client.users.get({ id: userId });
  const user = userResponse?.data ?? userResponse;
  const email = user?.email as string | undefined;
  return email || null;
}

export async function hasSlackIdentity(userId: string) {
  const client = getAuth0ManagementClient();
  const userResponse: any = await client.users.get({ id: userId });
  const user = userResponse?.data ?? userResponse;
  const identities: any[] = user?.identities ?? [];
  return identities.some(
    (identity) =>
      identity?.provider === "sign-in-with-slack" ||
      identity?.connection === AUTH0_SLACK_CONNECTION,
  );
}

export async function findAuth0UserBySlackUserId(slackUserId: string) {
  const client = getAuth0ManagementClient();
  const exactQuery = `identities.user_id:"${slackUserId}" AND identities.connection:"${AUTH0_SLACK_CONNECTION}"`;
  const exactResponse: any = await client.users.getAll({
    q: exactQuery,
    search_engine: "v3",
  } as any);
  const exactUsers = exactResponse?.data ?? exactResponse ?? [];
  if (Array.isArray(exactUsers) && exactUsers.length) {
    const withGithub = exactUsers.find((user: any) => userHasGithubIdentity(user));
    return withGithub || exactUsers[0];
  }

  // Slack identity user_id is often namespaced like sign-in-with-slack|TEAM-USER.
  // Auth0 v3 search does not allow wildcard on identities.user_id, so query by
  // connection and match the trailing Slack user id locally.
  const connectionQuery = `identities.connection:"${AUTH0_SLACK_CONNECTION}"`;
  const connectionResponse: any = await client.users.getAll({
    q: connectionQuery,
    search_engine: "v3",
    per_page: 100,
  } as any);
  const users = connectionResponse?.data ?? connectionResponse ?? [];
  if (!Array.isArray(users)) return null;

  for (const user of users) {
    const identities = Array.isArray(user?.identities) ? user.identities : [];
    const match = identities.find((identity: any) => {
      const connection = String(identity?.connection || "");
      if (connection !== AUTH0_SLACK_CONNECTION) return false;
      const id = String(identity?.user_id || "");
      return id === slackUserId || id.endsWith(`-${slackUserId}`);
    });
    if (match) return user;
  }

  return null;
}

export async function findAuth0UserByEmail(email: string) {
  const client = getAuth0ManagementClient();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;

  const query = `email:"${normalizedEmail}"`;
  const response: any = await client.users.getAll({
    q: query,
    search_engine: "v3",
  } as any);
  const users = response?.data ?? response ?? [];
  if (!Array.isArray(users) || !users.length) return null;
  const withGithub = users.find((user: any) => userHasGithubIdentity(user));
  return withGithub || users[0];
}

export function getAuth0Connections() {
  return {
    github: AUTH0_GITHUB_CONNECTION,
    google: AUTH0_GOOGLE_CONNECTION,
    slack: AUTH0_SLACK_CONNECTION,
  };
}

export async function resolveCanonicalAuth0UserId(
  userId: string,
  email?: string | null,
) {
  const client = getAuth0ManagementClient();

  try {
    const userResponse: any = await client.users.get({ id: userId });
    const user = userResponse?.data ?? userResponse;
    const resolved = String(user?.user_id || userId);
    return resolved;
  } catch (err: any) {
    const statusCode = Number(err?.statusCode || err?.status || 0);
    const notFound =
      statusCode === 404 ||
      String(err?.message || "").toLowerCase().includes("user not found");
    if (!notFound) {
      throw err;
    }
  }

  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    return userId;
  }

  const fallbackUser = await findAuth0UserByEmail(normalizedEmail);
  const fallbackId = String((fallbackUser as any)?.user_id || "").trim();
  return fallbackId || userId;
}
