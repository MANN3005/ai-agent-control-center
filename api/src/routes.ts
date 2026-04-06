import { z } from "zod";
import { Express } from "express";
import { prisma } from "./db";
import type { AgentRun, AgentTask } from "./types";
import { fanOutToolCall } from "./agent/fanout";
import {
  AGENT_RUNS,
  LLM_AUDIT_LOGS,
  LAST_CONTEXT,
  applySlackAutoFill,
  createRunId,
  enqueueAgentRun,
  extractContextFromText,
  formatRunForClient,
  generateAgentPlan,
  getGithubUsernameFromVault,
  getMissingInputQuestion,
  getOrCreateStepRecord,
  getSmallTalkReply,
  getToolAwareValidationPrompt,
  normalizeAgentSteps,
  parsePendingFieldAnswer,
  recordPolicyVerdictEntry,
  trace,
  executeToolWithPolicy,
} from "./agent/engine";
import { extractFieldsFromText } from "./agent/contextExtractor";
import { normalizeFields, resolveRepoFields } from "./agent/fieldRegistry";
import { rectify } from "./agent/rectify";
import { validateAllSteps } from "./agent/validator";
import {
  getAuth0ManagementClient,
  getAuth0Connections,
  hasGithubIdentity,
  hasSlackIdentity,
  revokeAllAuth0VaultTokens,
} from "./services/auth0";
import { getGithubAccessToken } from "./services/auth0";
import { githubListRepos } from "./services/github";
import { getToolIndex, listAllTools } from "./tools";

const LinkAccountBody = z.object({
  primaryUserId: z.string().min(1),
  secondaryUserId: z.string().min(1),
  provider: z.enum(["github", "slack", "google", "google-oauth2"]).optional(),
});

const UnlinkAccountBody = z.object({
  provider: z.string().min(1),
  providerUserId: z
    .union([z.string(), z.number()])
    .transform((value) => String(value)),
});

const PutPoliciesBody = z.object({
  policies: z.array(
    z.object({
      toolName: z.string().min(1),
      riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
      mode: z.enum(["AUTO", "CONFIRM", "STEP_UP"]),
    }),
  ),
});

const PutAllowedBody = z.object({
  provider: z.enum(["github"]),
  resourceType: z.string().min(1),
  resources: z.array(z.string().min(1)),
});

const StepUpStartBody = z
  .object({
    requestedAtMs: z.number().finite().positive().optional(),
  })
  .optional();

const LockdownBody = z
  .object({
    reason: z.string().min(1).max(200).optional(),
  })
  .optional();

const ArmAgentBody = z
  .object({
    requestedAtMs: z.number().finite().positive().optional(),
  })
  .optional();

const DISARMED_USERS = new Map<
  string,
  { disarmedAt: string; reason: string; revoke: { ok: boolean; steps: any[] } }
>();

function identityMatchesProvider(
  identity: any,
  provider: "github" | "slack" | "google" | "google-oauth2" | undefined,
  connections: { github: string; google: string; slack: string },
) {
  if (!provider) return true;
  const idProvider = String(identity?.provider || "").toLowerCase();
  const idConnection = String(identity?.connection || "").toLowerCase();
  if (provider === "github") {
    return (
      idProvider === "github" ||
      idConnection === String(connections.github || "").toLowerCase() ||
      idConnection === "github"
    );
  }
  if (provider === "slack") {
    return (
      idProvider === "slack" ||
      (idProvider === "oauth2" && idConnection.includes("slack")) ||
      idConnection === String(connections.slack || "").toLowerCase() ||
      idConnection.includes("slack")
    );
  }
  return (
    idProvider === "google-oauth2" ||
    idProvider === "google" ||
    idConnection === String(connections.google || "").toLowerCase() ||
    idConnection === "google-oauth2" ||
    idConnection === "google"
  );
}

function hasMfaEvidence(payload: any) {
  const amrRaw = payload?.amr;
  const acrRaw = payload?.acr;

  const amr = Array.isArray(amrRaw)
    ? amrRaw.map((v) => String(v).toLowerCase())
    : typeof amrRaw === "string"
      ? [amrRaw.toLowerCase()]
      : [];
  const acr = typeof acrRaw === "string" ? acrRaw.toLowerCase() : "";

  if (amr.includes("mfa")) return true;
  if (
    amr.some((value) =>
      ["otp", "totp", "webauthn", "sms", "push"].includes(value),
    )
  ) {
    return true;
  }
  if (acr.includes("multi-factor") || acr.includes("mfa")) return true;

  return false;
}

function hasFreshReauth(payload: any, requestedAtMs?: number) {
  if (typeof requestedAtMs !== "number" || !Number.isFinite(requestedAtMs)) {
    return false;
  }
  const iatRaw = payload?.iat;
  const iatSeconds = typeof iatRaw === "number" ? iatRaw : Number(iatRaw);
  if (!Number.isFinite(iatSeconds) || iatSeconds <= 0) {
    return false;
  }
  const tokenIssuedAtMs = iatSeconds * 1000;
  const allowedClockSkewMs = 15_000;
  return tokenIssuedAtMs + allowedClockSkewMs >= requestedAtMs;
}

function toDateOrNull(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function estimateTokenExpiry(identity: any, now: Date): Date | null {
  const explicitExpiry =
    toDateOrNull(identity?.expires_at) || toDateOrNull(identity?.expiresAt);
  if (explicitExpiry) return explicitExpiry;

  const expiresInRaw = identity?.expires_in ?? identity?.expiresIn;
  const expiresInSeconds = Number(expiresInRaw);
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    return null;
  }

  const issuedAt =
    toDateOrNull(identity?.obtained_at) ||
    toDateOrNull(identity?.created_at) ||
    toDateOrNull(identity?.updated_at);
  const base = issuedAt || now;
  return new Date(base.getTime() + expiresInSeconds * 1000);
}

