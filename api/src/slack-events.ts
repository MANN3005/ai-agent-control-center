import crypto from "crypto";
import type { Express, Request, Response } from "express";
import express from "express";
import {
  findAuth0UserBySlackUserId,
  getAuth0Connections,
  getGithubAccessToken,
} from "./services/auth0";
import {
  githubAssignIssue,
  githubCommentIssue,
  githubFindUserByEmail,
  githubGetUserById,
} from "./services/github";
import { slackGetChannelName, slackGetUserEmail } from "./services/slack";
import { getAnnouncementForThread } from "./slack-intake";

const PHRASES = [
  "i'll take it",
  "ill take it",
  "assign to me",
  "i can work on this",
  "i will work on this",
  "i'll handle this",
];

function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
) {
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = crypto
    .createHmac("sha256", signingSecret)
    .update(base, "utf8")
    .digest("hex");
  const expected = `v0=${digest}`;
  return crypto.timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(signature || "", "utf8"),
  );
}

function isClaimText(text: string) {
  const normalized = text.toLowerCase();
  return PHRASES.some((phrase) => normalized.includes(phrase));
}

function extractGithubHandle(text: string) {
  const match = text.match(/@([A-Za-z0-9-]+)/);
  return match ? match[1] : null;
}

function isGithubIdentity(identity: any, githubConnection: string) {
  const provider = String(identity?.provider || "").toLowerCase();
  const connection = String(identity?.connection || "").toLowerCase();
  const configuredConnection = String(githubConnection || "").toLowerCase();
  return (
    provider === "github" ||
    provider.includes("github") ||
    connection === configuredConnection ||
    connection === "github" ||
    connection.includes("github")
  );
}

export default function registerSlackEvents(app: Express) {
  app.post(
    "/slack/events",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const debugEnabled =
        String(process.env.SLACK_EVENTS_DEBUG || "").toLowerCase() === "true";
      const debug = (...args: any[]) => {
        if (debugEnabled) console.log("[SlackEvents]", ...args);
      };
      const signingSecret = process.env.SLACK_SIGNING_SECRET || "";
      const timestamp = String(req.headers["x-slack-request-timestamp"] || "");
      const signature = String(req.headers["x-slack-signature"] || "");
      const rawBody = req.body?.toString("utf8") || "";

      if (!signingSecret) {
        debug("Missing SLACK_SIGNING_SECRET");
        return res
          .status(500)
          .json({ status: "error", reason: "Missing SLACK_SIGNING_SECRET" });
      }

      if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
        debug("Signature verification failed");
        return res.status(401).json({ status: "denied" });
      }

      const payload = JSON.parse(rawBody || "{}") as any;

      if (payload?.type === "url_verification") {
        debug("URL verification challenge received");
        return res.json({ challenge: payload?.challenge });
      }

      if (payload?.type !== "event_callback") {
        debug("Ignoring payload type", payload?.type);
        return res.json({ ok: true });
      }

      const event = payload?.event || {};
      if (event?.type !== "message") {
        debug("Ignoring event type", event?.type);
        return res.json({ ok: true });
      }

      if (event?.subtype) {
        debug("Ignoring message subtype", event?.subtype);
        return res.json({ ok: true });
      }

      const text = String(event?.text || "").trim();
      if (!text || !isClaimText(text)) {
        debug("Ignoring message without claim text", { text });
        return res.json({ ok: true });
      }

      const channelId = String(event?.channel || "");
      const threadTs = String(event?.thread_ts || event?.ts || "");
      if (!channelId || !threadTs) {
        debug("Missing channel or thread timestamp", { channelId, threadTs });
        return res.json({ ok: true });
      }

      const slackBotToken = process.env.SLACK_BOT_TOKEN || "";
      if (!slackBotToken) {
        debug("Missing SLACK_BOT_TOKEN");
        return res
          .status(500)
          .json({ status: "error", reason: "Missing SLACK_BOT_TOKEN" });
      }

      const channelName = await slackGetChannelName(slackBotToken, channelId);
      debug("Channel name", channelName);
      if (channelName !== "new-issues") {
        debug("Ignoring channel", channelName);
        return res.json({ ok: true });
      }

      const announcement = getAnnouncementForThread(channelId, threadTs);
      if (!announcement) {
        debug("No announcement mapping for thread", { channelId, threadTs });
        return res.json({ ok: true });
      }

      const slackUserId = String(event?.user || "");
      if (!slackUserId) {
        debug("Missing slack user id");
        return res.json({ ok: true });
      }

      const accessToken = await getGithubAccessToken(announcement.userId);
      let githubLogin: string | null = extractGithubHandle(text);
      if (!githubLogin) {
        try {
          const { github: githubConnection } = getAuth0Connections();
          const auth0User: any = await findAuth0UserBySlackUserId(slackUserId);
          const identities = Array.isArray(auth0User?.identities)
            ? auth0User.identities
            : [];
          const githubIdentity = identities.find((identity: any) =>
            isGithubIdentity(identity, githubConnection),
          );
          const profileLogin =
            githubIdentity?.profileData?.login ||
            githubIdentity?.profileData?.nickname;
          if (profileLogin) {
            githubLogin = profileLogin;
          } else if (githubIdentity?.user_id) {
            const numericId = String(githubIdentity.user_id).match(/^\d+$/)
              ? String(githubIdentity.user_id)
              : null;
            if (numericId) {
              const resolved = await githubGetUserById(accessToken, numericId);
              githubLogin = resolved?.login || null;
            }
          }
          debug("Auth0 linked github login", githubLogin);
        } catch (err: any) {
          debug("Auth0 linkage lookup failed", err?.message || err);
        }
      }
      try {
        const email = await slackGetUserEmail(slackBotToken, slackUserId);
        debug("Slack user email", email);
        if (!githubLogin && email) {
          githubLogin = await githubFindUserByEmail(accessToken, email);
        }
      } catch {
        githubLogin = null;
      }
      debug("GitHub login match", githubLogin);

      const commentPrefix = githubLogin
        ? `Slack: volunteer claimed this. Assigning to @${githubLogin}.`
        : "Slack: volunteer claimed this, but no GitHub user matched.";
      await githubCommentIssue(
        accessToken,
        announcement.owner,
        announcement.repo,
        announcement.issueNumber,
        commentPrefix,
      );
      debug("Commented on issue", announcement.issueNumber);

      if (githubLogin) {
        await githubAssignIssue(
          accessToken,
          announcement.owner,
          announcement.repo,
          announcement.issueNumber,
          githubLogin,
        );
        debug("Assigned issue", {
          issue: announcement.issueNumber,
          githubLogin,
        });
      }

      debug("Slack event handled");
      return res.json({ ok: true });
    },
  );
}
