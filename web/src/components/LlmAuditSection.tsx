import { useMemo, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { BrainCircuit, ChevronDown, Clock3, Search } from "lucide-react";
import type { LlmAuditEntry } from "../types";

type LlmAuditSectionProps = {
  entries: LlmAuditEntry[];
};

function pretty(value: Record<string, unknown>) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hash(text: string) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h << 5) - h + text.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function buildSparklineSeries(
  entries: LlmAuditEntry[],
  predicate: (entry: LlmAuditEntry) => boolean,
) {
  const buckets = new Array(6).fill(0);
  if (!entries.length) return buckets;

  const timestamps = entries.map((entry) => new Date(entry.createdAt).getTime());
  const endTs = Math.max(...timestamps);
  const startTs = endTs - 30 * 60 * 1000;
  const bucketMs = 5 * 60 * 1000;

  entries.forEach((entry) => {
    if (!predicate(entry)) return;
    const ts = new Date(entry.createdAt).getTime();
    if (ts < startTs || ts > endTs) return;
    const idx = Math.min(5, Math.floor((ts - startTs) / bucketMs));
    buckets[idx] += 1;
  });

  return buckets;
}

function sparklinePath(series: number[]) {
  const width = 110;
  const height = 36;
  const max = Math.max(...series, 1);
  return series
    .map((value, idx) => {
      const x = (idx / Math.max(series.length - 1, 1)) * width;
      const y = height - (value / max) * (height - 6) - 3;
      return `${idx === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function semanticClass(text: string) {
  const normalized = text.toLowerCase().trim();
  if (normalized.includes("verdict: blocked") || normalized.includes("step-up")) {
    return "text-rose-300";
  }
  if (normalized.startsWith("asked for missing input")) {
    return "text-amber-300";
  }
  if (normalized.includes("successfully listed")) {
    return "text-cyan-300";
  }
  return "text-slate-200";
}

function modelClass(model: string) {
  const m = model.toLowerCase();
  if (m.includes("gpt")) return "border-emerald-300/40 text-emerald-100";
  if (m.includes("claude")) return "border-violet-300/40 text-violet-100";
  if (m.includes("llama") || m.includes("groq")) return "border-slate-300/40 text-slate-100";
  return "border-cyan-300/40 text-cyan-100";
}

function mockTokens(entry: LlmAuditEntry) {
  const source = `${JSON.stringify(entry.input || {})}${JSON.stringify(entry.output || {})}`;
  return Math.max(80, Math.round(source.length / 4));
}

function mockLatency(entry: LlmAuditEntry) {
  const base = entry.callType === "plan" ? 1.2 : entry.callType === "recovery" ? 0.95 : 0.75;
  const jitter = (hash(entry.id) % 50) / 100;
  return `${(base + jitter).toFixed(2)}s`;
}

function summarize(entry: LlmAuditEntry) {
  if (entry.callType === "policy") {
    const action = String(entry.output?.action || entry.input?.tool || "tool");
    const verdict = String(entry.output?.verdict || "UNKNOWN");
    const reason = String(entry.output?.reason || "No reason provided");
    return `Action: ${action} | Verdict: ${verdict} | Reason: ${reason}`;
  }

  if (entry.callType === "plan") {
    const stepsCount = Number(entry.output?.stepsCount || 0);
    const question = String(entry.output?.question || "").trim();
    if (question) return `Asked for missing input: ${question}`;
    return `Planned ${stepsCount} step${stepsCount === 1 ? "" : "s"}.`;
  }

  if (entry.callType === "recovery") {
    const action = String(entry.output?.action || "abort");
    const rationale = String(entry.output?.rationale || "").trim();
    return rationale
      ? `Recovery action: ${action}. ${rationale}`
      : `Recovery action: ${action}.`;
  }

  const reply = String(entry.output?.reply || "").trim();
  return reply || "Generated user-facing step summary.";
}

export default function LlmAuditSection({ entries }: LlmAuditSectionProps) {
  const [typeFilter, setTypeFilter] = useState<"all" | "plan" | "recovery" | "reply" | "policy">("all");
  const [query, setQuery] = useState("");
  const [expandedOutputIds, setExpandedOutputIds] = useState<Set<string>>(new Set());
  const [drawerEntry, setDrawerEntry] = useState<LlmAuditEntry | null>(null);

  const stats = useMemo(() => {
    const counts = { plan: 0, recovery: 0, reply: 0, policy: 0 };
    for (const entry of entries) {
      if (entry.callType === "plan") counts.plan += 1;
      if (entry.callType === "recovery") counts.recovery += 1;
      if (entry.callType === "reply") counts.reply += 1;
      if (entry.callType === "policy") counts.policy += 1;
    }
    return counts;
  }, [entries]);

  const modelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of entries) {
      const key = entry.model || "unknown";
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [entries]);
  const topModel = useMemo(
    () => Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0] ?? null,
    [modelCounts],
  );
  const policyBlockedCount = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.callType === "policy" &&
          String(entry.output?.verdict || "").toUpperCase() === "BLOCKED",
      ).length,
    [entries],
  );
  const activeRunCount = useMemo(
    () => new Set(entries.map((entry) => entry.runId).filter(Boolean)).size,
    [entries],
  );

  const sparkline = useMemo(
    () => ({
      total: buildSparklineSeries(entries, () => true),
      plan: buildSparklineSeries(entries, (entry) => entry.callType === "plan"),
      recovery: buildSparklineSeries(entries, (entry) => entry.callType === "recovery"),
      reply: buildSparklineSeries(entries, (entry) => entry.callType === "reply"),
      policy: buildSparklineSeries(entries, (entry) => entry.callType === "policy"),
    }),
    [entries],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (typeFilter !== "all" && entry.callType !== typeFilter) return false;
      if (!q) return true;
      const text = [
        entry.callType,
        entry.model,
        entry.runId || "",
        entry.requestId || "",
        summarize(entry),
        JSON.stringify(entry.input || {}),
      ]
        .join(" ")
        .toLowerCase();
      return text.includes(q);
    });
  }, [entries, typeFilter, query]);

  function toggleExpandedOutput(id: string) {
    setExpandedOutputIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function runToneClass(runId?: string | null) {
    const tones = [
      "border-cyan-300/55",
      "border-fuchsia-300/55",
      "border-amber-300/55",
      "border-lime-300/55",
    ];
    if (!runId) return tones[0];
    return tones[hash(runId) % tones.length];
  }

  const filterChipClass = (active: boolean, tone: string) =>
    `rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] transition ${
      active
        ? `${tone} bg-white/12 text-white shadow-[0_0_12px_rgba(255,255,255,0.16)]`
        : "border-white/15 bg-white/5 text-slate-400 hover:text-slate-100"
    }`;

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="rounded-[2.1rem] border border-white/15 bg-white/8 p-6 text-slate-200 backdrop-blur-xl md:p-7"
    >
      <h2 className="inline-flex items-center gap-2 text-3xl font-black tracking-[-0.03em] text-slate-100">
        <BrainCircuit className="h-6 w-6 text-fuchsia-300" />
        AI Activity
      </h2>
      <p className="mt-2 text-sm text-slate-300">
        Timeline of AI planning, recovery, policy, and response activity.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          {
            key: "total",
            label: "Total calls",
            value: entries.length,
            tone: "border-cyan-300/60 text-cyan-100",
            path: sparklinePath(sparkline.total),
            stroke: "#40E0FF",
          },
          {
            key: "plan",
            label: "Plan",
            value: stats.plan,
            tone: "border-fuchsia-300/60 text-fuchsia-100",
            path: sparklinePath(sparkline.plan),
            stroke: "#F0ABFC",
          },
          {
            key: "recovery",
            label: "Recovery",
            value: stats.recovery,
            tone: "border-amber-300/60 text-amber-100",
            path: sparklinePath(sparkline.recovery),
            stroke: "#FFB800",
          },
          {
            key: "reply",
            label: "Reply",
            value: stats.reply,
            tone: "border-lime-300/60 text-lime-100",
            path: sparklinePath(sparkline.reply),
            stroke: "#B6FF3B",
          },
          {
            key: "policy",
            label: "Policy",
            value: stats.policy,
            tone: "border-rose-300/60 text-rose-100",
            path: sparklinePath(sparkline.policy),
            stroke: "#FB7185",
          },
        ].map((card) => (
          <m.div
            key={card.key}
            whileHover={{ scale: 1.02 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className={`relative overflow-hidden rounded-2xl border bg-black/35 p-3 shadow-[0_10px_24px_rgba(0,0,0,0.35)] ${card.tone}`}
          >
            <svg
              viewBox="0 0 110 36"
              className="pointer-events-none absolute bottom-1 right-2 h-11 w-30 opacity-40"
              aria-hidden="true"
            >
              <path d={card.path} fill="none" stroke={card.stroke} strokeWidth="2" />
            </svg>
            <b className="text-2xl font-black text-white">{card.value}</b>
            <div className="mt-1 text-xs uppercase tracking-[0.14em] text-slate-300">{card.label}</div>
            <div className="text-[11px] text-slate-500">Last 30 min</div>
          </m.div>
        ))}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="glass-panel rounded-2xl border border-white/10 bg-black/25 p-3">
          <div className="text-xs uppercase tracking-[0.12em] text-slate-400">Most Used Model</div>
          <div className="mt-1 text-base font-bold text-slate-100">
            {topModel ? topModel[0] : "No model data"}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {topModel ? `${topModel[1]} calls` : "Run activity to populate model insights."}
          </div>
        </div>
        <div className="glass-panel rounded-2xl border border-white/10 bg-black/25 p-3">
          <div className="text-xs uppercase tracking-[0.12em] text-slate-400">Policy Blocks</div>
          <div className="mt-1 text-base font-bold text-rose-200">{policyBlockedCount}</div>
          <div className="mt-1 text-xs text-slate-400">Policy calls with a blocked verdict.</div>
        </div>
        <div className="glass-panel rounded-2xl border border-white/10 bg-black/25 p-3">
          <div className="text-xs uppercase tracking-[0.12em] text-slate-400">Active Runs</div>
          <div className="mt-1 text-base font-bold text-cyan-100">{activeRunCount}</div>
          <div className="mt-1 text-xs text-slate-400">Unique run IDs in current activity window.</div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-3">
        <label className="inline-flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
          <Search className="h-4 w-4 text-cyan-300" />
          <input
            className="w-full bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search model, run id, output, prompt..."
          />
          <span className="rounded-md border border-white/10 px-2 py-0.5 text-xs text-slate-400">
            ⌘K
          </span>
        </label>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setTypeFilter("all")}
            className={filterChipClass(typeFilter === "all", "border-cyan-300/60")}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setTypeFilter("plan")}
            className={filterChipClass(typeFilter === "plan", "border-fuchsia-300/60 text-fuchsia-100")}
          >
            Plan
          </button>
          <button
            type="button"
            onClick={() => setTypeFilter("recovery")}
            className={filterChipClass(typeFilter === "recovery", "border-amber-300/60 text-amber-100")}
          >
            Recovery
          </button>
          <button
            type="button"
            onClick={() => setTypeFilter("reply")}
            className={filterChipClass(typeFilter === "reply", "border-lime-300/60 text-lime-100")}
          >
            Reply
          </button>
          <button
            type="button"
            onClick={() => setTypeFilter("policy")}
            className={filterChipClass(typeFilter === "policy", "border-rose-300/60 text-rose-100")}
          >
            Policy
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-[1.6rem] border-2 border-black bg-black/35 shadow-[4px_4px_0px_rgba(0,0,0,0.9)]">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="bg-slate-900/80 text-xs uppercase tracking-[0.16em] text-slate-400">
              <th className="px-3 py-3">Time</th>
              <th className="px-3 py-3">Type</th>
              <th className="px-3 py-3">Model</th>
              <th className="px-3 py-3">Run</th>
              <th className="px-3 py-3">Request</th>
              <th className="px-3 py-3">Latency</th>
              <th className="px-3 py-3">Tokens</th>
              <th className="px-3 py-3">Summary</th>
              <th className="px-3 py-3">Input</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 text-slate-200">
            {!filtered.length ? (
              <tr>
                <td colSpan={9} className="px-3 py-4 text-slate-300">
                  No AI activity entries match your filters yet.
                </td>
              </tr>
            ) : null}

            <AnimatePresence>
              {filtered.map((entry) => {
              const why = summarize(entry);
              const typeClass =
                entry.callType === "plan"
                  ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-200"
                  : entry.callType === "recovery"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                    : entry.callType === "policy"
                      ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
                      : "border-sky-500/40 bg-sky-500/10 text-sky-200";
              const runTone = runToneClass(entry.runId);
              const whyExpanded = expandedOutputIds.has(entry.id);

              return (
                <m.tr
                  key={entry.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  className="row-glow-track hover:bg-white/5"
                >
                  <td className={`border-l-2 px-3 py-3 font-mono ${runTone}`}>
                    <div className="text-slate-500">{new Date(entry.createdAt).toLocaleDateString()}</div>
                    <div className="font-semibold text-slate-200">{new Date(entry.createdAt).toLocaleTimeString()}</div>
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${typeClass}`}
                    >
                      {entry.callType}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex rounded-full border bg-slate-900/70 px-2.5 py-1 text-xs ${modelClass(entry.model)}`}>
                      {entry.model}
                    </span>
                  </td>
                  <td className="max-w-48 truncate px-3 py-3">
                    <span className={`rounded-md border px-2 py-1 text-xs ${runTone}`}>{entry.runId ?? "-"}</span>
                  </td>
                  <td className="max-w-48 truncate px-3 py-3">{entry.requestId ?? "-"}</td>
                  <td className="px-3 py-3 text-sm text-cyan-200">{mockLatency(entry)}</td>
                  <td className="px-3 py-3 text-sm text-lime-200">{mockTokens(entry)}</td>
                  <td className="max-w-95 px-3 py-3">
                    <div className={`max-w-95 whitespace-pre-wrap ${semanticClass(why)} ${whyExpanded ? "" : "max-h-20 overflow-hidden"}`}>
                      {why}
                    </div>
                    {why.length > 130 ? (
                      <button
                        type="button"
                        onClick={() => toggleExpandedOutput(entry.id)}
                        className="mt-1 inline-flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200"
                      >
                        {whyExpanded ? "Show less" : "Read more..."}
                        <ChevronDown className={`h-3.5 w-3.5 transition ${whyExpanded ? "rotate-180" : ""}`} />
                      </button>
                    ) : null}
                  </td>
                  <td className="max-w-105 px-3 py-3 align-top">
                    <button
                      type="button"
                      onClick={() => setDrawerEntry(entry)}
                      className="rounded-lg border border-cyan-300/45 bg-cyan-300/10 px-2.5 py-1.5 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-300/20"
                    >
                      Open details
                    </button>
                  </td>
                </m.tr>
              );
              })}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

      <AnimatePresence>
        {drawerEntry ? (
          <>
            <m.button
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/45"
              onClick={() => setDrawerEntry(null)}
              aria-label="Close context drawer"
            />
            <m.aside
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="fixed right-0 top-0 z-50 h-full w-full max-w-2xl overflow-auto border-l border-white/10 bg-[#10131a]/95 p-5 backdrop-blur-xl"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xl font-bold text-slate-100">Request Details</h3>
                <button
                  type="button"
                  onClick={() => setDrawerEntry(null)}
                  className="rounded-full border border-white/20 px-3 py-1 text-sm text-slate-200"
                >
                  Close
                </button>
              </div>
              <div className="mt-3 grid gap-2 text-sm text-slate-300">
                <div>Type: {drawerEntry.callType}</div>
                <div>Model: {drawerEntry.model}</div>
                <div className="inline-flex items-center gap-1">
                  <Clock3 className="h-4 w-4 text-cyan-300" />
                  {new Date(drawerEntry.createdAt).toLocaleString()}
                </div>
              </div>

              <div className="mt-4 grid gap-3">
                <div className="rounded-xl border border-white/10 bg-black/35 p-3">
                  <div className="mb-2 text-xs uppercase tracking-[0.12em] text-slate-400">Input (JSON)</div>
                  <pre className="max-h-90 overflow-auto rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs leading-5 text-slate-200">
                    {pretty(drawerEntry.input)}
                  </pre>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/35 p-3">
                  <div className="mb-2 text-xs uppercase tracking-[0.12em] text-slate-400">Output (JSON)</div>
                  <pre className="max-h-90 overflow-auto rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs leading-5 text-slate-200">
                    {pretty(drawerEntry.output)}
                  </pre>
                </div>
              </div>
            </m.aside>
          </>
        ) : null}
      </AnimatePresence>
    </m.div>
  );
}
