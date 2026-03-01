import { ManagementClient } from "auth0";
import {
  AUTH0_GITHUB_CONNECTION,
  AUTH0_GOOGLE_CONNECTION,
  AUTH0_SLACK_CONNECTION,
  requireEnv,
} from "../config";

let auth0ManagementClient: ManagementClient | null = null;

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

export function getAuth0Connections() {
  return {
    github: AUTH0_GITHUB_CONNECTION,
    google: AUTH0_GOOGLE_CONNECTION,
    slack: AUTH0_SLACK_CONNECTION,
  };
}