function detectIdentityDomain(
  identity: any,
  connections: { github: string; google: string; slack: string },
): "github" | "slack" | "google" | "other" {
  const provider = String(identity?.provider || "").toLowerCase();
  const connection = String(identity?.connection || "").toLowerCase();

  const githubConn = String(connections.github || "").toLowerCase();
  const slackConn = String(connections.slack || "").toLowerCase();
  const googleConn = String(connections.google || "").toLowerCase();

  if (
    provider === "github" ||
    connection === githubConn ||
    connection === "github"
  ) {
    return "github";
  }
  if (
    provider === "slack" ||
    provider === "sign-in-with-slack" ||
    (provider === "oauth2" && connection.includes("slack")) ||
    connection === slackConn ||
    connection.includes("slack")
  ) {
    return "slack";
  }
  if (
    provider === "google-oauth2" ||
    provider === "google" ||
    connection === googleConn ||
    connection === "google-oauth2" ||
    connection === "google"
  ) {
    return "google";
  }
  return "other";
}

function requestsOrgWideMultiRepo(task: string) {
  const normalized = String(task || "").toLowerCase();
  return (
    normalized.includes("across our entire github org") ||
    normalized.includes("across all repos") ||
    normalized.includes("across the org") ||
    normalized.includes("all repos")
  );
}

