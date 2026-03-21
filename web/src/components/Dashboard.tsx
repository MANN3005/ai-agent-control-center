import { AnimatePresence, LayoutGroup, m } from "framer-motion";
import { useMemo, useState } from "react";
import {
  Activity,
  EllipsisVertical,
  Link2,
  Orbit,
  ShieldCheck,
  Shield,
  Boxes,
  FileCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { IdentityEntry } from "../types";

const DASHBOARD_OVERVIEW_DISMISSED_KEY = "cc_dashboard_overview_dismissed";

type DashboardProps = {
  allowedReposCount: number;
  policiesCount: number;
  auditCount: number;
  stepUpActive: boolean;
  identities: IdentityEntry[];
  userId?: string | null;
  primaryUserId?: string | null;
  onUnlinkIdentity: (
    provider: string,
    providerUserId: string,
  ) => Promise<unknown>;
  onStartLink: (provider: "github" | "slack") => void;
  linkError?: string | null;
  linking?: boolean;
};

export default function Dashboard({
  allowedReposCount,
  policiesCount,
  auditCount,
  stepUpActive,
  identities,
  userId,
  primaryUserId,
  onUnlinkIdentity,
  onStartLink,
  linkError,
  linking,
}: DashboardProps) {
  const [unlinkBusyKey, setUnlinkBusyKey] = useState<string | null>(null);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const [focusedIdentity, setFocusedIdentity] = useState<IdentityEntry | null>(null);
  const [focusedIdentityKey, setFocusedIdentityKey] = useState<string | null>(null);
  const [showOverview, setShowOverview] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(DASHBOARD_OVERVIEW_DISMISSED_KEY) !== "1";
  });

  function dismissOverview() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DASHBOARD_OVERVIEW_DISMISSED_KEY, "1");
    }
    setShowOverview(false);
  }

  async function handleUnlink(
    provider: string | null,
    providerUserId: string | null,
  ) {
    if (!provider || !providerUserId) return;
    const key = `${provider}:${providerUserId}`;
    setUnlinkBusyKey(key);
    setUnlinkError(null);
    try {
      await onUnlinkIdentity(provider, String(providerUserId));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unlink failed.";
      setUnlinkError(message);
    } finally {
      setUnlinkBusyKey(null);
    }
  }

  const stats = [
    { label: "Allowed Repos", value: allowedReposCount, icon: Boxes },
    { label: "Policies", value: policiesCount, icon: Shield },
    { label: "Audit Entries", value: auditCount, icon: FileCheck },
    { label: "Step-up Active", value: stepUpActive ? "Yes" : "No", icon: Sparkles },
  ];

  const isPrimaryUser = Boolean(
    primaryUserId && userId && primaryUserId === userId,
  );
  const canManageLinks = Boolean(primaryUserId && isPrimaryUser);
  const canShowUnlink = (provider: string | null, connection: string | null) => {
    if (connection && ["github", "sign-in-with-slack"].includes(connection)) {
      return true;
    }
    return Boolean(
      provider &&
        ["github", "slack", "sign-in-with-slack", "oauth2"].includes(provider),
    );
  };

  const resolveIdentityLabel = (identity: IdentityEntry) => {
    const provider = (identity.provider ?? "").toLowerCase();
    const connection = (identity.connection ?? "").toLowerCase();
    if (provider.includes("github") || connection.includes("github")) {
      return "GitHub";
    }
    if (provider.includes("slack") || connection.includes("slack")) {
      return "Slack";
    }
    if (provider.includes("google") || connection.includes("google")) {
      return "Google";
    }
    if (provider === "oauth2" && connection.includes("sign-in-with-slack")) {
      return "Slack";
    }
    if (provider === "oauth2") {
      return "OAuth2";
    }
    return identity.provider ?? identity.connection ?? "Unknown";
  };

  const githubLinked = identities.some(
    (identity) => resolveIdentityLabel(identity) === "GitHub",
  );
  const slackLinked = identities.some(
    (identity) => resolveIdentityLabel(identity) === "Slack",
  );

  const heartbeatLabel = stepUpActive ? "AGENT: PROCESSING" : "AGENT: STANDBY";

  const identityNodes = useMemo(
    () =>
      identities.map((identity, idx) => {
        const angle = (idx / Math.max(identities.length, 1)) * Math.PI * 2;
        return {
          identity,
          x: 50 + Math.cos(angle) * 34,
          y: 50 + Math.sin(angle) * 30,
        };
      }),
    [identities],
  );

  const thoughtLines = [
    "Parsing user intent and repo context",
    "Computing safe action plan under policy gates",
    "Preparing approval packet for high-risk operations",
    "Streaming execution trace with deterministic checkpoints",
  ];

  return (
    <LayoutGroup>
      <div className="grid gap-5 lg:grid-cols-3">
        <AnimatePresence>
          {showOverview ? (
            <m.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="glass-panel relative overflow-hidden rounded-3xl border border-cyan-300/30 bg-[#10202c]/80 p-5 backdrop-blur-xl lg:col-span-3"
            >
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_10%_10%,rgba(64,224,255,0.18),transparent_42%),radial-gradient(circle_at_90%_80%,rgba(255,184,0,0.14),transparent_46%)]" />
              <button
                type="button"
                onClick={dismissOverview}
                className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/5 text-slate-300 transition hover:bg-white/10 hover:text-white"
                aria-label="Dismiss system overview"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="relative pr-10">
                <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/45 bg-cyan-300/12 px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-cyan-100">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  System Overview
                </div>
                <h3 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-white md:text-3xl">
                  Your AI Safety Layer.
                </h3>
                <p className="mt-2 max-w-5xl text-sm leading-6 text-slate-200/95">
                  FlowSnap bridges your GitHub and Slack identities via Auth0. It enforces
                  the security policies you set below, ensuring your AI Agent only accesses
                  approved data and asks for permission (Step-Up) during high-risk actions.
                </p>
              </div>
            </m.section>
          ) : null}
        </AnimatePresence>

        <m.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="glass-panel relative overflow-hidden rounded-4xl border border-cyan-200/20 bg-[#151A21]/80 p-6 backdrop-blur-xl lg:col-span-2"
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(64,224,255,0.16),transparent_48%),radial-gradient(circle_at_85%_80%,rgba(255,184,0,0.12),transparent_40%)]" />
          <div className="relative">
            <div className="absolute right-0 top-0 inline-flex items-center gap-2 rounded-full border border-cyan-300/40 bg-cyan-400/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-cyan-200">
              <span className="heartbeat-dot h-2 w-2 rounded-full bg-cyan-300" />
              {heartbeatLabel}
            </div>
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/40 bg-cyan-400/10 px-3 py-1 text-xs uppercase tracking-[0.16em] text-cyan-100">
              <Orbit className="h-3.5 w-3.5" />
              Command Surface
            </div>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-white md:text-4xl">
              Control Plane, Live and Explainable
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-300">
              This bento command deck keeps policy posture, execution context, and
              identity trust graph visible in one glance.
            </p>

            <div className="glass-panel mt-6 rounded-[1.4rem] border border-white/10 bg-black/35 p-4 font-mono text-sm text-cyan-100">
              <div className="mb-3 text-xs uppercase tracking-[0.15em] text-cyan-300/80">
                Agent thought stream
              </div>
              <div className="grid gap-2">
                {thoughtLines.map((line, idx) => (
                  <m.div
                    key={line}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.12 }}
                    className="flex items-center gap-2"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
                    <span>{line}</span>
                    {idx === thoughtLines.length - 1 ? (
                      <span className="h-4 w-2 animate-pulse rounded-sm bg-cyan-300/70" />
                    ) : null}
                  </m.div>
                ))}
              </div>
            </div>
          </div>
        </m.section>

        <div className="grid gap-5">
          {stats.map((stat, idx) => (
            <m.div
              key={stat.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05, type: "spring", stiffness: 300, damping: 30 }}
              className="glass-panel rounded-3xl border border-white/10 bg-[#151A21]/75 p-3.5 backdrop-blur-xl"
            >
              <div className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-slate-400">
                <span>{stat.label}</span>
                <stat.icon className="h-3.5 w-3.5 text-cyan-300" />
              </div>
              <div className="mt-1.5 text-xl font-semibold text-white">{stat.value}</div>
            </m.div>
          ))}
        </div>

        <m.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30, delay: 0.05 }}
          className="glass-panel relative rounded-4xl border border-white/12 bg-[#151A21]/80 p-6 backdrop-blur-xl lg:col-span-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="inline-flex items-center gap-2 text-2xl font-semibold text-white">
                <Link2 className="h-5 w-5 text-cyan-300" />
                Identity Linkage Graph
              </h3>
              <p className="mt-1 text-sm text-slate-300">
                Liquid-glass trust mesh anchored to your primary profile.
              </p>
            </div>
            {canManageLinks ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onStartLink("github")}
                  disabled={Boolean(linking) || githubLinked}
                  className="rounded-full border border-cyan-300/60 bg-cyan-300/20 px-4 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-300/30 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {githubLinked ? "GitHub Linked" : linking ? "Linking..." : "Link GitHub"}
                </button>
                <button
                  type="button"
                  onClick={() => onStartLink("slack")}
                  disabled={Boolean(linking) || slackLinked}
                  className="rounded-full border border-amber-300/60 bg-amber-300/15 px-4 py-2 text-sm font-semibold text-amber-100 transition hover:bg-amber-300/25 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {slackLinked ? "Slack Linked" : linking ? "Linking..." : "Link Slack"}
                </button>
              </div>
            ) : null}
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="glass-panel relative h-88 overflow-hidden rounded-3xl border border-white/10 bg-black/30">
              <div className="absolute left-1/2 top-1/2 z-10 flex h-26 w-26 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border border-cyan-200/70 bg-cyan-300/20 text-center text-xs font-semibold tracking-[0.08em] text-cyan-50 shadow-[0_0_32px_rgba(64,224,255,0.45)] backdrop-blur-xl">
                <span className="text-[10px] uppercase tracking-[0.12em] text-cyan-100/85">Auth0</span>
                <span>Token Vault</span>
              </div>
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 h-full w-full"
                aria-hidden="true"
              >
                {identityNodes.map((node, idx) => (
                  <g key={`line-${idx}`}>
                    <line
                      x1="50"
                      y1="50"
                      x2={node.x}
                      y2={node.y}
                      className="graph-line"
                      style={{ animationDelay: `${-idx * 0.22}s` }}
                      stroke="rgba(64,224,255,0.32)"
                      strokeWidth="0.38"
                      strokeLinecap="round"
                    />
                    <line
                      x1="50"
                      y1="50"
                      x2={node.x}
                      y2={node.y}
                      className="graph-line-packets"
                      style={{ animationDelay: `${-idx * 0.38}s` }}
                      stroke="rgba(64,224,255,0.9)"
                      strokeWidth="0.42"
                      strokeLinecap="round"
                    />
                  </g>
                ))}
              </svg>
              {identityNodes.map((node, idx) => {
                const providerLabel = resolveIdentityLabel(node.identity);
                const key = `${providerLabel}-${idx}`;
                const posStyle = { left: `${node.x}%`, top: `${node.y}%` };
                const isActiveConnection = Boolean(node.identity.hasAccessToken);

                return (
                  <div
                    key={key}
                    className="group absolute z-20 -translate-x-1/2 -translate-y-1/2"
                    style={posStyle}
                  >
                    <m.button
                      layoutId={`identity-${key}`}
                      type="button"
                      onClick={() => {
                        setFocusedIdentity(node.identity);
                        setFocusedIdentityKey(key);
                      }}
                      whileHover={{ scale: 1.06 }}
                      className={`relative flex h-18 w-18 cursor-pointer flex-col items-center justify-center rounded-full border border-white/20 bg-white/10 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-100 backdrop-blur-xl transition-transform duration-200 hover:scale-105 ${
                        isActiveConnection ? "orb-active" : ""
                      }`}
                    >
                      {isActiveConnection ? (
                        <span className="absolute right-1.5 top-1.5 inline-flex h-4.5 w-4.5 items-center justify-center rounded-full border border-cyan-300/50 bg-cyan-300/20 text-cyan-100">
                          <EllipsisVertical className="h-2.5 w-2.5" />
                        </span>
                      ) : null}
                      <span>{providerLabel}</span>
                      <span className="text-[10px] text-slate-300">
                        {isActiveConnection ? "active" : "missing"}
                      </span>
                    </m.button>

                    {isActiveConnection ? (
                      <div className="pointer-events-none absolute left-1/2 top-[calc(100%+0.45rem)] z-30 w-52 -translate-x-1/2 rounded-xl border border-cyan-300/35 bg-[#0f1724]/95 px-3 py-2 text-center text-[11px] font-medium leading-4 text-cyan-100 opacity-0 shadow-[0_0_20px_rgba(64,224,255,0.24)] transition-opacity duration-180 group-hover:opacity-100">
                        Active Connection: Click to manage or unlink
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="glass-panel space-y-3 rounded-3xl border border-white/10 bg-black/30 p-4">
              <div className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-slate-400">
                <ShieldCheck className="h-4 w-4 text-lime-300" />
                Trust Posture
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200">
                Primary ID: {primaryUserId ?? "Not stored yet"}
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200">
                Linked identities: {identities.length}
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200">
                Token coverage: {identities.filter((i) => i.hasAccessToken).length}/{identities.length || 1}
              </div>
              {!canManageLinks ? (
                <div className="rounded-xl border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
                  Log in with your primary account session to manage links.
                </div>
              ) : null}
            </div>
          </div>

          {unlinkError ? <div className="mt-3 text-sm text-rose-300">{unlinkError}</div> : null}
          {linkError ? <div className="mt-3 text-sm text-rose-300">{linkError}</div> : null}
        </m.section>

        <AnimatePresence>
          {focusedIdentity ? (
            <m.div
              className="fixed inset-0 z-40 flex items-center justify-center bg-black/65 p-4 backdrop-blur"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setFocusedIdentity(null);
                setFocusedIdentityKey(null);
              }}
            >
              <m.div
                layoutId={focusedIdentityKey ? `identity-${focusedIdentityKey}` : undefined}
                className="w-full max-w-lg rounded-[1.8rem] border border-white/20 bg-[#151A21]/95 p-6 text-slate-200"
                initial={{ scale: 0.96 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0.97 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-xs uppercase tracking-[0.14em] text-slate-400">Manage Permissions</div>
                <h4 className="mt-2 text-2xl font-semibold text-white">
                  {resolveIdentityLabel(focusedIdentity)}
                </h4>
                <div className="mt-4 grid gap-2 text-sm">
                  <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                    Connection: {focusedIdentity.connection ?? "-"}
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                    User ID: {focusedIdentity.userId ?? "-"}
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                    Token: {focusedIdentity.hasAccessToken ? "Active" : "Missing"}
                  </div>
                </div>
                {canManageLinks &&
                canShowUnlink(focusedIdentity.provider, focusedIdentity.connection) &&
                focusedIdentity.userId ? (
                  <button
                    type="button"
                    onClick={() =>
                      handleUnlink(focusedIdentity.provider, focusedIdentity.userId)
                    }
                    disabled={
                      unlinkBusyKey ===
                      `${focusedIdentity.provider}:${focusedIdentity.userId}`
                    }
                    className="mt-4 rounded-full border border-rose-300/60 bg-rose-400/15 px-5 py-2 text-sm font-semibold text-rose-100 transition hover:bg-rose-400/25 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {unlinkBusyKey === `${focusedIdentity.provider}:${focusedIdentity.userId}`
                      ? "Unlinking..."
                      : "Unlink identity"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setFocusedIdentity(null);
                    setFocusedIdentityKey(null);
                  }}
                  className="mt-3 block rounded-full border border-white/20 px-5 py-2 text-sm font-semibold text-slate-200"
                >
                  Close
                </button>
              </m.div>
            </m.div>
          ) : null}
        </AnimatePresence>

        <div className="rounded-3xl border border-white/12 bg-[#151A21]/70 p-4 text-sm text-slate-400 lg:col-span-3">
          <div className="inline-flex items-center gap-2 text-slate-300">
            <Activity className="h-4 w-4 text-cyan-300" />
            Linking redirects to provider sign-in and returns to your primary session.
          </div>
        </div>
      </div>
    </LayoutGroup>
  );
}
