import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { NavLink, Route, Routes } from "react-router-dom";
import {
  getMe,
  getPolicies,
  putPolicies,
  getAllowedRepos,
  putAllowedRepos,
  startStepUp,
  runAgent,
  getAgentRun,
  continueAgent,
  getAudit,
  getIdentities,
  linkIdentity,
  unlinkIdentity,
} from "./api";
import AgentPanel from "./components/AgentPanel";
import AllowListSection from "./components/AllowListSection";
import PoliciesSection from "./components/PoliciesSection";
import AuditSection from "./components/AuditSection";
import Dashboard from "./components/Dashboard";
import type {
  AuditEntry,
  AgentMessage,
  AgentRun,
  AgentTrace,
  IdentityEntry,
  Me,
  Policy,
} from "./types";
import "./App.css";

const DEFAULTS: Policy[] = [
  { toolName: "list_repos", riskLevel: "LOW", mode: "AUTO" },
  { toolName: "list_issues", riskLevel: "LOW", mode: "AUTO" },
  { toolName: "create_issue", riskLevel: "MEDIUM", mode: "CONFIRM" },
  { toolName: "close_issue", riskLevel: "HIGH", mode: "STEP_UP" },
  { toolName: "close_issues", riskLevel: "HIGH", mode: "STEP_UP" },
  { toolName: "slack_post_message", riskLevel: "HIGH", mode: "STEP_UP" },
  { toolName: "summarize_github_to_slack", riskLevel: "HIGH", mode: "STEP_UP" },
  { toolName: "create_issue_and_notify", riskLevel: "HIGH", mode: "STEP_UP" },
];

const PRIMARY_USER_KEY = "cc_primary_user_id";
const LINK_PROVIDER_KEY = "cc_link_provider";
const GITHUB_CONNECTION =
  (import.meta.env.VITE_AUTH0_CONNECTION_GITHUB as string) || "github";
const SLACK_CONNECTION =
  (import.meta.env.VITE_AUTH0_CONNECTION_SLACK as string) || "slack";
const GOOGLE_CONNECTION =
  (import.meta.env.VITE_AUTH0_CONNECTION_GOOGLE as string) || "google-oauth2";

function uuid() {
  return crypto.randomUUID();
}