function buildMultiRepoPlanTemplates(
  plan: Array<{ tool: string; input: Record<string, any> }>,
  toolIndex: Map<string, { needsRepo: boolean }>,
) {
  const deduped: Array<{ tool: string; input: Record<string, any> }> = [];
  const seen = new Set<string>();

  for (const step of plan) {
    const toolDef = toolIndex.get(step.tool);
    const baseInput = toolDef?.needsRepo
      ? (() => {
          const copy = { ...step.input };
          delete (copy as any).repo;
          delete (copy as any).repository;
          delete (copy as any).owner;
          return copy;
        })()
      : step.input;

    const key = `${step.tool}:${JSON.stringify(baseInput)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ tool: step.tool, input: baseInput });
  }

  return deduped;
}

export function registerRoutes(app: Express) {
  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/me", (req, res) => {
    const userId = (req as any).userId as string;
    Promise.all([
      hasGithubIdentity(userId).catch(() => false),
      hasSlackIdentity(userId).catch(() => false),
    ])
      .then(([hasGithub, hasSlack]) =>
        res.json({ userId, hasGithub, hasSlack }),
      )
      .catch(() => res.json({ userId, hasGithub: false, hasSlack: false }));
  });

  app.get("/access-state", async (req, res) => {
    const userId = (req as any).userId as string;
    const now = new Date();

    try {
      const [
        hasGithub,
        hasSlack,
        toolPolicies,
        allowedRepos,
        stepUpSession,
        tools,
        recentAuditLogs,
      ] = await Promise.all([
        hasGithubIdentity(userId).catch(() => false),
        hasSlackIdentity(userId).catch(() => false),
        prisma.toolPolicy.findMany({ where: { userId } }),
        prisma.allowedResource.findMany({
          where: {
            userId,
            provider: "github",
            resourceType: "repo",
          },
          orderBy: { createdAt: "desc" },
        }),
        prisma.stepUpSession.findFirst({
          where: {
            userId,
            expiresAt: { gt: now },
          },
          orderBy: { expiresAt: "desc" },
        }),
        listAllTools(),
        prisma.auditLog.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: 14,
        }),
      ]);

      const policiesByTool = new Map<string, any>();
      for (const tool of tools) {
        policiesByTool.set(tool.name, {
          riskLevel: tool.defaultRisk,
          mode: tool.defaultMode,
        });
      }
      for (const policy of toolPolicies) {
        policiesByTool.set(policy.toolName, {
          riskLevel: policy.riskLevel,
          mode: policy.mode,
        });
      }

      let identities: any[] = [];
      const connections = getAuth0Connections();
      try {
        const management = getAuth0ManagementClient();
        const userResponse: any = await management.users.get({ id: userId });
        const user = userResponse?.data ?? userResponse;
        identities = Array.isArray(user?.identities) ? user.identities : [];
      } catch {
        identities = [];
      }

      const allowedRepoIds = allowedRepos.map((item) => item.resourceId);
      let verifiedAllowedRepoIds = [...allowedRepoIds];
      let unverifiedAllowedRepoIds: string[] = [];
      let repoVerificationStatus: "verified" | "unavailable" | "not_checked" =
        "not_checked";

      if (hasGithub && allowedRepoIds.length > 0) {
        try {
          const githubToken = await getGithubAccessToken(userId);
          const repos = await githubListRepos(githubToken);
          const accessibleRepoSet = new Set(
            repos
              .map((repo: any) =>
                String(repo.fullName || "")
                  .trim()
                  .toLowerCase(),
              )
              .filter(Boolean),
          );

          verifiedAllowedRepoIds = allowedRepoIds.filter((repoId) =>
            accessibleRepoSet.has(String(repoId).trim().toLowerCase()),
          );
          unverifiedAllowedRepoIds = allowedRepoIds.filter(
            (repoId) =>
              !accessibleRepoSet.has(String(repoId).trim().toLowerCase()),
          );
          repoVerificationStatus = "verified";
        } catch {
          repoVerificationStatus = "unavailable";
        }
      }

      const tokenHealth = identities.map((identity) => {
        const domain = detectIdentityDomain(identity, connections);
        const expiresAt = estimateTokenExpiry(identity, now);
        const ttlMs = expiresAt
          ? Math.max(0, expiresAt.getTime() - now.getTime())
          : null;

        return {
          provider: identity?.provider ?? null,
          connection: identity?.connection ?? null,
          domain,
          hasAccessToken: Boolean(identity?.access_token),
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          ttlMs,
          vaultStatus: Boolean(identity?.access_token)
            ? "protected_by_auth0_vault"
            : "not_available",
          isolationStatus: Boolean(identity?.access_token)
            ? "token_isolated"
            : "not_linked",
        };
      });
      const stepUp = stepUpSession
        ? {
            active: true,
            id: stepUpSession.id,
            expiresAt: stepUpSession.expiresAt,
            remainingMs: Math.max(
              0,
              stepUpSession.expiresAt.getTime() - now.getTime(),
            ),
          }
        : {
            active: false,
            id: null,
            expiresAt: null,
            remainingMs: 0,
          };

      const effectiveTools = tools.map((tool) => {
        const policy = policiesByTool.get(tool.name) || {
          riskLevel: tool.defaultRisk,
          mode: tool.defaultMode,
        };

        const providerConnected =
          tool.domain === "github"
            ? hasGithub
            : tool.domain === "slack"
              ? hasSlack
              : true;
        const requiresAllowedResource = Boolean(
          tool.needsRepo && tool.domain === "github",
        );
        const hasRequiredAllowList =
          !requiresAllowedResource || verifiedAllowedRepoIds.length > 0;
        const requiresStepUp = policy.mode === "STEP_UP";
        const recentDecisions = recentAuditLogs
          .filter((log) => log.toolName === tool.name)
          .slice(0, 8)
          .map((log) => log.decision);
        const lastAllowed = recentAuditLogs.find(
          (log) => log.toolName === tool.name && log.decision === "ALLOWED",
        );

        const policyEvaluations = [
          {
            rule: `${tool.name}-provider-link`,
            result: providerConnected ? "PASS" : "FAIL",
            detail: providerConnected
              ? `${tool.domain || "provider"} identity linked`
              : `Missing ${tool.domain || "provider"} identity link`,
          },
          {
            rule: `${tool.name}-allow-list`,
            result:
              !requiresAllowedResource || hasRequiredAllowList
                ? "PASS"
                : "FAIL",
            detail:
              !requiresAllowedResource || hasRequiredAllowList
                ? "Resource policy check passed"
                : "No allow-listed GitHub repositories",
          },
          {
            rule: `${tool.name}-step-up`,
            result: !requiresStepUp || stepUp.active ? "PASS" : "FAIL",
            detail:
              !requiresStepUp || stepUp.active
                ? "Step-up gate satisfied"
                : "High-risk tool requires active MFA Step-Up",
          },
        ];

        const baseRiskScore =
          policy.riskLevel === "LOW"
            ? 35
            : policy.riskLevel === "MEDIUM"
              ? 62
              : 82;
        const riskReasons: string[] = [
          `Base risk from policy level: ${policy.riskLevel}`,
        ];
        let riskScore = baseRiskScore;

        const recentInputWithBranch = recentAuditLogs
          .filter((log) => log.toolName === tool.name)
          .map((log) => {
            try {
              return JSON.parse(log.inputJson || "{}");
            } catch {
              return {};
            }
          })
          .find((payload) => payload && typeof payload === "object");
        const branchLike = String(
          (recentInputWithBranch as any)?.branch ||
            (recentInputWithBranch as any)?.base ||
            (recentInputWithBranch as any)?.ref ||
            "",
        ).toLowerCase();
        const productionBranchContext =
          /^(main|master|release|prod|production)$/.test(branchLike);

        if (tool.name === "manage_issues") {
          riskScore += 12;
          riskReasons.push("Tool can mutate issue state (write path)");
        }

        const hasProductionLikeResource = allowedRepoIds.some((resourceId) =>
          /prod|production|main|release/i.test(resourceId),
        );
        if (
          hasProductionLikeResource &&
          (tool.name === "manage_issues" || tool.name === "github_explorer")
        ) {
          riskScore += 18;
          riskReasons.push("Resource scope includes production-like target");
        }

        if (productionBranchContext && tool.name === "manage_issues") {
          riskScore = Math.max(riskScore, 95);
          riskReasons.push(
            "Production branch context detected (risk spike to 95)",
          );
        }

        if (requiresStepUp && !stepUp.active) {
          riskScore += 14;
          riskReasons.push("Step-up required but currently inactive");
        }

        if (!providerConnected) {
          riskScore += 10;
          riskReasons.push("Provider identity disconnected");
        }

        riskScore = Math.max(0, Math.min(100, riskScore));
        const riskBand =
          riskScore >= 80
            ? "CRITICAL"
            : riskScore >= 60
              ? "HIGH"
              : riskScore >= 40
                ? "MEDIUM"
                : "LOW";

        return {
          name: tool.name,
          domain: tool.domain || "unknown",
          description: tool.description || "",
          riskLevel: policy.riskLevel,
          mode: policy.mode,
          providerConnected,
          requiresAllowedResource,
          hasRequiredAllowList,
          requiresStepUp,
          canExecuteNow:
            providerConnected &&
            hasRequiredAllowList &&
            (!requiresStepUp || stepUp.active),
          recentDecisions,
          lastAuthorizedAt: lastAllowed?.createdAt?.toISOString() || null,
          riskScore,
          riskBand,
          riskReasons,
          policyEvaluations,
          blockedReasons: [
            !providerConnected
              ? `Missing ${tool.domain || "provider"} identity link`
              : null,
            requiresAllowedResource && !hasRequiredAllowList
              ? "No allow-listed GitHub repositories"
              : null,
            requiresStepUp && !stepUp.active
              ? "Requires active step-up session"
              : null,
          ].filter(Boolean),
        };
      });

      const policyDecisions = recentAuditLogs.map((log) => ({
        id: log.id,
        at: log.createdAt.toISOString(),
        toolName: log.toolName,
        decision: log.decision,
        reason: log.reason || log.reasoning || "No reason recorded",
        requestId: log.requestId,
      }));

      const githubReadEnabled = effectiveTools.some(
        (tool) => tool.name === "github_explorer" && tool.canExecuteNow,
      );
      const githubWriteEnabled = effectiveTools.some(
        (tool) => tool.name === "manage_issues" && tool.canExecuteNow,
      );
      const resourceBreakdown = verifiedAllowedRepoIds.map((repoId) => {
        const permissions = {
          read: githubReadEnabled,
          write: githubWriteEnabled,
          delete: false,
        };
        const level =
          permissions.read && permissions.write
            ? "full_access"
            : permissions.read
              ? "metadata_only"
              : "blocked";
        const label =
          level === "full_access"
            ? "Full Access (Read/Write)"
            : level === "metadata_only"
              ? "Metadata Only (No Write Access)"
              : "Blocked";
        return {
          resourceId: repoId,
          level,
          label,
          permissions,
        };
      });

      const lockdownState = DISARMED_USERS.get(userId);

      return res.json({
        userId,
        now: now.toISOString(),
        identities: {
          hasGithub,
          hasSlack,
          linked: identities.map((identity) => ({
            provider: identity?.provider ?? null,
            connection: identity?.connection ?? null,
            providerUserId: identity?.user_id ?? null,
            hasAccessToken: Boolean(identity?.access_token),
          })),
        },
        resources: {
          allowedRepos: allowedRepoIds,
          allowedRepoCount: allowedRepoIds.length,
          verifiedAllowedRepos: verifiedAllowedRepoIds,
          verifiedAllowedRepoCount: verifiedAllowedRepoIds.length,
          unverifiedAllowedRepos: unverifiedAllowedRepoIds,
          repoVerificationStatus,
          breakdown: resourceBreakdown,
        },
        tokenHealth,
        stepUp,
        tools: effectiveTools,
        policyDecisions,
        agentHealth: {
          status: lockdownState ? "DISARMED" : "STANDBY",
          disarmedAt: lockdownState?.disarmedAt || null,
          reason: lockdownState?.reason || null,
        },
      });
    } catch (err: any) {
      return res.status(500).json({
        status: "error",
        reason: err?.message || "Failed to resolve access state",
      });
    }
  });

  app.get("/debug/identities", async (req, res) => {
    const userId = (req as any).userId as string;
    try {
      const client = getAuth0ManagementClient();
      const userResponse: any = await client.users.get({ id: userId });
      const user = userResponse?.data ?? userResponse;
      const identities: any[] = user?.identities ?? [];

      res.json({
        userId,
        identities: identities.map((identity) => ({
          provider: identity?.provider ?? null,
          connection: identity?.connection ?? null,
          userId: identity?.user_id ?? null,
          hasAccessToken: Boolean(identity?.access_token),
        })),
      });
    } catch (err: any) {
      res.status(500).json({
        status: "error",
        reason: err?.message || "Failed to load identities",
      });
    }
  });

  app.post("/auth/link", async (req, res) => {
    const userId = (req as any).userId as string;
    const parsed = LinkAccountBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);

    const { primaryUserId, secondaryUserId, provider } = parsed.data;
    const canLinkFromSecondary = Boolean(
      secondaryUserId && userId === secondaryUserId,
    );
    const canLinkFromPrimary = userId === primaryUserId;
    if (!canLinkFromPrimary && !canLinkFromSecondary) {
      return res.status(403).json({
        status: "denied",
        reason: "Must link from primary or secondary account",
      });
    }

    try {
      const client = getAuth0ManagementClient();
      const primary = await client.users.get({ id: primaryUserId });
      const secondary = await client.users.get({ id: secondaryUserId });

      const primaryUser: any = (primary as any)?.data ?? primary;
      const secondaryUser: any = (secondary as any)?.data ?? secondary;

      const primaryEmail = String(primaryUser?.email || "").toLowerCase();
      const secondaryEmail = String(secondaryUser?.email || "").toLowerCase();
      const allowWithoutEmail =
        String(process.env.ALLOW_LINK_WITHOUT_EMAIL || "").toLowerCase() ===
        "true";

      if (primaryEmail && secondaryEmail) {
        if (primaryEmail !== secondaryEmail) {
          return res
            .status(400)
            .json({ status: "denied", reason: "Emails do not match" });
        }
      } else if (!allowWithoutEmail) {
        return res.status(400).json({
          status: "denied",
          reason:
            "Email missing; enable email scope or set ALLOW_LINK_WITHOUT_EMAIL=true",
        });
      }

      const connections = getAuth0Connections();
      const secondaryIdentity = Array.isArray(secondaryUser?.identities)
        ? secondaryUser.identities.find((id: any) => {
            if (!provider) return true;
            if (provider === "github") {
              return (
                id?.provider === "github" ||
                id?.connection === connections.github
              );
            }
            if (provider === "google" || provider === "google-oauth2") {
              return (
                id?.provider === "google-oauth2" ||
                id?.connection === connections.google
              );
            }
            return (
              id?.provider === "slack" || id?.connection === connections.slack
            );
          })
        : null;

      if (!secondaryIdentity) {
        return res.status(400).json({
          status: "denied",
          reason: "Secondary identity not found for provider",
        });
      }

      const existing = Array.isArray(primaryUser?.identities)
        ? primaryUser.identities.some(
            (id: any) =>
              id?.provider === secondaryIdentity.provider &&
              id?.user_id === secondaryIdentity.user_id,
          )
        : false;

      if (existing) {
        return res.json({ status: "linked" });
      }

      await client.users.link(
        { id: primaryUserId },
        {
          provider: secondaryIdentity.provider as any,
          user_id: secondaryIdentity.user_id,
        },
      );

      return res.json({ status: "linked" });
    } catch (err: any) {
      return res
        .status(500)
        .json({ status: "error", reason: err?.message || "Link failed" });
    }
  });

  app.post("/auth/unlink", async (req, res) => {
    const userId = (req as any).userId as string;
    const parsed = UnlinkAccountBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);

    const { provider, providerUserId } = parsed.data;

    try {
      const client = getAuth0ManagementClient();
      await client.users.unlink({
        id: userId,
        provider,
        user_id: providerUserId,
      } as any);

      return res.json({ status: "unlinked" });
    } catch (err: any) {
      return res
        .status(500)
        .json({ status: "error", reason: err?.message || "Unlink failed" });
    }
  });

  app.get("/policies", async (req, res) => {
    const userId = (req as any).userId as string;
    const policies = await prisma.toolPolicy.findMany({ where: { userId } });
    const tools = await listAllTools();

    const merged = new Map<string, any>();
    for (const tool of tools) {
      merged.set(tool.name, {
        userId,
        toolName: tool.name,
        riskLevel: tool.defaultRisk,
        mode: tool.defaultMode,
      });
    }

    for (const policy of policies) {
      merged.set(policy.toolName, policy);
    }

    return res.json(Array.from(merged.values()));
  });

  app.get("/tools", async (req, res) => {
    const userId = (req as any).userId as string;
    try {
      const tools = await listAllTools(userId);
      res.json(
        tools.map((tool) => ({
          toolName: tool.name,
          needsRepo: tool.needsRepo,
          defaultRisk: tool.defaultRisk,
          defaultMode: tool.defaultMode,
          description: tool.description || null,
        })),
      );
    } catch (err: any) {
      res.status(500).json({
        status: "error",
        reason: err?.message || "Failed to load tools",
      });
    }
  });

  app.put("/policies", async (req, res) => {
    const userId = (req as any).userId as string;
    const parsed = PutPoliciesBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);

    const ops = parsed.data.policies.map((p) =>
      prisma.toolPolicy.upsert({
        where: { userId_toolName: { userId, toolName: p.toolName } },
        update: { riskLevel: p.riskLevel as any, mode: p.mode as any },
        create: {
          userId,
          toolName: p.toolName,
          riskLevel: p.riskLevel as any,
          mode: p.mode as any,
        },
      }),
    );

    await prisma.$transaction(ops);

    const updated = await prisma.toolPolicy.findMany({ where: { userId } });
    res.json(updated);
  });

  app.get("/allowed-resources", async (req, res) => {
    const userId = (req as any).userId as string;
    const provider = String(req.query.provider || "github");
    const resourceType = String(req.query.resourceType || "repo");

    const items = await prisma.allowedResource.findMany({
      where: { userId, provider: provider as any, resourceType },
      orderBy: { createdAt: "desc" },
    });

    res.json(items.map((i) => i.resourceId));
  });

  app.put("/allowed-resources", async (req, res) => {
    const userId = (req as any).userId as string;
    const parsed = PutAllowedBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);

    const { provider, resourceType, resources } = parsed.data;

    await prisma.allowedResource.deleteMany({
      where: { userId, provider: provider as any, resourceType },
    });

    if (resources.length) {
      await prisma.allowedResource.createMany({
        data: resources.map((r) => ({
          userId,
          provider: provider as any,
          resourceType,
          resourceId: r,
        })),
      });
    }

    res.json({ ok: true, count: resources.length });
  });

  app.get("/audit", async (req, res) => {
    const userId = (req as any).userId as string;
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const logs = await prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    res.json(
      logs.map((l) => ({
        ...l,
        inputJson: JSON.parse(l.inputJson),
        resultJson: l.resultJson ? JSON.parse(l.resultJson) : null,
      })),
    );
  });

  app.post("/step-up/start", async (req, res) => {
    const userId = (req as any).userId as string;
    const ttlMs = 2 * 60 * 1000;
    const now = Date.now();

    const session = await prisma.stepUpSession.create({
      data: {
        userId,
        expiresAt: new Date(now + ttlMs),
      },
    });

    res.json({ stepUpId: session.id, expiresAt: session.expiresAt });
  });

  app.post("/agent/lockdown", async (req, res) => {
    const userId = (req as any).userId as string;
    const parsed = LockdownBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json(parsed.error);

    const reason = parsed.data?.reason || "Manual session lockdown";
    const revoke = await revokeAllAuth0VaultTokens(userId).catch(
      (err: any) => ({
        ok: false,
        steps: [
          {
            step: "revoke_failed",
            ok: false,
            detail: err?.message || "unknown_error",
          },
        ],
      }),
    );

    DISARMED_USERS.set(userId, {
      disarmedAt: new Date().toISOString(),
      reason,
      revoke,
    });

    return res.json({
      status: "disarmed",
      disarmedAt: DISARMED_USERS.get(userId)?.disarmedAt,
      reason,
      revoke,
    });
  });

  app.post("/agent/arm", async (req, res) => {
    const userId = (req as any).userId as string;
    const payload = (req as any).auth?.payload;
    const parsed = ArmAgentBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json(parsed.error);

    const requestedAtMs = parsed.data?.requestedAtMs;
    const hasRecentReauth = hasFreshReauth(payload, requestedAtMs);
    if (!hasRecentReauth) {
      return res.status(403).json({
        status: "denied",
        reason:
          "Re-arm denied: token was not freshly reissued after re-login challenge.",
      });
    }

    DISARMED_USERS.delete(userId);
    return res.json({ status: "armed" });
  });

  app.post("/tools/execute", async (req, res) => {
    const userId = (req as any).userId as string;
    const body = (req.body ?? {}) as any;

    const requestId =
      typeof body.requestId === "string" ? body.requestId.trim() : "";
    const tool = typeof body.tool === "string" ? body.tool.trim() : "";
    const input =
      body.input && typeof body.input === "object" ? body.input : {};

    const approval = {
      confirmed: Boolean(body.approval?.confirmed),
      stepUpId:
        typeof body.approval?.stepUpId === "string"
          ? body.approval.stepUpId
          : null,
    };

    if (!requestId || !tool) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId: "unknown",
          toolName: tool || "unknown",
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: "Missing required requestId or tool",
          executed: false,
        },
      });
      return res
        .status(400)
        .json({ status: "denied", reason: "Missing requestId or tool" });
    }

    const lockdown = DISARMED_USERS.get(userId);
    if (lockdown) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "DENIED",
          reason: "Agent is DISARMED by session lockdown",
          reasoning: lockdown.reason,
          executed: false,
        },
      });
      return res.status(423).json({
        status: "denied",
        reason: "Agent is DISARMED. Re-arm session before running tools.",
      });
    }

    try {
      const response = await executeToolWithPolicy(
        userId,
        requestId,
        tool,
        input,
        approval,
      );
      return res.status(response.statusCode).json(response.body);
    } catch (err: any) {
      await prisma.auditLog.create({
        data: {
          userId,
          requestId,
          toolName: tool,
          inputJson: JSON.stringify(input),
          decision: "ERROR",
          reason: err?.message || "Unexpected tool execution failure",
          reasoning: "Unhandled exception in /tools/execute route",
          executed: false,
        },
      });

      return res.status(500).json({
        status: "error",
        reason: err?.message || "Unexpected tool execution failure",
      });
    }
  });

  app.post("/agent/run", async (req, res) => {
    const userId = (req as any).userId as string;
    const body = (req.body ?? {}) as Partial<AgentTask>;
    const requestId =
      typeof body.requestId === "string" ? body.requestId.trim() : "";
    const task = typeof body.task === "string" ? body.task.trim() : "";
    const incomingContext =
      body.context && typeof body.context === "object" ? body.context : {};
    let repos = Array.isArray(body.repos)
      ? Array.from(
          new Set(
            body.repos
              .map((repo) => String(repo || "").trim())
              .filter((repo) => repo.length > 0),
          ),
        )
      : [];

    if (repos.length === 0 && requestsOrgWideMultiRepo(task)) {
      const allowedRepos = await prisma.allowedResource.findMany({
        where: {
          userId,
          provider: "github",
          resourceType: "repo",
        },
        orderBy: { createdAt: "desc" },
      });
      repos = Array.from(
        new Set(
          allowedRepos
            .map((item) => String(item.resourceId || "").trim())
            .filter(Boolean),
        ),
      );
    }

    const previousContext = LAST_CONTEXT.get(userId) || {};
    const extracted = extractContextFromText(task);
    const textExtractedContext = resolveRepoFields(
      normalizeFields(extractFieldsFromText(task) as Record<string, any>),
    );
    const context = {
      ...previousContext,
      ...incomingContext,
      ...extracted,
      textExtractedContext: {
        ...(previousContext.textExtractedContext || {}),
        ...textExtractedContext,
      },
      ...(repos.length > 0 ? { repos, repo: extracted.repo || repos[0] } : {}),
    };

    if (!requestId || !task) {
      return res.status(400).json({
        status: "denied",
        reason: "Missing requestId or task",
      });
    }

    if (DISARMED_USERS.has(userId)) {
      return res.status(423).json({
        status: "denied",
        reason: "Agent is DISARMED. Re-arm session before starting new runs.",
      });
    }

    const smallTalk = getSmallTalkReply(task);
    if (smallTalk) {
      const run: AgentRun = {
        id: createRunId(),
        userId,
        task,
        context,
        status: "COMPLETED" as const,
        plan: [],
        steps: [],
        currentStep: 0,
        pendingStepIndex: null,
        pendingFieldCapture: null,
        pendingRectify: null,
        messages: [
          { role: "user", text: task },
          { role: "agent", text: smallTalk },
        ],
        trace: [],
      };

      AGENT_RUNS.set(run.id, run);
      LAST_CONTEXT.set(userId, run.context);
      trace(run, "status", "Small talk reply");
      return res.json({ status: "started", run: formatRunForClient(run) });
    }

    const run: AgentRun = {
      id: createRunId(),
      userId,
      task,
      context,
      status: "PLANNING" as const,
      plan: [],
      steps: [],
      currentStep: 0,
      pendingStepIndex: null,
      pendingFieldCapture: null,
      pendingRectify: null,
      messages: [{ role: "user", text: task }],
      trace: [],
    };

    AGENT_RUNS.set(run.id, run);
    LAST_CONTEXT.set(userId, run.context);
    trace(run, "thought", "Planning next steps");

    try {
      const tools = await listAllTools(userId);
      const toolIndex = getToolIndex(tools);
      const plan = await generateAgentPlan(task, context, tools, userId);

      if (!plan.steps.length) {
        run.status = "NEEDS_INPUT";
        run.plan = [];
        trace(run, "status", "Planner requested more input");
        run.messages.push({
          role: "agent",
          text:
            plan.question ||
            "I need one required input to proceed. Please provide more details.",
        });
        return res.json({ status: "started", run: formatRunForClient(run) });
      }

      run.plan = normalizeAgentSteps(plan.steps, context, toolIndex);
      const validation = validateAllSteps(run.plan, tools);
      if (!validation.valid) {
        run.status = "NEEDS_INPUT";
        run.pendingFieldCapture = {
          field: String(validation.missingField || ""),
          stepIndex: Number(validation.stepIndex || 0),
          frozenSteps: run.plan.map((step) => ({ ...step, input: { ...step.input } })),
        };
        trace(run, "status", "Waiting for user input");
        run.messages.push({
          role: "agent",
          text:
            validation.missingFieldQuestion ||
            `I need ${validation.missingField} to proceed.`,
        });
        return res.json({ status: "started", run: formatRunForClient(run) });
      }

      run.pendingFieldCapture = null;
      run.plan = normalizeAgentSteps(run.plan, context, toolIndex);

      if (repos.length > 0) {
        run.plan = buildMultiRepoPlanTemplates(run.plan, toolIndex as any);
        trace(
          run,
          "thought",
          `Multi-repo orchestration active across ${repos.length} repositories`,
        );
        run.status = "RUNNING";

        for (let i = 0; i < run.plan.length; i += 1) {
          const step = run.plan[i];
          const stepRecord = getOrCreateStepRecord(run, i, step);
          run.currentStep = i;

          try {
            const toolDef = toolIndex.get(step.tool);
            if (toolDef?.needsRepo) {
              const aggregated = await fanOutToolCall(
                userId,
                `${requestId}:step:${i}`,
                step.tool,
                step.input,
                repos,
                { confirmed: false, stepUpId: null },
              );

              stepRecord.status =
                aggregated.successCount > 0 ? "EXECUTED" : "ERROR";
              stepRecord.result = aggregated;
              if (aggregated.failureCount > 0) {
                stepRecord.reason = aggregated.summary;
              }

              run.messages.push({ role: "agent", text: aggregated.summary });
              trace(run, "action", `${step.tool}: ${aggregated.summary}`);
            } else {
              const response = await executeToolWithPolicy(
                userId,
                `${requestId}:step:${i}`,
                step.tool,
                step.input,
                { confirmed: false, stepUpId: null },
              );

              stepRecord.status =
                response.statusCode >= 400 ? "ERROR" : "EXECUTED";
              stepRecord.result = response.body;
              if (stepRecord.status === "ERROR") {
                stepRecord.reason = String(
                  response.body?.reason ||
                    response.body?.status ||
                    "Step failed",
                );
              }
            }
          } catch (err: any) {
            const reason = err?.message || "Step failed in multi-repo mode";
            stepRecord.status = "ERROR";
            stepRecord.reason = reason;
            trace(run, "status", reason);
          }
        }

        run.status = "COMPLETED";
        trace(run, "status", "Multi-repo run completed");
        return res.json({ status: "started", run: formatRunForClient(run) });
      }

      run.status = "RUNNING";
      trace(run, "thought", "Plan ready, executing");
      enqueueAgentRun(run.id);

      return res.json({ status: "started", run: formatRunForClient(run) });
    } catch (err: any) {
      run.status = "ERROR";
      run.lastError = err?.message || "Agent planning failed";
      trace(run, "status", run.lastError ?? "Unknown error");
      run.messages.push({ role: "agent", text: `Error: ${run.lastError}` });
      return res.status(500).json({
        status: "error",
        reason: run.lastError,
        run: formatRunForClient(run),
      });
    }
  });

  app.get("/llm-audit", async (req, res) => {
    const userId = (req as any).userId as string;
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const llmAuditModel = (prisma as any).llmAuditLog;

    if (llmAuditModel) {
      const rows = await llmAuditModel.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      return res.json(
        rows.map((row: any) => ({
          id: row.id,
          userId: row.userId,
          runId: row.runId,
          requestId: row.requestId,
          callType: row.callType,
          model: row.model,
          input: JSON.parse(row.inputJson || "{}"),
          output: JSON.parse(row.outputJson || "{}"),
          createdAt: row.createdAt,
        })),
      );
    }

    const logs = LLM_AUDIT_LOGS.get(userId) || [];
    return res.json(logs.slice(0, limit));
  });

  app.get("/agent/runs/:id", async (req, res) => {
    const userId = (req as any).userId as string;
    const runId = String(req.params.id || "");
    const run = AGENT_RUNS.get(runId);
    if (!run || run.userId !== userId) {
      return res.status(404).json({ status: "not_found" });
    }
    return res.json({ status: "ok", run: formatRunForClient(run) });
  });

  app.post("/agent/continue", async (req, res) => {
    const userId = (req as any).userId as string;
    const body = (req.body ?? {}) as any;
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (DISARMED_USERS.has(userId)) {
      return res.status(423).json({
        status: "denied",
        reason: "Agent is DISARMED. Re-arm session before continuing runs.",
      });
    }
    const approval = {
      confirmed: Boolean(body.approval?.confirmed),
      stepUpId:
        typeof body.approval?.stepUpId === "string"
          ? body.approval.stepUpId
          : null,
    };

    const run = AGENT_RUNS.get(runId);
    if (!run || run.userId !== userId) {
      return res.status(404).json({ status: "not_found" });
    }

    if (message) {
      run.messages.push({ role: "user", text: message });
      const extracted = extractContextFromText(message);
      const textExtracted = resolveRepoFields(
        normalizeFields(extractFieldsFromText(message) as Record<string, any>),
      );
      run.context.followUpText = message.trim();
      run.context.textExtractedContext = {
        ...(run.context.textExtractedContext || {}),
        ...textExtracted,
      };
      const lastAgent = run.messages
        .slice()
        .reverse()
        .find((m) => m.role === "agent");
      const agentAskedForGithubIdentity = Boolean(
        lastAgent?.text
          ?.toLowerCase()
          .match(/github\s+(username|account|organization)|parameter named 'query'|provide.*query/),
      );
      const bareUsername = message.trim().match(/^[A-Za-z0-9-]{2,39}$/);

      if (extracted.repo) run.context.repo = extracted.repo;
      if (extracted.repoCandidate)
        run.context.repoCandidate = extracted.repoCandidate;
      if (extracted.issueNumber)
        run.context.issueNumber = extracted.issueNumber;
      if (extracted.issueNumbers)
        run.context.issueNumbers = extracted.issueNumbers;
      if (extracted.state) run.context.state = extracted.state;
      if (extracted.title) run.context.title = extracted.title;
      if (extracted.assignee) run.context.assignee = extracted.assignee;
      if (extracted.assigneeEmail)
        run.context.assigneeEmail = extracted.assigneeEmail;
      if (extracted.channel) run.context.channel = extracted.channel;
      if (extracted.comment) run.context.comment = extracted.comment;
      if ((extracted as any).action) run.context.action = (extracted as any).action;
      if (extracted.githubUsername)
        run.context.githubUsername = extracted.githubUsername;
      if (extracted.githubOrg)
        run.context.githubOrg = extracted.githubOrg;
      if (extracted.owner) run.context.owner = extracted.owner;
      if ((extracted as any).query) run.context.query = (extracted as any).query;

      if (agentAskedForGithubIdentity && bareUsername) {
        const username = bareUsername[0];
        run.context.githubUsername = username;
        run.context.owner = username;
        run.context.query = `user:${username}`;
      }

      if (!run.context.title) {
        if (lastAgent?.text?.toLowerCase().includes("issue title")) {
          const cleaned = message.trim().replace(/^['"]|['"]$/g, "");
          if (cleaned) run.context.title = cleaned;
        }
      }
      LAST_CONTEXT.set(userId, run.context);
    }

    if (message) {
      const smallTalk = getSmallTalkReply(message);
      if (smallTalk) {
        run.messages.push({ role: "agent", text: smallTalk });
        trace(run, "status", "Small talk reply");
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }
    }

    if (run.status === "NEEDS_INPUT" && message && run.pendingFieldCapture) {
      const tools = await listAllTools(userId);
      const capture = run.pendingFieldCapture;
      const frozenSteps = capture.frozenSteps.map((step) => ({
        ...step,
        input: { ...step.input },
      }));

      const step = frozenSteps[capture.stepIndex];
      if (!step) {
        run.pendingFieldCapture = null;
      } else {
        step.input[capture.field] = parsePendingFieldAnswer(capture.field, message);
        step.input = resolveRepoFields(normalizeFields(step.input));

        const validation = validateAllSteps(frozenSteps, tools);
        if (!validation.valid) {
          run.pendingFieldCapture = {
            field: String(validation.missingField || ""),
            stepIndex: Number(validation.stepIndex || 0),
            frozenSteps,
          };
          run.status = "NEEDS_INPUT";
          run.plan = frozenSteps;
          run.messages.push({
            role: "agent",
            text:
              validation.missingFieldQuestion ||
              `I need ${validation.missingField} to proceed.`,
          });
          return res.json({ status: "ok", run: formatRunForClient(run) });
        }

        run.pendingFieldCapture = null;
        run.plan = frozenSteps;
        run.steps = [];
        run.currentStep = 0;
        run.pendingStepIndex = null;
        run.status = "RUNNING";
        enqueueAgentRun(run.id);
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }
    }

    if (run.status === "NEEDS_INPUT" && message && run.pendingRectify) {
      const capture = run.pendingRectify;
      const frozenToolCall = {
        tool: String(capture.frozenToolCall.tool || ""),
        input: { ...(capture.frozenToolCall.input || {}) },
      };

      let parsedAnswer: any = message.trim();
      if (
        capture.missingField === "issue_number" ||
        capture.missingField === "pull_number"
      ) {
        const numeric = parseInt(parsedAnswer.replace(/[^0-9]/g, ""), 10);
        if (!Number.isNaN(numeric)) parsedAnswer = numeric;
      }

      frozenToolCall.input[capture.missingField] = parsedAnswer;
      run.pendingRectify = null;

      const githubUsername = await getGithubUsernameFromVault(userId);
      const retried = rectify(frozenToolCall, message, githubUsername || undefined);

      if (retried.type === "NEEDS_INPUT") {
        run.pendingRectify = {
          frozenToolCall: retried.frozenToolCall || frozenToolCall,
          missingField: String(retried.missingField || ""),
        };
        run.status = "NEEDS_INPUT";
        run.messages.push({
          role: "agent",
          text:
            retried.question ||
            `I need ${retried.missingField || "additional input"} to proceed.`,
        });
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }

      if (retried.toolCall) {
        run.plan = [
          {
            tool: retried.toolCall.tool,
            input: retried.toolCall.input,
          },
        ];
      }

      run.pendingFieldCapture = null;
      run.steps = [];
      run.currentStep = 0;
      run.pendingStepIndex = null;
      run.status = "RUNNING";
      enqueueAgentRun(run.id);
      return res.json({ status: "ok", run: formatRunForClient(run) });
    }

    if (run.status === "NEEDS_INPUT" && message) {
      trace(run, "thought", "Updating context from user input");
      try {
        const tools = await listAllTools(userId);
        const toolIndex = getToolIndex(tools);
        const plan = await generateAgentPlan(
          run.task,
          run.context,
          tools,
          userId,
        );

        if (!plan.steps.length) {
          run.status = "NEEDS_INPUT";
          run.plan = [];
          run.messages.push({
            role: "agent",
            text:
              plan.question ||
              "I still need one required input to continue. Please provide more details.",
          });
          return res.json({ status: "ok", run: formatRunForClient(run) });
        }

        run.plan = normalizeAgentSteps(plan.steps, run.context, toolIndex);
        const validation = validateAllSteps(run.plan, tools);
        if (!validation.valid) {
          run.status = "NEEDS_INPUT";
          run.pendingFieldCapture = {
            field: String(validation.missingField || ""),
            stepIndex: Number(validation.stepIndex || 0),
            frozenSteps: run.plan.map((step) => ({ ...step, input: { ...step.input } })),
          };
          run.messages.push({
            role: "agent",
            text:
              validation.missingFieldQuestion ||
              `I need ${validation.missingField} to proceed.`,
          });
          return res.json({ status: "ok", run: formatRunForClient(run) });
        }

        run.pendingFieldCapture = null;
        run.steps = [];
        run.currentStep = 0;
        run.pendingStepIndex = null;
        run.status = "RUNNING";
        enqueueAgentRun(run.id);
        return res.json({ status: "ok", run: formatRunForClient(run) });
      } catch (err: any) {
        run.status = "ERROR";
        run.lastError = err?.message || "Agent planning failed";
        run.messages.push({ role: "agent", text: `Error: ${run.lastError}` });
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }
    }

    if (run.status === "WAITING_APPROVAL" && run.pendingStepIndex !== null) {
      const stepIndex = run.pendingStepIndex;
      const step = run.plan[stepIndex];
      const stepRecord = getOrCreateStepRecord(run, stepIndex, step);

      const tools = await listAllTools(userId);
      const validation = validateAllSteps([step], tools);
      if (!validation.valid) {
        run.status = "NEEDS_INPUT";
        run.pendingFieldCapture = {
          field: String(validation.missingField || ""),
          stepIndex,
          frozenSteps: run.plan.map((s) => ({ ...s, input: { ...s.input } })),
        };
        run.messages.push({
          role: "agent",
          text:
            validation.missingFieldQuestion ||
            `I need ${validation.missingField} to proceed.`,
        });
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }

      if (!approval.confirmed) {
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }

      await applySlackAutoFill(run, stepIndex);

      const response = await executeToolWithPolicy(
        userId,
        `${run.id}:${stepIndex + 1}`,
        step.tool,
        step.input,
        approval,
      );

      const responseBody = response.body || {};
      const policyVerdict =
        responseBody.status === "executed"
          ? "ALLOWED"
          : responseBody.status === "confirm_required"
            ? "CONFIRM_REQUIRED"
            : responseBody.status === "step_up_required"
              ? "STEP_UP_REQUIRED"
              : response.statusCode >= 400
                ? "ERROR"
                : "BLOCKED";
      recordPolicyVerdictEntry(
        userId,
        `${run.id}:${stepIndex + 1}`,
        step.tool,
        step.input,
        policyVerdict,
        String(responseBody.reason || responseBody.status || "Policy decision"),
      );

      if (
        responseBody.status === "confirm_required" ||
        responseBody.status === "step_up_required"
      ) {
        stepRecord.status = "APPROVAL_REQUIRED";
        stepRecord.result = responseBody;
        stepRecord.reason = responseBody.reason || "Approval required";
        run.status = "WAITING_APPROVAL";
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }

      if (response.statusCode >= 400 && responseBody.status !== "executed") {
        stepRecord.status = "ERROR";
        stepRecord.result = responseBody;
        stepRecord.reason = responseBody.reason || "Agent step failed";

        if (
          String(responseBody.reason || "")
            .toLowerCase()
            .startsWith("issues disabled in repository:")
        ) {
          run.status = "NEEDS_INPUT";
          run.lastError = undefined;
          run.messages.push({
            role: "agent",
            text:
              "That repository has GitHub Issues disabled, so I cannot create an issue there. Share another repository with Issues enabled, and I will retry.",
          });
          return res.json({ status: "ok", run: formatRunForClient(run) });
        }

        if (
          String(responseBody.reason || "")
            .toLowerCase()
            .startsWith("input validation failed")
        ) {
          run.status = "NEEDS_INPUT";
          run.lastError = undefined;
          run.messages.push({
            role: "agent",
            text: getToolAwareValidationPrompt(
              step.tool,
              String(responseBody.reason || ""),
            ),
          });
          return res.json({ status: "ok", run: formatRunForClient(run) });
        }

        run.status = "ERROR";
        run.lastError = responseBody.reason || "Agent step failed";
        run.messages.push({ role: "agent", text: `Error: ${run.lastError}` });
        return res.json({ status: "ok", run: formatRunForClient(run) });
      }

      stepRecord.status = "EXECUTED";
      stepRecord.result = responseBody;
      run.pendingStepIndex = null;
      run.currentStep += 1;
      run.status = "RUNNING";
      enqueueAgentRun(run.id);
      return res.json({ status: "ok", run: formatRunForClient(run) });
    }

    return res.json({ status: "ok", run: formatRunForClient(run) });
  });
}
