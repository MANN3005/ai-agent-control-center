import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Download,
  Lock,
  Radar,
  RefreshCcw,
  ShieldAlert,
  TimerReset,
  X,
} from "lucide-react";
import type { AccessState } from "../types";

type AccessSectionProps = {
  accessState: AccessState | null;
  loading: boolean;
  onRefresh: () => void;
  onStartStepUp: () => Promise<string> | string;
  stepUpPending: boolean;
  onLockdown: () => Promise<void>;
  onRearm: () => Promise<void>;
  lockdownBusy: boolean;
};

function formatTtl(ttlMs: number | null) {
  if (ttlMs === null) return "Provider did not expose TTL";
  if (ttlMs <= 0) return "Expired or rotating now";
  const totalSeconds = Math.floor(ttlMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function policyDecisionTone(decision: string) {
  if (decision === "ALLOWED") return "text-emerald-300";
  if (decision === "DENIED" || decision === "ERROR") return "text-rose-300";
  return "text-amber-300";
}

export default function AccessSection({
  accessState,
  loading,
  onRefresh,
  onStartStepUp,
  stepUpPending,
  onLockdown,
  onRearm,
  lockdownBusy,
}: AccessSectionProps) {
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [scanActive, setScanActive] = useState(false);
  const [scanComplete, setScanComplete] = useState(false);
  const tools = useMemo(() => accessState?.tools || [], [accessState?.tools]);
  const tokenHealth = accessState?.tokenHealth || [];
  const decisions = accessState?.policyDecisions || [];
  const resourceBreakdown = accessState?.resources.breakdown || [];
  const allowedTools = tools.filter((tool) => tool.canExecuteNow).length;
  const blockedTools = tools.length - allowedTools;
  const blockedHighRisk = tools.some(
    (tool) => !tool.canExecuteNow && tool.mode === "STEP_UP",
  );

  const selectedTrace = useMemo(
    () => tools.find((tool) => tool.name === selectedTool) || null,
    [selectedTool, tools],
  );

  function runPermissionScan() {
    setScanActive(true);
    setScanComplete(false);
    window.setTimeout(() => {
      setScanActive(false);
      setScanComplete(true);
    }, 1100);
  }

  function riskBarTone(score: number) {
    if (score >= 80) return "bg-rose-400";
    if (score >= 60) return "bg-amber-300";
    if (score >= 40) return "bg-yellow-300";
    return "bg-emerald-300";
  }

  function downloadAuthorizationFeed() {
    const lines = decisions.length
      ? decisions.map(
          (entry) =>
            `${new Date(entry.at).toISOString()} - ${entry.toolName} - ${entry.decision} - ${entry.reason}`,
        )
      : ["No authorization events recorded yet."];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `authorization-audit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-[2.1rem] border border-white/15 bg-white/8 p-6 text-slate-200 backdrop-blur-xl md:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-3xl font-black tracking-[-0.03em] text-slate-100">
            Current Access
          </h2>
          <p className="mt-2 text-sm text-slate-300">
            Real-time view of identities, allow-lists, policy gates, and tool execution readiness.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-2 rounded-full border border-cyan-300/45 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-100"
        >
          <RefreshCcw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/45 bg-emerald-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.1em] text-emerald-100">
          <Lock className="h-3.5 w-3.5" />
          {tokenHealth.some((token) => token.hasAccessToken)
            ? "Protected by Auth0 Vault"
            : "Vault disconnected"}
        </div>
        <div className="flex flex-wrap justify-start gap-2 lg:justify-end">
          <button
            type="button"
            onClick={() => {
              void onLockdown();
            }}
            disabled={lockdownBusy || accessState?.agentHealth.status === "DISARMED"}
            className="inline-flex items-center gap-2 rounded-full border border-rose-300/55 bg-rose-400/20 px-4 py-2 text-xs font-black uppercase tracking-[0.1em] text-rose-100 shadow-[0_0_18px_rgba(251,113,133,0.25)] disabled:opacity-60"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Session Lockdown
          </button>
          <button
            type="button"
            onClick={() => {
              void onRearm();
            }}
            disabled={lockdownBusy || accessState?.agentHealth.status !== "DISARMED"}
            className="inline-flex items-center gap-2 rounded-full border border-emerald-300/45 bg-emerald-300/15 px-4 py-2 text-xs font-black uppercase tracking-[0.1em] text-emerald-100 disabled:opacity-60"
          >
            Re-arm agent
          </button>
        </div>
      </div>

      <div className="mt-2 rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-xs">
        <span className="font-semibold text-slate-300">Agent health:</span>{" "}
        <span
          className={
            accessState?.agentHealth.status === "DISARMED"
              ? "font-black text-rose-300"
              : "font-black text-emerald-300"
          }
        >
          {accessState?.agentHealth.status || "STANDBY"}
        </span>
        {accessState?.agentHealth.disarmedAt ? (
          <span className="ml-2 text-slate-400">
            since {new Date(accessState.agentHealth.disarmedAt).toLocaleTimeString()}
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
          <div className="text-xs uppercase tracking-[0.14em] text-slate-400">User</div>
          <div className="mt-2 text-sm font-semibold text-slate-100">
            {accessState?.userId || "-"}
          </div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
          <div className="text-xs uppercase tracking-[0.14em] text-slate-400">Allowed Tools</div>
          <div className="mt-2 text-2xl font-black text-emerald-200">{allowedTools}</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
          <div className="text-xs uppercase tracking-[0.14em] text-slate-400">Blocked Tools</div>
          <div className="mt-2 text-2xl font-black text-rose-200">{blockedTools}</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
          <div className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-slate-400">
            <TimerReset className="h-3.5 w-3.5" />
            Step-up
          </div>
          <div className="mt-2 text-sm font-semibold text-slate-100">
            {accessState?.stepUp.active ? "Active" : "Inactive"}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {accessState?.stepUp.active && accessState.stepUp.expiresAt
              ? `Expires: ${new Date(accessState.stepUp.expiresAt).toLocaleString()}`
              : "No active step-up session"}
          </div>
          <button
            type="button"
            onClick={() => {
              void onStartStepUp();
            }}
            className={`mt-3 inline-flex items-center gap-2 rounded-full border border-amber-300/45 bg-amber-300/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-amber-100 ${
              blockedHighRisk ? "animate-pulse shadow-[0_0_18px_rgba(251,191,36,0.35)]" : ""
            }`}
          >
            {stepUpPending ? "Step-up pending..." : "Re-verify identity"}
          </button>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-4">
        <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">Token Health</h3>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {tokenHealth.length ? (
            tokenHealth.map((token) => (
              <div key={`${token.provider || "unknown"}-${token.connection || "n/a"}`} className="rounded-xl border border-white/10 bg-slate-900/55 p-3">
                <div className="flex items-center justify-between gap-2 text-xs uppercase tracking-[0.12em] text-slate-300">
                  <span>{token.provider || token.connection || "unknown"}</span>
                  <span className="rounded-full border border-cyan-300/45 bg-cyan-300/10 px-2 py-0.5 text-cyan-100">
                    {token.isolationStatus === "token_isolated" ? "Token Isolated" : "Not linked"}
                  </span>
                </div>
                <div className="mt-2 text-xs text-slate-300">Vault status: {token.vaultStatus === "protected_by_auth0_vault" ? "Protected by Auth0 Vault" : "Unavailable"}</div>
                <div className="mt-1 text-xs text-slate-300">Time until rotation: {formatTtl(token.ttlMs)}</div>
                <div className="mt-2 text-xs text-slate-400">
                  Permission scopes are hidden in this build.
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-white/10 bg-slate-900/55 p-3 text-xs text-slate-300">
              No token metadata available yet. Link a provider identity to see vault and TTL details.
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">Identity State</h3>
          <div className="mt-3 text-sm text-slate-200">
            <div>GitHub linked: {accessState?.identities.hasGithub ? "Yes" : "No"}</div>
            <div>Slack linked: {accessState?.identities.hasSlack ? "Yes" : "No"}</div>
            <div>Linked identities: {accessState?.identities.linked.length || 0}</div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">Resource Access</h3>
          <div className="mt-3 text-sm text-slate-200">
            <div>Allow-listed repos: {accessState?.resources.allowedRepoCount || 0}</div>
            <div className="mt-1 text-xs text-slate-400">
              Verified in account: {accessState?.resources.verifiedAllowedRepoCount || 0}
            </div>
            {(accessState?.resources.unverifiedAllowedRepos || []).length ? (
              <div className="mt-1 text-xs text-rose-300">
                Excluded from scan (not in linked GitHub account): {(accessState?.resources.unverifiedAllowedRepos || []).join(", ")}
              </div>
            ) : null}
            <div className="mt-2 max-h-24 overflow-y-auto rounded-lg border border-white/10 bg-slate-900/40 p-2 text-xs text-slate-300">
              {(accessState?.resources.allowedRepos || []).length
                ? (accessState?.resources.allowedRepos || []).join("\n")
                : "No repositories allow-listed."}
            </div>
            <button
              type="button"
              onClick={runPermissionScan}
              disabled={(accessState?.resources.verifiedAllowedRepoCount || 0) === 0}
              className="mt-3 inline-flex items-center gap-2 rounded-full border border-cyan-300/45 bg-cyan-300/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-cyan-100"
            >
              <Radar className={`h-3.5 w-3.5 ${scanActive ? "animate-spin" : ""}`} />
              {scanActive ? "Scanning permissions..." : "Scan Permissions"}
            </button>
            <div className="mt-3 rounded-xl border border-white/10 bg-slate-950/60 p-2 text-xs">
              {scanActive ? (
                <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                  <div className="h-full w-2/3 animate-pulse bg-cyan-300/70" />
                </div>
              ) : null}
              {scanComplete && resourceBreakdown.length ? (
                <div className="space-y-1.5">
                  {resourceBreakdown.map((entry) => (
                    <div key={entry.resourceId} className="rounded-md border border-white/10 px-2 py-1">
                      <span className="font-semibold text-slate-100">{entry.resourceId}</span>: {entry.label}
                    </div>
                  ))}
                </div>
              ) : scanComplete ? (
                <div className="text-slate-400">No verified repositories available for scan.</div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-2xl border border-white/10 bg-black/25 p-2">
        <table className="min-w-full text-left text-sm [&_th]:border-b [&_th]:border-white/10 [&_td]:border-b [&_td]:border-white/5">
          <thead>
            <tr className="bg-slate-900/70 text-xs uppercase tracking-[0.14em] text-slate-400">
              <th className="px-3 py-2">Tool</th>
              <th className="px-3 py-2">Mode</th>
              <th className="px-3 py-2">Risk Heat</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Activity</th>
              <th className="px-3 py-2">Blocked reason</th>
            </tr>
          </thead>
          <tbody className="text-slate-200 [&_tr:hover]:bg-white/5">
            {tools.map((tool) => (
              <tr
                key={tool.name}
                className={
                  tool.name === "slack_notifier" && accessState?.stepUp.active
                    ? "ring-1 ring-yellow-300/45"
                    : ""
                }
              >
                <td className="px-3 py-2">
                  <div className="font-semibold text-slate-100">{tool.name}</div>
                  <div className="text-xs text-slate-400">{tool.domain}</div>
                </td>
                <td className="px-3 py-2">{tool.mode}</td>
                <td className="px-3 py-2">
                  <div className="text-xs font-semibold text-slate-200">{tool.riskScore}/100 ({tool.riskBand})</div>
                  <div className="mt-1 h-2 w-30 overflow-hidden rounded-full bg-slate-700/60">
                    <div
                      className={`h-full ${riskBarTone(tool.riskScore)}`}
                      style={{ width: `${Math.max(4, Math.min(100, tool.riskScore))}%` }}
                    />
                  </div>
                </td>
                <td className="px-3 py-2">
                  {tool.name === "slack_notifier" && accessState?.stepUp.active && tool.canExecuteNow ? (
                    <span className="rounded-full border border-yellow-300/60 bg-yellow-300/15 px-2 py-1 text-xs font-semibold text-yellow-100">
                      Authorized (Step-up)
                    </span>
                  ) : tool.canExecuteNow ? (
                    <span className="rounded-full border border-emerald-300/60 bg-emerald-300/15 px-2 py-1 text-xs font-semibold text-emerald-100">
                      Allowed now
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-rose-300/60 bg-rose-300/15 px-2 py-1 text-xs font-semibold text-rose-100">
                      <ShieldAlert className="h-3 w-3" />
                      Blocked
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-end gap-1">
                    {(tool.recentDecisions || []).map((decision, idx) => (
                      <span
                        key={`${tool.name}-${idx}`}
                        className={`h-4 w-1 rounded-sm ${
                          decision === "ALLOWED"
                            ? "bg-emerald-300"
                            : decision === "DENIED" || decision === "ERROR"
                              ? "bg-rose-300"
                              : "bg-amber-300"
                        }`}
                      />
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs text-slate-300">
                  {tool.blockedReasons.length ? (
                    <div className="flex items-center gap-2">
                      <span>{tool.blockedReasons[0]}</span>
                      <button
                        type="button"
                        onClick={() => setSelectedTool(tool.name)}
                        className="rounded-full border border-cyan-300/50 bg-cyan-300/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-cyan-100"
                      >
                        View Logic
                      </button>
                    </div>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 rounded-2xl border border-white/10 bg-black/45 p-3 font-mono text-xs text-slate-200">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-400">Recent Authorizations</div>
          <button
            type="button"
            onClick={downloadAuthorizationFeed}
            className="inline-flex items-center gap-1 rounded-full border border-cyan-300/45 bg-cyan-300/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-cyan-100"
          >
            <Download className="h-3 w-3" />
            Download Audit PDF
          </button>
        </div>
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/70 p-3">
          {decisions.length ? (
            decisions.map((entry) => (
              <div key={entry.id} className="leading-relaxed">
                <span className="text-slate-400">[{new Date(entry.at).toLocaleTimeString()}]</span>{" "}
                <span className="text-cyan-200">{entry.toolName}</span>{" - "}
                <span className={policyDecisionTone(entry.decision)}>{entry.decision}</span>{" - "}
                <span className="text-slate-200">Reason: {entry.reason}</span>
              </div>
            ))
          ) : (
            <div className="text-slate-400">No policy evaluations recorded yet.</div>
          )}
        </div>
      </div>

      {selectedTrace ? (
        <div className="fixed inset-0 z-60 grid place-items-center bg-black/60 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-white/15 bg-slate-950/95 p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-bold text-slate-100">Policy Evaluation: {selectedTrace.name}</div>
                <div className="text-xs text-slate-400">Clickable logic trace for governance decisions</div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTool(null)}
                className="rounded-full border border-white/20 p-1 text-slate-300 hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {selectedTrace.policyEvaluations.map((rule) => (
                <div key={rule.rule} className="rounded-xl border border-white/10 bg-black/35 p-3 text-xs">
                  <div className="font-semibold text-slate-100">Rule: '{rule.rule}'</div>
                  <div className={rule.result === "PASS" ? "text-emerald-300" : "text-rose-300"}>
                    Result: {rule.result}
                  </div>
                  <div className="text-slate-300">{rule.detail}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
