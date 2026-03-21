import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  AnimatePresence,
  LazyMotion,
  domAnimation,
  m,
} from "framer-motion";
import {
  Bot,
  ClipboardList,
  Eye,
  GitBranch,
  Home,
  Link2,
  ListChecks,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  getMe,
  getPolicies,
  putPolicies,
  getAllowedRepos,
  listAccessibleGithubRepos,
  putAllowedRepos,
  startStepUp,
  runAgent,
  getAgentRun,
  continueAgent,
  getAudit,
  getLlmAudit,
  getIdentities,
  linkIdentity,
  unlinkIdentity,
} from "./api";
import AgentPanel from "./components/AgentPanel";
import AllowListSection from "./components/AllowListSection";
import PoliciesSection from "./components/PoliciesSection";
import AuditSection from "./components/AuditSection";
import LlmAuditSection from "./components/LlmAuditSection";
import Dashboard from "./components/Dashboard.tsx";
import type {
  AuditEntry,
  AgentMessage,
  AgentRun,
  AgentTrace,
  IdentityEntry,
  LlmAuditEntry,
  Me,
  Policy,
} from "./types";
import type { GithubRepoPreview } from "./api";

const DEFAULTS: Policy[] = [
  { toolName: "github_explorer", riskLevel: "LOW", mode: "AUTO" },
  { toolName: "manage_issues", riskLevel: "MEDIUM", mode: "CONFIRM" },
  { toolName: "slack_notifier", riskLevel: "MEDIUM", mode: "CONFIRM" },
];

const PRIMARY_USER_KEY = "cc_primary_user_id";
const LINK_PROVIDER_KEY = "cc_link_provider";
const LINK_PRIMARY_USER_KEY = "cc_link_primary_user_id";
const STEP_UP_PENDING_KEY = "cc_step_up_pending";
const STEP_UP_RETURN_TO_KEY = "cc_step_up_return_to";
const STEP_UP_REQUESTED_AT_KEY = "cc_step_up_requested_at";
const AGENT_RUN_ID_KEY = "cc_agent_run_id";
const GITHUB_CONNECTION =
  (import.meta.env.VITE_AUTH0_CONNECTION_GITHUB as string) || "github";
const SLACK_CONNECTION =
  (import.meta.env.VITE_AUTH0_CONNECTION_SLACK as string) || "slack";
const GOOGLE_CONNECTION =
  (import.meta.env.VITE_AUTH0_CONNECTION_GOOGLE as string) || "google-oauth2";

function getConnectionForAuth0UserId(userId?: string | null) {
  if (!userId) return null;
  const normalized = String(userId).toLowerCase();
  if (normalized.startsWith("github|")) return GITHUB_CONNECTION;
  if (normalized.startsWith("google-oauth2|") || normalized.startsWith("google|")) {
    return GOOGLE_CONNECTION;
  }
  if (normalized.startsWith("oauth2|") || normalized.startsWith("slack|")) {
    return SLACK_CONNECTION;
  }
  return null;
}

function uuid() {
  return crypto.randomUUID();
}

const navBaseClass =
  "inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/6 px-3.5 py-1.5 text-sm font-semibold text-slate-200 transition";

const navClassName = ({ isActive }: { isActive: boolean }) =>
  isActive
    ? `${navBaseClass} border-cyan-300/55 bg-cyan-300/22 text-cyan-100 shadow-[0_0_16px_rgba(64,224,255,0.24)]`
    : `${navBaseClass} hover:border-cyan-300/35 hover:bg-white/10 hover:text-slate-100`;

const navItems = [
  { to: "/", label: "Home", icon: Home },
  { to: "/allow-list", label: "Allow-list", icon: ListChecks },
  { to: "/policies", label: "Policies", icon: ClipboardList },
  { to: "/agent", label: "Agent", icon: Bot },
  { to: "/audit", label: "Audit", icon: Eye },
  { to: "/llm-audit", label: "LLM Trace", icon: Sparkles },
] as const;