export default function App() {
  const { isAuthenticated, user, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0();
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [policies, setPolicies] = useState<Policy[]>(DEFAULTS);
  const [allowedReposText, setAllowedReposText] = useState("");
  const [audit, setAudit] = useState<AuditEntry[]>([]);
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
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  const [agentTask, setAgentTask] = useState("");
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);

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
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    const accessToken = await getApiToken();
    const [meRes, policiesRes, allowedRes, auditRes, identitiesRes] = await Promise.all([
      getMe(accessToken),
      getPolicies(accessToken),
      getAllowedRepos(accessToken),
      getAudit(accessToken, 25),
      getIdentities(accessToken),
    ]);

    setMe(meRes as Me);
    setAllowedReposText(Array.isArray(allowedRes) ? allowedRes.join("\n") : "");
    setAudit(Array.isArray(auditRes) ? (auditRes as AuditEntry[]) : []);
    const nextIdentities = Array.isArray(identitiesRes?.identities) ? identitiesRes.identities : [];
    setIdentities(nextIdentities);
    const isGooglePrimary = nextIdentities.some(
      (identity) =>
        identity?.provider === "google-oauth2" ||
        identity?.provider === "google" ||
        identity?.connection === "google" ||
        identity?.connection === "google-oauth2",
    );
    if (isGooglePrimary && (meRes as Me)?.userId && typeof window !== "undefined") {
      window.localStorage.setItem(PRIMARY_USER_KEY, (meRes as Me).userId);
      setPrimaryUserId((meRes as Me).userId);
    }
    if (Array.isArray(policiesRes) && policiesRes.length) {
      const merged = new Map(DEFAULTS.map((p) => [p.toolName, p]));
      (policiesRes as Policy[]).forEach((p) => merged.set(p.toolName, p));
      setPolicies(Array.from(merged.values()));
    } else {
      setPolicies(DEFAULTS);
    }
    setLoading(false);
  }, [getApiToken, isAuthenticated]);

  function storeLinkProvider(provider: string | null) {
    if (typeof window === "undefined") return;
    if (provider) {
      window.localStorage.setItem(LINK_PROVIDER_KEY, provider);
    } else {
      window.localStorage.removeItem(LINK_PROVIDER_KEY);
    }
    setLinkProvider(provider);
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [refresh]);

  useEffect(() => {
    if (!stepUpExpiresAt) return undefined;

    const intervalId = window.setInterval(() => {
      const remaining = new Date(stepUpExpiresAt).getTime() - Date.now();
      const nextRemaining = Math.max(0, remaining);
      setStepUpRemainingMs(nextRemaining);
      if (nextRemaining <= 0) {
        setStepUpId(null);
        setStepUpExpiresAt(null);
        setStepUpRemainingMs(null);
      }
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [stepUpExpiresAt]);

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

  async function savePolicies() {
    const accessToken = await getApiToken();
    await putPolicies(accessToken, policies);
    await refresh();
  }

  async function doStepUp() {
    const accessToken = await getApiToken();
    const r = await startStepUp(accessToken);
    setStepUpId(r.stepUpId);
    setStepUpExpiresAt(r.expiresAt || null);
    if (r.expiresAt) {
      const remaining = new Date(r.expiresAt).getTime() - Date.now();
      setStepUpRemainingMs(Math.max(0, remaining));
    } else {
      setStepUpRemainingMs(null);
    }
    await refresh();
    return r.stepUpId as string;
  }

  async function approvePendingStep(requireStepUp: boolean) {
    if (!agentRunId) return;
    if (requireStepUp && !stepUpId) {
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
    if (!stepUpId) {
      setStepUpRemainingMs(null);
    }
  }

  async function linkSecondaryToPrimary(secondaryUserId: string, provider: string) {
    if (!primaryUserId) {
      throw new Error("Primary account is not stored. Log in with Google first.");
    }
    const accessToken = await getApiToken();
    return linkIdentity(accessToken, {
      primaryUserId,
      secondaryUserId,
      provider,
    });
  }

  function startLink(provider: "github" | "slack") {
    const connection = provider === "github" ? GITHUB_CONNECTION : SLACK_CONNECTION;
    setLinkError(null);
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
    const accessToken = await getApiToken();
    const result = await unlinkIdentity(accessToken, { provider, providerUserId });
    await refresh();
    return result;
  }

  const agentSteps = Array.isArray(agentRun?.steps) ? agentRun.steps : [];
  const agentTrace = Array.isArray(agentRun?.trace) ? agentRun.trace : [];
  const pendingApproval = agentSteps.find((step) => step.status === "APPROVAL_REQUIRED");
  const pendingApprovalStatus = pendingApproval?.result?.status || null;
  const stepUpRemainingText = useMemo(() => {
    if (stepUpRemainingMs === null) return "-";
    const totalSeconds = Math.floor(stepUpRemainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }, [stepUpRemainingMs]);

  useEffect(() => {
    if (!isAuthenticated || !linkProvider || !user?.sub || !primaryUserId) return;
    if (linking) return;
    if (user.sub === primaryUserId) return;

    let active = true;
    setLinking(true);
    setLinkError(null);

    (async () => {
      try {
        await linkSecondaryToPrimary(user.sub, linkProvider);
        storeLinkProvider(null);
        if (!active) return;
        await loginWithRedirect({
          authorizationParams: {
            redirect_uri: window.location.origin,
            audience: "https://control-center-api",
            connection: GOOGLE_CONNECTION,
            prompt: "login",
          },
        });
      } catch (err: any) {
        if (!active) return;
        setLinkError(err?.message || "Link failed.");
        storeLinkProvider(null);
      } finally {
        if (active) setLinking(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [
    isAuthenticated,
    linkProvider,
    user?.sub,
    primaryUserId,
    linking,
    loginWithRedirect,
  ]);

  useEffect(() => {
    if (!isAuthenticated || !primaryUserId || !user?.sub) return;
    if (linkProvider || linking) return;
    if (user.sub === primaryUserId) return;

    void loginWithRedirect({
      authorizationParams: {
        redirect_uri: window.location.origin,
        audience: "https://control-center-api",
        connection: GOOGLE_CONNECTION,
        prompt: "login",
      },
    });
  }, [
    isAuthenticated,
    primaryUserId,
    user?.sub,
    linkProvider,
    linking,
    loginWithRedirect,
  ]);

  if (loading) return <div className="app">Loading...</div>;

  const allowListSection = (
    <AllowListSection
      allowedReposText={allowedReposText}
      onChange={setAllowedReposText}
      onSave={saveAllowedRepos}
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

  const dashboard = (
    <Dashboard
      allowedReposCount={allowedReposText ? allowedReposText.split("\n").filter(Boolean).length : 0}
      policiesCount={policies.length}
      auditCount={audit.length}
      stepUpActive={Boolean(stepUpId)}
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
      pendingApprovalStatus={pendingApprovalStatus}
      approvalError={approvalError}
      onConfirm={() => approvePendingStep(false)}
      onApprove={() => approvePendingStep(true)}
      stepUpInfo={{
        active: Boolean(stepUpId),
        expiresAt: stepUpExpiresAt,
        remainingText: stepUpRemainingText,
      }}
      onStartStepUp={doStepUp}
    />
  );

  return (
    <div className="app shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="eyebrow">Secure Agentic Ops</div>
          <div className="brand-title">AI Agent Control Center</div>
        </div>
        <nav className="side-nav">
          <NavLink to="/">Home</NavLink>
          <NavLink to="/allow-list">Allow-list</NavLink>
          <NavLink to="/policies">Policies</NavLink>
          <NavLink to="/agent">Agent</NavLink>
          <NavLink to="/audit">Audit</NavLink>
        </nav>
      </aside>
      <div className="content">
        <header className="topbar">
          <div>
            <h1 className="title">Control Plane</h1>
            <div className="subtitle">Policy-gated tool execution with audit trails</div>
          </div>
          <div className="auth-row">
            {!isAuthenticated ? (
              <button
                type="button"
                onClick={() =>
                  loginWithRedirect({
                    authorizationParams: {
                      redirect_uri: window.location.origin,
                      audience: "https://control-center-api",
                    },
                  })
                }
              >
                Log in
              </button>
            ) : (
              <>
                <span>
                  Logged in as <b>{user?.email ?? user?.name ?? user?.sub}</b>
                </span>
                <button
                  type="button"
                  onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
                >
                  Log out
                </button>
              </>
            )}
          </div>
        </header>

        <main className="page">
          {!isAuthenticated ? (
            <div className="card">
              <h2>Welcome</h2>
              <p>Please log in to view and manage policies.</p>
            </div>
          ) : (
            <Routes>
              <Route path="/" element={dashboard} />
              <Route path="/allow-list" element={allowListSection} />
              <Route path="/policies" element={policiesSection} />
              <Route path="/agent" element={agentSection} />
              <Route path="/audit" element={auditSection} />
              <Route path="*" element={dashboard} />
            </Routes>
          )}
        </main>
      </div>
    </div>
  );
}
