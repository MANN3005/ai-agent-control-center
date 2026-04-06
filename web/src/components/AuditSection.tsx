import { AnimatePresence, m } from "framer-motion";
import {
  Check,
  ChevronDown,
  Filter,
  ScanSearch,
  Search,
  ShieldX,
  StopCircle,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { AuditEntry } from "../types";

type AuditSectionProps = {
  audit: AuditEntry[];
};

export default function AuditSection({ audit }: AuditSectionProps) {
  const [query, setQuery] = useState("");
  const [toolFilter, setToolFilter] = useState<string>("all");
  const [decisionFilter, setDecisionFilter] = useState<string>("all");
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [initialAuditIds] = useState<Set<string>>(
    () => new Set(audit.map((a) => a.id)),
  );

  const tools = useMemo(
    () => Array.from(new Set(audit.map((a) => a.toolName))).sort(),
    [audit],
  );

  const decisions = useMemo(
    () => Array.from(new Set(audit.map((a) => a.decision))).sort(),
    [audit],
  );

  const filteredAudit = useMemo(() => {
    const q = query.trim().toLowerCase();
    return audit.filter((a) => {
      if (toolFilter !== "all" && a.toolName !== toolFilter) return false;
      if (decisionFilter !== "all" && a.decision !== decisionFilter) return false;

      if (!q) return true;

      const text = [
        a.toolName,
        a.decision,
        a.reason ?? "",
        a.reasoning ?? "",
        a.requestId ?? "",
      ]
        .join(" ")
        .toLowerCase();

      return text.includes(q);
    });
  }, [audit, decisionFilter, query, toolFilter]);

  const totalExecutions = audit.length;
  const autoApprovedCount = audit.filter(
    (a) => a.decision === "ALLOWED" && a.executed,
  ).length;
  const autoApprovedPct = totalExecutions
    ? Math.round((autoApprovedCount / totalExecutions) * 100)
    : 0;
  const stepUpChallenges = audit.filter((a) =>
    String(a.decision).includes("STEP_UP") || String(a.decision).includes("CONFIRM"),
  ).length;
  const blockedEntries = audit.filter(
    (a) => String(a.decision).toUpperCase() !== "ALLOWED",
  );
  const blockedByTool = blockedEntries.reduce<Record<string, number>>((acc, entry) => {
    const key = entry.toolName || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const topBlockedTool = Object.entries(blockedByTool).sort((a, b) => b[1] - a[1])[0] ?? null;
  const latestEntry = [...audit].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0] ?? null;

  function decisionPill(entry: AuditEntry) {
    const decision = String(entry.decision || "").toUpperCase();
    if (decision === "ALLOWED" && entry.executed) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-lime-300/70 bg-lime-300 px-2.5 py-1 text-xs font-bold text-slate-900">
          <Check className="h-3.5 w-3.5" />
          ALLOWED
        </span>
      );
    }
    if (decision.includes("CONFIRM")) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/80 bg-amber-300 px-2.5 py-1 text-xs font-bold text-slate-900">
          <StopCircle className="h-3.5 w-3.5" />
          CONFIRM_REQUIRED
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-300/80 bg-rose-400 px-2.5 py-1 text-xs font-bold text-white">
        <ShieldX className="h-3.5 w-3.5" />
        {decision || "DENIED"}
      </span>
    );
  }

  function executedPill(executed: boolean) {
    return executed ? (
      <span className="inline-flex items-center gap-1 rounded-full border border-lime-300/70 bg-lime-300 px-2 py-1 text-xs font-bold text-slate-900">
        <Check className="h-3.5 w-3.5" />
        Completed
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-300/70 bg-rose-400 px-2 py-1 text-xs font-bold text-white">
        <ShieldX className="h-3.5 w-3.5" />
        Not executed
      </span>
    );
  }

  function formatDateParts(dateText: string) {
    const d = new Date(dateText);
    return {
      date: `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`,
      time: d.toLocaleTimeString(),
    };
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="rounded-[2.1rem] border border-white/15 bg-white/8 p-6 text-slate-200 backdrop-blur-xl md:p-7"
    >
      <h2 className="inline-flex items-center gap-2 text-3xl font-black tracking-[-0.03em] text-slate-100">
        <ScanSearch className="h-6 w-6 text-amber-300" />
        Activity Audit
      </h2>
      <p className="mt-2 text-sm text-slate-300">Latest policy decisions and execution outcomes.</p>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="glass-panel rounded-2xl border border-white/10 bg-black/25 p-3">
          <div className="text-xs uppercase tracking-[0.12em] text-slate-400">Total Executions</div>
          <div className="mt-1 text-2xl font-black text-slate-100">{totalExecutions.toLocaleString()}</div>
        </div>
        <div className="glass-panel rounded-2xl border border-white/10 bg-black/25 p-3">
          <div className="text-xs uppercase tracking-[0.12em] text-slate-400">Auto-Approved</div>
          <div className="mt-1 text-2xl font-black text-lime-300">{autoApprovedPct}%</div>
        </div>
        <div className="glass-panel rounded-2xl border border-white/10 bg-black/25 p-3">
          <div className="text-xs uppercase tracking-[0.12em] text-slate-400">Step-Up Challenges</div>
          <div className="mt-1 text-2xl font-black text-amber-300">{stepUpChallenges}</div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="glass-panel rounded-2xl border border-white/10 bg-black/25 p-3">
          <div className="text-xs uppercase tracking-[0.12em] text-slate-400">Most Blocked Tool</div>
          <div className="mt-1 text-base font-bold text-slate-100">
            {topBlockedTool ? topBlockedTool[0] : "No blocked actions"}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {topBlockedTool ? `${topBlockedTool[1]} blocked attempts` : "All recent actions were allowed."}
          </div>
        </div>
        <div className="glass-panel rounded-2xl border border-white/10 bg-black/25 p-3">
          <div className="text-xs uppercase tracking-[0.12em] text-slate-400">Latest Policy Outcome</div>
          <div className="mt-1 text-base font-bold text-slate-100">
            {latestEntry
              ? `${latestEntry.decision === "ALLOWED" ? "Passed" : "Blocked"} - ${latestEntry.toolName}`
              : "No recent policy evaluations"}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {latestEntry
              ? new Date(latestEntry.createdAt).toLocaleString()
              : "Run an action to populate audit telemetry."}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-3">
        <div className="grid gap-2 md:grid-cols-[1fr_auto_auto] md:items-center">
          <label className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
            <Search className="h-4 w-4 text-cyan-300" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search reason, tool, decision, request..."
              className="w-full bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
            />
          </label>

          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs">
            <Filter className="h-3.5 w-3.5 text-cyan-300" />
            Tool:
            <select
              value={toolFilter}
              onChange={(e) => setToolFilter(e.target.value)}
              className="bg-transparent text-slate-100 outline-none"
            >
              <option value="all">All</option>
              {tools.map((tool) => (
                <option key={tool} value={tool}>
                  {tool}
                </option>
              ))}
            </select>
          </div>

          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs">
            <Filter className="h-3.5 w-3.5 text-amber-300" />
            Decision:
            <select
              value={decisionFilter}
              onChange={(e) => setDecisionFilter(e.target.value)}
              className="bg-transparent text-slate-100 outline-none"
            >
              <option value="all">All</option>
              {decisions.map((decision) => (
                <option key={decision} value={decision}>
                  {decision}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-[1.6rem] border-2 border-black bg-black/35 shadow-[4px_4px_0px_rgba(0,0,0,0.9)]">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="bg-black/40 text-xs uppercase tracking-[0.16em] text-slate-400">
              <th className="px-3 py-3">Time</th>
              <th className="px-3 py-3">Tool</th>
              <th className="px-3 py-3">Decision</th>
              <th className="px-3 py-3">Executed</th>
              <th className="px-3 py-3">Policy</th>
              <th className="px-3 py-3">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 text-slate-200">
            {filteredAudit.map((a) => {
              const isExpanded = expandedRowId === a.id;
              const ts = formatDateParts(a.createdAt);
              const isNew = !initialAuditIds.has(a.id);
              return (
                <Fragment key={a.id}>
                  <m.tr
                    layout
                    onClick={() => setExpandedRowId(isExpanded ? null : a.id)}
                    className={`row-glow-track cursor-pointer transition hover:bg-white/5 ${
                      isNew ? "audit-row-new" : ""
                    }`}
                  >
                    <td className="px-3 py-3 font-mono text-xs">
                      <div className="text-slate-500">{ts.date}</div>
                      <div className="font-semibold text-slate-200">{ts.time}</div>
                    </td>
                    <td className="px-3 py-3">
                      <span className="rounded-lg border border-white/15 bg-slate-800/70 px-2 py-1 font-mono text-xs text-slate-100">
                        {a.toolName}
                      </span>
                    </td>
                    <td className="px-3 py-3">{decisionPill(a)}</td>
                    <td className="px-3 py-3">{executedPill(a.executed)}</td>
                    <td className="px-3 py-3">
                      <div className="text-sm font-semibold text-slate-100">
                        Policy: {a.decision === "ALLOWED" ? "Passed" : "Blocked"}
                      </div>
                      <div className="text-sm font-semibold text-slate-100">{a.reason || "No gate reason"}</div>
                      {a.reasoning ? (
                        <div className="mt-0.5 text-xs text-slate-400">{a.reasoning}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      <span className="inline-flex items-center gap-1 text-xs text-cyan-300">
                        View details
                        <ChevronDown className={`h-3.5 w-3.5 transition ${isExpanded ? "rotate-180" : ""}`} />
                      </span>
                    </td>
                  </m.tr>
                  <AnimatePresence>
                    {isExpanded ? (
                      <m.tr
                        key={`${a.id}-expanded`}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="bg-slate-950/60"
                      >
                        <td colSpan={6} className="p-0">
                          <div className="grid gap-3 p-3 md:grid-cols-2">
                            <div className="rounded-xl border border-white/10 bg-black/35 p-3">
                              <div className="mb-1 text-xs uppercase tracking-[0.12em] text-slate-400">Input JSON</div>
                              <pre className="max-h-64 overflow-auto text-xs text-slate-200">
                                {JSON.stringify(a.inputJson ?? {}, null, 2)}
                              </pre>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-black/35 p-3">
                              <div className="mb-1 text-xs uppercase tracking-[0.12em] text-slate-400">Result JSON</div>
                              <pre className="max-h-64 overflow-auto text-xs text-slate-200">
                                {JSON.stringify(a.resultJson ?? {}, null, 2)}
                              </pre>
                            </div>
                          </div>
                        </td>
                      </m.tr>
                    ) : null}
                  </AnimatePresence>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </m.div>
  );
}