export default function App() {
  const { isAuthenticated, isLoading: authLoading, user, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0();
  const location = useLocation();
  const navigate = useNavigate();
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [me, setMe] = useState<Me | null>(null);
  const [policies, setPolicies] = useState<Policy[]>(DEFAULTS);
  const [allowedReposText, setAllowedReposText] = useState("");
  const [githubRepos, setGithubRepos] = useState<GithubRepoPreview[]>([]);
  const [loadingGithubRepos, setLoadingGithubRepos] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [llmAudit, setLlmAudit] = useState<LlmAuditEntry[]>([]);
  const [stepUpId, setStepUpId] = useState<string | null>(null);
  const [stepUpExpiresAt, setStepUpExpiresAt] = useState<string | null>(null);
  const [stepUpRemainingMs, setStepUpRemainingMs] = useState<number | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [identities, setIdentities] = useState<IdentityEntry[]>([]);
  const [primaryUserId, setPrimaryUserId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(PRIMARY_USER_KEY);
  });
  const [linkProvider, setLinkProvider] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(LINK_PROVIDER_KEY);
  });
  const [linkPrimaryUserId, setLinkPrimaryUserId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(LINK_PRIMARY_USER_KEY);
  });
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [policySyncing, setPolicySyncing] = useState(false);
  const [policyToast, setPolicyToast] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [routeSkeletonVisible, setRouteSkeletonVisible] = useState(false);
  const [stepUpPending, setStepUpPending] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STEP_UP_PENDING_KEY) === "1";
  });

  const [agentTask, setAgentTask] = useState("");
  const [agentRunId, setAgentRunId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(AGENT_RUN_ID_KEY);
  });
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [autoApprovingStepUp, setAutoApprovingStepUp] = useState(false);

  const getApiToken = useCallback(
    () =>
      getAccessTokenSilently({
        authorizationParams: {
          audience: "https://control-center-api",
        },
      }),
    [getAccessTokenSilently],
  );

  const refresh = useCallback(async () => {
    if (authLoading) {
      return;
    }
    if (!isAuthenticated) {
      return;
    }

    setRefreshing(true);
    try {
      const accessToken = await getApiToken();
      const [meRes, policiesRes, allowedRes, auditRes, llmAuditRes, identitiesRes] = await Promise.all([
        getMe(accessToken),
        getPolicies(accessToken),
        getAllowedRepos(accessToken),
        getAudit(accessToken, 25),
        getLlmAudit(accessToken, 25),
        getIdentities(accessToken),
      ]);

      setMe(meRes as Me);
      setAllowedReposText(Array.isArray(allowedRes) ? allowedRes.join("\n") : "");
      setAudit(Array.isArray(auditRes) ? (auditRes as AuditEntry[]) : []);
      setLlmAudit(Array.isArray(llmAuditRes) ? (llmAuditRes as LlmAuditEntry[]) : []);
      const nextIdentities: IdentityEntry[] = Array.isArray(identitiesRes?.identities)
        ? (identitiesRes.identities as IdentityEntry[])
        : [];
      setIdentities(nextIdentities);

      // Keep core refresh fast: populate GitHub repos asynchronously.
      setLoadingGithubRepos(true);
      void listAccessibleGithubRepos(accessToken)
        .then((repos) => {
          setGithubRepos(Array.isArray(repos) ? repos : []);
        })
        .catch(() => {
          setGithubRepos([]);
        })
        .finally(() => {
          setLoadingGithubRepos(false);
        });

      const currentUserId = (meRes as Me)?.userId;
      if (!primaryUserId && currentUserId && typeof window !== "undefined") {
        // First successful authenticated profile becomes primary, regardless of provider.
        window.localStorage.setItem(PRIMARY_USER_KEY, currentUserId);
        setPrimaryUserId(currentUserId);
      }
      if (Array.isArray(policiesRes) && policiesRes.length) {
        const merged = new Map(DEFAULTS.map((p) => [p.toolName, p]));
        (policiesRes as Policy[]).forEach((p) => merged.set(p.toolName, p));
        setPolicies(Array.from(merged.values()));
      } else {
        setPolicies(DEFAULTS);
      }
    } finally {
      setRefreshing(false);
    }
  }, [authLoading, getApiToken, isAuthenticated, primaryUserId]);

  function storeLinkProvider(provider: string | null) {
    if (typeof window === "undefined") return;
    if (provider) {
      window.localStorage.setItem(LINK_PROVIDER_KEY, provider);
    } else {
      window.localStorage.removeItem(LINK_PROVIDER_KEY);
    }
    setLinkProvider(provider);
  }

  function storeLinkPrimaryUserId(userId: string | null) {
    if (typeof window === "undefined") return;
    if (userId) {
      window.localStorage.setItem(LINK_PRIMARY_USER_KEY, userId);
    } else {
      window.localStorage.removeItem(LINK_PRIMARY_USER_KEY);
    }
    setLinkPrimaryUserId(userId);
  }

  function storeStepUpPending(pending: boolean) {
    if (typeof window === "undefined") return;
    if (pending) {
      window.localStorage.setItem(STEP_UP_PENDING_KEY, "1");
    } else {
      window.localStorage.removeItem(STEP_UP_PENDING_KEY);
    }
    setStepUpPending(pending);
  }

  function hasPendingStepUp() {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STEP_UP_PENDING_KEY) === "1";
  }

  function storeStepUpReturnTo(returnTo: string | null) {
    if (typeof window === "undefined") return;
    if (returnTo) {
      window.localStorage.setItem(STEP_UP_RETURN_TO_KEY, returnTo);
    } else {
      window.localStorage.removeItem(STEP_UP_RETURN_TO_KEY);
    }
  }

  function storeStepUpRequestedAtMs(value: number | null) {
    if (typeof window === "undefined") return;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      window.localStorage.setItem(STEP_UP_REQUESTED_AT_KEY, String(Math.floor(value)));
    } else {
      window.localStorage.removeItem(STEP_UP_REQUESTED_AT_KEY);
    }
  }

  function getStepUpRequestedAtMs() {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(STEP_UP_REQUESTED_AT_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (agentRunId) {
      window.localStorage.setItem(AGENT_RUN_ID_KEY, agentRunId);
    } else {
      window.localStorage.removeItem(AGENT_RUN_ID_KEY);
    }
  }, [agentRunId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [refresh]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      setCursor({ x: event.clientX, y: event.clientY });
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  useEffect(() => {
    if (!stepUpExpiresAt) return undefined;

    const intervalId = window.setInterval(() => {
      const remaining = new Date(stepUpExpiresAt).getTime() - Date.now();
      const nextRemaining = Math.max(0, remaining);
      setStepUpRemainingMs(nextRemaining);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [stepUpExpiresAt]);

  useEffect(() => {
    const pathsWithDataFetchSkeleton = new Set(["/audit", "/llm-audit", "/policies"]);
    if (!pathsWithDataFetchSkeleton.has(location.pathname)) {
      setRouteSkeletonVisible(false);
      return;
    }
    setRouteSkeletonVisible(true);
    const timeoutId = window.setTimeout(() => setRouteSkeletonVisible(false), 520);
    return () => window.clearTimeout(timeoutId);
  }, [location.pathname]);

  useEffect(() => {
    if (!isAuthenticated || !agentRunId) return;
    if (agentRun?.status && ["COMPLETED", "ERROR"].includes(agentRun.status)) return;

    let active = true;
    const interval = setInterval(async () => {
      try {
        const accessToken = await getApiToken();
        const r = await getAgentRun(accessToken, agentRunId);
        if (!active) return;
        if (r?.run) {
          const run = r.run as AgentRun;
          setAgentRun(run);
          setAgentMessages(run.messages || []);
        }
      } catch {
        // Ignore polling failures; next tick will retry.
      }
    }, 2000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [agentRunId, agentRun?.status, isAuthenticated, getApiToken]);

  async function sendAgentMessage() {
    const message = agentTask.trim();
    if (!message) return;
    const accessToken = await getApiToken();

    if (!agentRunId || ["COMPLETED", "ERROR"].includes(agentRun?.status ?? "")) {
      const r = await runAgent(accessToken, {
        requestId: uuid(),
        task: message,
        context: {},
      });
      if (r?.run) {
        const run = r.run as AgentRun;
        setAgentRunId(run.id);
        setAgentRun(run);
        setAgentMessages(run.messages || []);
      }
      setAgentTask("");
      return;
    }

    if (agentRun?.status === "WAITING_APPROVAL") {
      setAgentTask("");
      return;
    }

    const r = await continueAgent(accessToken, {
      runId: agentRunId,
      message,
    });
    if (r?.run) {
      const run = r.run as AgentRun;
      setAgentRun(run);
      setAgentMessages(run.messages || []);
    }
    setAgentTask("");
  }

  async function saveAllowedRepos() {
    const accessToken = await getApiToken();

    const repos = allowedReposText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    await putAllowedRepos(accessToken, repos);
    await refresh();
  }

  async function addAllowListedRepo(repo: string) {
    const accessToken = await getApiToken();
    const current = allowedReposText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const next = Array.from(new Set([...current, repo]));
    await putAllowedRepos(accessToken, next);
    await refresh();

    if (agentRunId && agentRun?.status === "NEEDS_INPUT") {
      const r = await continueAgent(accessToken, {
        runId: agentRunId,
        message: repo,
      });
      if (r?.run) {
        const run = r.run as AgentRun;
        setAgentRun(run);
        setAgentMessages(run.messages || []);
      }
    }
  }

  async function savePolicies() {
    try {
      setPolicySyncing(true);
      const accessToken = await getApiToken();
      await putPolicies(accessToken, policies);
      await refresh();
      setPolicyToast("[SYSTEM]: Policy manifest synced to Agent Node.");
    } finally {
      setPolicySyncing(false);
    }
  }

  useEffect(() => {
    if (!policyToast) return;
    const timeoutId = window.setTimeout(() => setPolicyToast(null), 2400);
    return () => window.clearTimeout(timeoutId);
  }, [policyToast]);

  async function doStepUp() {
    const returnTo = `${location.pathname}${location.search || ""}`;
    storeStepUpReturnTo(returnTo || "/agent");
    storeStepUpRequestedAtMs(Date.now());
    storeStepUpPending(true);
    await loginWithRedirect({
      appState: { returnTo: returnTo || "/agent" },
      authorizationParams: {
        redirect_uri: window.location.origin,
        audience: "https://control-center-api",
        prompt: "login",
        max_age: 0,
        acr_values:
          "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
      },
    });
    return "pending";
  }

  async function approvePendingStep(requireStepUp: boolean) {
    if (!agentRunId) return;
    if (requireStepUp && !stepUpActive) {
      setApprovalError("Start a step-up session before approving high-risk actions.");
      return;
    }
    const accessToken = await getApiToken();
    const r = await continueAgent(accessToken, {
      runId: agentRunId,
      approval: { confirmed: true, stepUpId: requireStepUp ? stepUpId : null },
    });
    if (r?.run) {
      const run = r.run as AgentRun;
      setAgentRun(run);
      setAgentMessages(run.messages || []);
    }
    setApprovalError(null);
  }

  const linkSecondaryToPrimary = useCallback(
    async (secondaryUserId: string, provider: string) => {
      const targetPrimaryUserId = linkPrimaryUserId || primaryUserId;
      if (!targetPrimaryUserId) {
        throw new Error("Primary account is not stored yet. Log in once and retry.");
      }
      const accessToken = await getApiToken();
      return linkIdentity(accessToken, {
        primaryUserId: targetPrimaryUserId,
        secondaryUserId,
        provider,
      });
    },
    [getApiToken, linkPrimaryUserId, primaryUserId],
  );

  function startLink(provider: "github" | "slack") {
    const connection = provider === "github" ? GITHUB_CONNECTION : SLACK_CONNECTION;
    const targetPrimaryUserId = primaryUserId || me?.userId || user?.sub || null;
    if (!targetPrimaryUserId) {
      setLinkError("Primary account missing. Log in once, then retry linking.");
      return;
    }
    setLinkError(null);
    storeLinkPrimaryUserId(targetPrimaryUserId);
    storeLinkProvider(provider);
    void loginWithRedirect({
      authorizationParams: {
        redirect_uri: window.location.origin,
        audience: "https://control-center-api",
        connection,
        prompt: "login",
      },
    });
  }

  async function unlinkIdentityFromDashboard(provider: string, providerUserId: string) {
    // Unlink action should always cancel any stale cross-provider link session state.
    storeLinkProvider(null);
    storeLinkPrimaryUserId(null);
    setLinking(false);
    setLinkError(null);

    const accessToken = await getApiToken();
    const result = await unlinkIdentity(accessToken, { provider, providerUserId });
    await refresh();

    storeLinkProvider(null);
    storeLinkPrimaryUserId(null);
    setLinking(false);

    return result;
  }

  const agentSteps = Array.isArray(agentRun?.steps) ? agentRun.steps : [];
  const agentTrace = Array.isArray(agentRun?.trace) ? agentRun.trace : [];
  const pendingApproval = agentSteps.find((step) => step.status === "APPROVAL_REQUIRED");
  const pendingApprovalStatus = pendingApproval?.result?.status || null;
  const stepUpActive = useMemo(() => {
    if (!stepUpId) return false;
    if (stepUpRemainingMs === null) return true;
    return stepUpRemainingMs > 0;
  }, [stepUpId, stepUpRemainingMs]);
  const stepUpRemainingText = useMemo(() => {
    if (stepUpRemainingMs === null) return "-";
    const totalSeconds = Math.floor(stepUpRemainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }, [stepUpRemainingMs]);

  useEffect(() => {
    const secondaryUserId = user?.sub;
    const targetPrimaryUserId = linkPrimaryUserId || primaryUserId;
    if (!isAuthenticated || !linkProvider || !secondaryUserId || !targetPrimaryUserId) return;
    if (linking) return;
    if (secondaryUserId === targetPrimaryUserId) {
      let active = true;
      setLinking(true);
      setLinkError(null);

      (async () => {
        try {
          await linkSecondaryToPrimary(secondaryUserId, linkProvider);
        } catch (err: unknown) {
          if (!active) return;
          const message = err instanceof Error ? err.message : "Link failed.";
          setLinkError(message);
        } finally {
          storeLinkProvider(null);
          storeLinkPrimaryUserId(null);
          setLinking(false);
        }
      })();

      return () => {
        active = false;
      };
    }

    let active = true;
    setLinking(true);
    setLinkError(null);

    (async () => {
      try {
        await linkSecondaryToPrimary(secondaryUserId, linkProvider);
        storeLinkProvider(null);
        storeLinkPrimaryUserId(null);
        if (!active) return;
        const primaryConnection = getConnectionForAuth0UserId(targetPrimaryUserId);
        await loginWithRedirect({
          authorizationParams: {
            redirect_uri: window.location.origin,
            audience: "https://control-center-api",
            ...(primaryConnection ? { connection: primaryConnection } : {}),
            prompt: "login",
          },
        });
      } catch (err: unknown) {
        if (!active) return;
        const message = err instanceof Error ? err.message : "Link failed.";
        setLinkError(message);
        storeLinkProvider(null);
        storeLinkPrimaryUserId(null);
      } finally {
        storeLinkProvider(null);
        storeLinkPrimaryUserId(null);
        setLinking(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [
    isAuthenticated,
    linkProvider,
    linkPrimaryUserId,
    user?.sub,
    primaryUserId,
    linking,
    linkSecondaryToPrimary,
    loginWithRedirect,
  ]);

  useEffect(() => {
    const targetPrimaryUserId = linkPrimaryUserId;
    if (!isAuthenticated || !targetPrimaryUserId || !user?.sub) return;
    if (linkProvider || linking) return;
    if (user.sub === targetPrimaryUserId) {
      if (linkPrimaryUserId) {
        storeLinkPrimaryUserId(null);
      }
      return;
    }

    const primaryConnection = getConnectionForAuth0UserId(targetPrimaryUserId);
    void loginWithRedirect({
      authorizationParams: {
        redirect_uri: window.location.origin,
        audience: "https://control-center-api",
        ...(primaryConnection ? { connection: primaryConnection } : {}),
        prompt: "login",
      },
    });
  }, [
    isAuthenticated,
    linkPrimaryUserId,
    user?.sub,
    linkProvider,
    linking,
    loginWithRedirect,
  ]);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    if (!hasPendingStepUp()) return;

    const stored =
      typeof window !== "undefined" ? window.localStorage.getItem(STEP_UP_RETURN_TO_KEY) : null;
    const target = stored && stored.startsWith("/") ? stored : "/agent";
    const current = `${location.pathname}${location.search || ""}`;
    if (current !== target) {
      navigate(target, { replace: true });
    }
  }, [authLoading, isAuthenticated, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    if (!hasPendingStepUp()) return;

    let active = true;
    (async () => {
      try {
        const accessToken = await getApiToken();
        const r = await startStepUp(accessToken, getStepUpRequestedAtMs());
        if (!active) return;
        setStepUpId(r.stepUpId);
        setStepUpExpiresAt(r.expiresAt || null);
        if (r.expiresAt) {
          const remaining = new Date(r.expiresAt).getTime() - Date.now();
          setStepUpRemainingMs(Math.max(0, remaining));
        } else {
          setStepUpRemainingMs(null);
        }

        if (agentRunId && pendingApprovalStatus === "step_up_required") {
          const continued = await continueAgent(accessToken, {
            runId: agentRunId,
            approval: { confirmed: true, stepUpId: r.stepUpId },
          });
          if (continued?.run) {
            const run = continued.run as AgentRun;
            setAgentRun(run);
            setAgentMessages(run.messages || []);
          }
          setApprovalError(null);
        }

        await refresh();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Step-up verification failed.";
        setApprovalError(message);
      } finally {
        storeStepUpPending(false);
        storeStepUpReturnTo(null);
        storeStepUpRequestedAtMs(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [authLoading, getApiToken, isAuthenticated, refresh, agentRunId, pendingApprovalStatus]);

  useEffect(() => {
    if (!isAuthenticated || authLoading) return;
    if (!agentRunId || !stepUpId) return;
    if (!stepUpActive) return;
    if (agentRun?.status !== "WAITING_APPROVAL") return;
    if (pendingApprovalStatus !== "step_up_required") return;
    if (autoApprovingStepUp) return;

    let active = true;
    setAutoApprovingStepUp(true);

    (async () => {
      try {
        const accessToken = await getApiToken();
        const continued = await continueAgent(accessToken, {
          runId: agentRunId,
          approval: { confirmed: true, stepUpId },
        });
        if (!active) return;
        if (continued?.run) {
          const run = continued.run as AgentRun;
          setAgentRun(run);
          setAgentMessages(run.messages || []);
        }
        setApprovalError(null);
      } catch (err: unknown) {
        if (!active) return;
        const message =
          err instanceof Error ? err.message : "Step-up approval failed. Please retry.";
        setApprovalError(message);
      } finally {
        if (active) {
          setAutoApprovingStepUp(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [
    isAuthenticated,
    authLoading,
    agentRunId,
    stepUpId,
    stepUpActive,
    agentRun?.status,
    pendingApprovalStatus,
    autoApprovingStepUp,
    getApiToken,
  ]);

  const showAuthTransitionGate =
    authLoading ||
    (!isAuthenticated && (Boolean(linkProvider) || stepUpPending));

  if (showAuthTransitionGate) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 text-slate-200">
        Restoring secure session...
      </div>
    );
  }

  const allowListSection = (
    <AllowListSection
      allowedReposText={allowedReposText}
      onChange={setAllowedReposText}
      onSave={saveAllowedRepos}
      githubRepos={githubRepos}
      loadingRepos={loadingGithubRepos}
    />
  );

  const policiesSection = (
    <PoliciesSection
      policies={policies}
      onChange={setPolicies}
      onSave={savePolicies}
      onReload={refresh}
    />
  );

  const auditSection = <AuditSection audit={audit} />;
  const llmAuditSection = <LlmAuditSection entries={llmAudit} />;

  const dashboard = (
    <Dashboard
      allowedReposCount={allowedReposText ? allowedReposText.split("\n").filter(Boolean).length : 0}
      policiesCount={policies.length}
      auditCount={audit.length}
      stepUpActive={stepUpActive}
      identities={identities}
      userId={me?.userId}
      primaryUserId={primaryUserId}
      onUnlinkIdentity={unlinkIdentityFromDashboard}
      onStartLink={startLink}
      linkError={linkError}
      linking={linking}
    />
  );

  const agentSection = (
    <AgentPanel
      agentTask={agentTask}
      onTaskChange={setAgentTask}
      onSend={sendAgentMessage}
      agentRun={agentRun}
      agentMessages={agentMessages}
      agentSteps={agentSteps}
      agentTrace={agentTrace as AgentTrace[]}
      pendingApprovalStep={pendingApproval}
      pendingApprovalStatus={pendingApprovalStatus}
      approvalError={approvalError}
      onConfirm={() => approvePendingStep(false)}
      onApprove={() => approvePendingStep(true)}
      onAllowListRepo={addAllowListedRepo}
      stepUpInfo={{
        active: stepUpActive,
        expiresAt: stepUpExpiresAt,
        remainingText: stepUpRemainingText,
        pending: stepUpPending,
      }}
      onStartStepUp={doStepUp}
    />
  );

  const showRouteSkeleton =
    isAuthenticated &&
    (routeSkeletonVisible || refreshing) &&
    ["/audit", "/llm-audit", "/policies"].includes(location.pathname);

  const skeletonCard = "rounded-2xl border border-white/10 bg-slate-800/65 animate-pulse";

  const routeSkeleton = (
    <div className="rounded-[2.1rem] border border-white/15 bg-white/8 p-6 backdrop-blur-xl md:p-7">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={`s-card-${idx}`} className={`${skeletonCard} h-24`} />
        ))}
      </div>
      <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-3">
        <div className={`${skeletonCard} h-11`} />
        <div className="mt-3 flex gap-2">
          <div className={`${skeletonCard} h-8 w-18 rounded-full`} />
          <div className={`${skeletonCard} h-8 w-18 rounded-full`} />
          <div className={`${skeletonCard} h-8 w-18 rounded-full`} />
        </div>
      </div>
      <div className="mt-4 rounded-[1.6rem] border-2 border-black bg-black/35 p-3">
        <div className="grid gap-2">
          {Array.from({ length: 7 }).map((_, idx) => (
            <div key={`s-row-${idx}`} className={`${skeletonCard} h-13`} />
          ))}
        </div>
      </div>
    </div>
  );

  const agentStatusLabel =
    agentRun?.status === "RUNNING" ||
    agentRun?.status === "WAITING_APPROVAL" ||
    agentRun?.status === "NEEDS_INPUT"
      ? "PROCESSING"
      : "STANDBY";
  const identityLabel = user?.email ?? user?.name ?? user?.sub ?? "Account";
  const identityInitial = identityLabel.charAt(0).toUpperCase();
  const startLogin = () =>
    loginWithRedirect({
      authorizationParams: {
        redirect_uri: window.location.origin,
        audience: "https://control-center-api",
      },
    });

  return (
    <LazyMotion features={domAnimation}>
      <div className="relative min-h-screen overflow-x-clip bg-[#0a0a0a] text-slate-100 font-['Inter_Tight',sans-serif]">
        <AnimatePresence>
          {policySyncing ? (
            <m.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="pointer-events-none fixed left-0 right-0 top-0 z-70 h-1 bg-cyan-300/25"
            >
              <m.div
                className="h-full w-1/3 bg-cyan-300 shadow-[0_0_18px_rgba(64,224,255,0.8)]"
                initial={{ x: "-120%" }}
                animate={{ x: "420%" }}
                transition={{ duration: 1.05, repeat: Infinity, ease: "linear" }}
              />
            </m.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {policyToast ? (
            <m.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              className="fixed bottom-5 right-5 z-70 rounded-xl border border-cyan-300/35 bg-[#0f141f]/90 px-4 py-3 font-mono text-sm text-cyan-100 shadow-[0_0_24px_rgba(64,224,255,0.25)]"
            >
              {policyToast}
            </m.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {stepUpPending && isAuthenticated ? (
            <m.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              className="fixed bottom-20 right-5 z-70 rounded-xl border border-amber-300/35 bg-[#15110a]/90 px-4 py-3 font-mono text-sm text-amber-100 shadow-[0_0_24px_rgba(255,184,0,0.2)]"
            >
              [SECURITY]: Step-up in progress. Complete Auth0 verification.
            </m.div>
          ) : null}
        </AnimatePresence>

        <div
          className="pointer-events-none fixed inset-0 -z-10"
          style={{
            background: `radial-gradient(520px circle at ${cursor.x}px ${cursor.y}px, rgba(34,211,238,0.2), rgba(232,121,249,0.14) 35%, rgba(10,10,10,0.92) 68%)`,
          }}
        />
        <div className="pointer-events-none fixed inset-0 -z-20 bg-[radial-gradient(55rem_55rem_at_0%_0%,rgba(30,45,72,0.5),transparent_62%),radial-gradient(55rem_55rem_at_100%_100%,rgba(14,25,44,0.45),transparent_66%)]">
          <m.div
            className="animate-aurora absolute -left-28 -top-35 h-107.5 w-107.5 rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.32)_0%,rgba(56,189,248,0)_72%)]"
            animate={{ x: [0, 70, -20, 0], y: [0, 40, -12, 0] }}
            transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
          />
          <m.div
            className="animate-aurora absolute -right-40 top-22.5 h-130 w-130 rounded-full bg-[radial-gradient(circle,rgba(217,70,239,0.28)_0%,rgba(217,70,239,0)_72%)]"
            animate={{ x: [0, -45, 35, 0], y: [0, -30, 20, 0] }}
            transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
          />
          <m.div
            className="animate-aurora absolute -bottom-45 left-[28%] h-140 w-140 rounded-full bg-[radial-gradient(circle,rgba(250,204,21,0.18)_0%,rgba(250,204,21,0)_70%)]"
            animate={{ x: [0, 45, -30, 0], y: [0, -45, 20, 0] }}
            transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>

        <m.header
          className="sticky top-0 z-30 border-b border-white/10 bg-black/70 px-3 py-3 backdrop-blur-xl md:px-6 lg:px-8 xl:px-10 2xl:px-12"
        >
          <div
            className={`grid w-full grid-cols-1 items-center gap-3 ${
              isAuthenticated
                ? "lg:grid-cols-[minmax(280px,1fr)_auto_minmax(320px,1fr)]"
                : "lg:grid-cols-[minmax(280px,1fr)_auto]"
            }`}
          >
            <m.div className="min-w-0 lg:justify-self-start">
              <div className="text-[11px] uppercase tracking-[0.2em] text-fuchsia-200/85">
                From prompt to action, safely.
              </div>
              <h1
                className={`mt-1 max-w-[12ch] bg-linear-to-r from-white via-slate-100 to-slate-400 bg-clip-text font-['Syne',sans-serif] text-4xl leading-[0.92] font-extrabold tracking-[-0.035em] text-transparent [text-shadow:0_0_18px_rgba(255,255,255,0.14)] md:text-5xl lg:text-4xl xl:text-5xl ${
                  isAuthenticated ? "opacity-100" : "opacity-80"
                }`}
              >
                FlowSnap Control Plane
              </h1>
              <div className="mt-1 inline-flex items-center gap-2 text-[13px] font-medium text-cyan-100/75">
                <GitBranch className="h-3.5 w-3.5" />
                Immersive governance for AI actions
              </div>
            </m.div>

            {isAuthenticated ? (
              <nav className="flex flex-wrap items-center justify-start gap-2 overflow-x-auto md:flex-nowrap lg:justify-center">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink key={item.to} to={item.to} className={navClassName}>
                      <Icon className="h-3.5 w-3.5" />
                      {item.label}
                    </NavLink>
                  );
                })}
              </nav>
            ) : null}

            <div className="flex flex-col items-end gap-2 lg:justify-self-end">
              {!isAuthenticated ? (
                <m.button
                  type="button"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  onClick={startLogin}
                  className="rounded-full border border-cyan-300/60 bg-cyan-300/10 px-5 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-300/16"
                >
                  Log in
                </m.button>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3 lg:justify-end">
                    <div className="flex flex-col items-start gap-1.5">
                      <div className="flex items-center gap-2 rounded-2xl border border-white/15 bg-white/5 px-3 py-2 text-base text-slate-200 backdrop-blur-xl">
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-cyan-300/40 bg-cyan-300/15 text-sm font-semibold text-cyan-100">
                          {identityInitial}
                        </span>
                        <div>
                          Logged in as <b>{identityLabel}</b>
                        </div>
                      </div>
                    </div>
                    <m.button
                      type="button"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      transition={{ type: "spring", stiffness: 300, damping: 30 }}
                      onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
                      className="rounded-full border border-white/25 bg-transparent px-4 py-2 text-sm font-semibold text-slate-100 transition hover:border-white/40 hover:bg-white/8"
                    >
                      Log out
                    </m.button>
                  </div>
                  <div className="rounded-full border border-cyan-300/35 bg-cyan-300/12 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan-100 shadow-[0_0_10px_rgba(64,224,255,0.2)]">
                    Agent: {agentStatusLabel}
                  </div>
                </>
              )}
            </div>
          </div>
        </m.header>

        <main className="content-scale grid w-full gap-6 px-3 py-6 md:px-6 lg:px-8 lg:py-8 xl:px-10 2xl:px-12">
          {!isAuthenticated ? (
            <m.section
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="relative isolate grid min-h-[calc(100vh-11rem)] place-items-center overflow-hidden rounded-[2.2rem] border border-white/15 bg-white/6 p-6 text-slate-100 backdrop-blur-xl md:p-9"
            >
              <div className="pointer-events-none absolute inset-0 opacity-86 md:opacity-95">
                <m.div
                  className="absolute inset-x-5 top-5 h-[56%] overflow-hidden rounded-4xl border border-cyan-300/22 bg-[#0d1522]/78 shadow-[0_14px_60px_rgba(0,0,0,0.45)]"
                  animate={{ opacity: [0.9, 0.95, 0.9] }}
                  transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
                >
                  <div className="absolute inset-x-0 top-0 h-12 border-b border-white/8 bg-black/30" />
                  <div className="absolute left-4 top-3 h-5 w-30 rounded-full border border-cyan-300/25 bg-cyan-300/12" />
                  <div className="absolute right-4 top-3 h-5 w-24 rounded-full border border-white/15 bg-white/7" />

                  <div className="absolute inset-x-5 top-18 grid grid-cols-[1.45fr_0.85fr] gap-4">
                    <div className="rounded-3xl border border-white/10 bg-[#101b2b]/72 p-4">
                      <div className="h-6 w-52 rounded-full border border-cyan-300/20 bg-cyan-300/10" />
                      <div className="mt-3 h-3 w-[88%] rounded bg-white/10" />
                      <div className="mt-2 h-3 w-[76%] rounded bg-white/8" />
                      <div className="mt-5 h-28 rounded-2xl border border-cyan-300/20 bg-black/35 p-3">
                        <div className="relative h-full w-full">
                          <svg viewBox="0 0 100 44" className="absolute inset-0 h-full w-full" aria-hidden="true">
                            <line x1="16" y1="31" x2="47" y2="22" stroke="rgba(64,224,255,0.55)" strokeDasharray="3 5" />
                            <line x1="47" y1="22" x2="82" y2="19" stroke="rgba(64,224,255,0.55)" strokeDasharray="3 5" />
                          </svg>
                          <div className="absolute left-[12%] top-[58%] h-7 w-7 rounded-full border border-white/25 bg-white/10" />
                          <div className="absolute left-[43%] top-[40%] h-9 w-9 rounded-full border border-cyan-300/45 bg-cyan-300/18" />
                          <div className="absolute left-[76%] top-[30%] h-7 w-7 rounded-full border border-white/25 bg-white/10" />
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3">
                      <div className="h-16 rounded-2xl border border-white/10 bg-black/30" />
                      <div className="h-16 rounded-2xl border border-white/10 bg-black/30" />
                      <div className="h-16 rounded-2xl border border-white/10 bg-black/30" />
                    </div>
                  </div>

                  <div className="absolute inset-x-5 bottom-5 grid grid-cols-2 gap-4">
                    <div className="h-18 rounded-2xl border border-white/10 bg-black/30" />
                    <div className="h-18 rounded-2xl border border-cyan-300/18 bg-cyan-950/20" />
                  </div>

                  <div className="absolute inset-0 bg-linear-to-b from-transparent via-transparent to-black/55" />
                  <div className="absolute right-5 top-14 rounded-full border border-amber-300/35 bg-amber-300/12 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.11em] text-amber-100">
                    Locked Preview
                  </div>
                </m.div>

                <div className="absolute inset-0 backdrop-blur-md md:backdrop-blur-[10px] mask-[radial-gradient(ellipse_at_center,transparent_30%,black_95%)]" />
              </div>

              <div className="pointer-events-none absolute inset-0">
                <div className="absolute left-[18%] top-[35%] h-72 w-72 rounded-full bg-cyan-500/10 blur-[120px]" />
                <div className="absolute right-[18%] top-[40%] h-72 w-72 rounded-full bg-indigo-500/12 blur-[120px]" />
              </div>

              <div className="relative z-10 mx-auto w-full max-w-4xl">
                <div className="rounded-4xl border border-white/20 bg-[#0f1623]/72 p-6 shadow-[0_20px_70px_rgba(0,0,0,0.45)] backdrop-blur-2xl md:p-9">
                  <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/40 bg-cyan-300/12 px-3 py-1 text-xs uppercase tracking-[0.15em] text-cyan-100">
                    Private Control Plane
                  </div>
                  <h2 className="mt-4 max-w-3xl text-4xl font-black tracking-[-0.03em] text-white md:text-6xl md:leading-[1.02]">
                    The Secure Control Plane for Autonomous Agents.
                  </h2>
                  <p className="mt-4 max-w-2xl text-base text-slate-200 md:text-lg">
                    Link identities, govern tool permissions, and inspect every agent decision before action reaches production.
                  </p>

                  <m.button
                    type="button"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    animate={{ scale: [1, 1.02, 1] }}
                    transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                    onClick={startLogin}
                    className="mt-6 inline-flex items-center gap-2 rounded-full border border-cyan-200/50 bg-cyan-300 px-7 py-3 text-base font-black text-black shadow-[0_0_20px_rgba(6,182,212,0.3)]"
                  >
                    Enter Control Plane
                  </m.button>

                  <div className="mt-6 grid gap-3 md:grid-cols-3">
                    <div className="rounded-2xl border border-white/5 bg-black/30 p-4 transition hover:border-cyan-500/30">
                      <div className="inline-flex items-center gap-2 text-sm font-semibold text-cyan-100">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-cyan-300/12 shadow-[0_0_10px_rgba(34,211,238,0.35)]">
                          <Link2 className="h-3.5 w-3.5 text-cyan-300" />
                        </span>
                        Identity
                      </div>
                      <p className="mt-2 text-xs text-slate-300">
                        Link GitHub and Slack through the Auth0 Token Vault.
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white/5 bg-black/30 p-4 transition hover:border-cyan-500/30">
                      <div className="inline-flex items-center gap-2 text-sm font-semibold text-amber-100">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-300/12 shadow-[0_0_10px_rgba(251,191,36,0.35)]">
                          <ShieldCheck className="h-3.5 w-3.5 text-amber-300" />
                        </span>
                        Governance
                      </div>
                      <p className="mt-2 text-xs text-slate-300">
                        Apply fine-grained tool policies with explicit risk gates.
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white/5 bg-black/30 p-4 transition hover:border-cyan-500/30">
                      <div className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-100">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-300/12 shadow-[0_0_10px_rgba(52,211,153,0.35)]">
                          <Eye className="h-3.5 w-3.5 text-emerald-300" />
                        </span>
                        Observability
                      </div>
                      <p className="mt-2 text-xs text-slate-300">
                        Review full LLM traces and policy audit logs in one timeline.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </m.section>
          ) : (
            <AnimatePresence mode="wait">
              <m.div
                key={location.pathname}
                initial={{ opacity: 0, y: 22 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -16 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              >
                <Routes location={location}>
                  <Route path="/" element={dashboard} />
                  <Route path="/allow-list" element={allowListSection} />
                  <Route path="/policies" element={showRouteSkeleton ? routeSkeleton : policiesSection} />
                  <Route path="/agent" element={agentSection} />
                  <Route path="/audit" element={showRouteSkeleton ? routeSkeleton : auditSection} />
                  <Route path="/llm-audit" element={showRouteSkeleton ? routeSkeleton : llmAuditSection} />
                  <Route path="*" element={dashboard} />
                </Routes>
              </m.div>
            </AnimatePresence>
          )}
        </main>
      </div>
    </LazyMotion>
  );
}
