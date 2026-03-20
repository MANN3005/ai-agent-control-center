import { m } from "framer-motion";
import {
  GitPullRequest,
  MessageSquare,
  Search,
  Settings2,
  ShieldAlert,
} from "lucide-react";
import type { Policy } from "../types";

type PoliciesSectionProps = {
  policies: Policy[];
  onChange: (next: Policy[]) => void;
  onSave: () => void;
  onReload: () => void;
};

export default function PoliciesSection({
  policies,
  onChange,
  onSave,
  onReload,
}: PoliciesSectionProps) {
  function updateRow(idx: number, patch: Partial<Policy>) {
    const next = [...policies];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  }

  const riskLevels: Policy["riskLevel"][] = ["LOW", "MEDIUM", "HIGH"];
  const modes: Policy["mode"][] = ["AUTO", "CONFIRM", "STEP_UP"];

  const riskValue = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;
  const averageRiskScore =
    policies.reduce((sum, p) => sum + riskValue[p.riskLevel], 0) /
    Math.max(1, policies.length);
  const averageRisk =
    averageRiskScore < 1.6 ? "Low" : averageRiskScore < 2.5 ? "Medium" : "High";
  const globalPosture = policies.some(
    (p) => p.riskLevel !== "LOW" || p.mode !== "AUTO",
  )
    ? "RESTRICTED"
    : "BASELINE";

  const toolMeta: Record<
    string,
    {
      icon: typeof Search;
      description: string;
    }
  > = {
    github_explorer: {
      icon: Search,
      description: "Explores accessible repositories, issues, and pull requests.",
    },
    manage_issues: {
      icon: GitPullRequest,
      description: "Creates and updates issue workflows for tracked repositories.",
    },
    slack_notifier: {
      icon: MessageSquare,
      description: "Sends summaries and critical alerts to linked Slack channels.",
    },
  };

  const activeDotClass = (mode: Policy["mode"]) => {
    if (mode === "AUTO") return "bg-lime-300 shadow-[0_0_10px_rgba(182,255,59,0.8)] animate-pulse";
    if (mode === "STEP_UP") return "bg-amber-300 shadow-[0_0_10px_rgba(255,184,0,0.8)] animate-pulse";
    return "bg-cyan-300 shadow-[0_0_10px_rgba(64,224,255,0.7)]";
  };

  const activeRiskClass = (risk: Policy["riskLevel"]) => {
    if (risk === "LOW") {
      return "border border-cyan-300/85 bg-cyan-300/25 text-white shadow-[0_0_16px_rgba(64,224,255,0.45)]";
    }
    if (risk === "MEDIUM") {
      return "border border-amber-300/85 bg-amber-300/30 text-white shadow-[0_0_15px_rgba(255,184,0,0.42)]";
    }
    return "border border-[#FF3B3B]/90 bg-[#FF3B3B]/30 text-white shadow-[0_0_16px_rgba(255,59,59,0.45)]";
  };

  const activeModeClass = (mode: Policy["mode"]) => {
    if (mode === "AUTO") {
      return "border border-lime-300/85 bg-lime-300/25 text-white shadow-[0_0_16px_rgba(182,255,59,0.45)]";
    }
    if (mode === "CONFIRM") {
      return "border border-amber-300/85 bg-amber-300/30 text-white shadow-[0_0_15px_rgba(255,184,0,0.42)]";
    }
    return "border border-[#FF3B3B]/90 bg-[#FF3B3B]/30 text-white shadow-[0_0_16px_rgba(255,59,59,0.45)]";
  };

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="rounded-4xl border border-white/15 bg-white/8 p-6 text-slate-200 backdrop-blur-xl md:p-7"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <h2 className="inline-flex items-center gap-2 text-3xl font-black tracking-[-0.03em] text-slate-100">
        <Settings2 className="h-6 w-6 text-fuchsia-300" />
        Tool Policies
        </h2>
        <div className="glass-panel inline-flex items-center gap-4 rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm">
          <div>
            <span className="text-slate-400">Global Posture: </span>
            <span className="font-semibold text-amber-200">{globalPosture}</span>
          </div>
          <div className="h-5 w-px bg-white/10" />
          <div>
            <span className="text-slate-400">Average Tool Risk: </span>
            <span className="font-semibold text-cyan-200">{averageRisk}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 rounded-3xl border-2 border-black bg-black/35 p-4 shadow-[4px_4px_0px_rgba(0,0,0,0.9)]">
        {policies.map((p, idx) => (
          <m.div
            key={p.toolName}
            whileHover={{ y: -2 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="glass-panel rounded-2xl border border-white/10 bg-white/7 p-4 transition hover:bg-white/10"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.14em] text-slate-200">
                  {(() => {
                    const Icon = toolMeta[p.toolName]?.icon || ShieldAlert;
                    return <Icon className="h-4 w-4 text-cyan-300" />;
                  })()}
                  {p.toolName}
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {toolMeta[p.toolName]?.description || "Security control for tool execution behavior."}
                </div>
              </div>
              <span className={`h-2.5 w-2.5 rounded-full ${activeDotClass(p.mode)}`} />
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <div className="mb-2 text-xs uppercase tracking-[0.14em] text-slate-400">Risk</div>
                <div className="relative flex rounded-2xl border border-white/10 bg-slate-950/70 p-1">
                  {riskLevels.map((risk) => (
                    <button
                      key={risk}
                      type="button"
                      onClick={() => updateRow(idx, { riskLevel: risk })}
                      className={`relative z-10 flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                        p.riskLevel === risk
                          ? activeRiskClass(risk)
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {risk}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 text-xs uppercase tracking-[0.14em] text-slate-400">Mode</div>
                <div className="relative flex rounded-2xl border border-white/10 bg-slate-950/70 p-1">
                  {modes.map((mode) => (
                    <m.button
                      key={mode}
                      type="button"
                      whileHover={{ scale: 1.03 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => updateRow(idx, { mode })}
                      className={`relative z-10 flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                        p.mode === mode
                          ? activeModeClass(mode)
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {mode}
                    </m.button>
                  ))}
                </div>
              </div>
            </div>
          </m.div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <m.button
          type="button"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          onClick={onSave}
          className="rounded-full border border-cyan-200/40 bg-linear-to-r from-cyan-300 to-sky-300 px-6 py-2.5 text-sm font-black text-black shadow-[0_0_24px_rgba(64,224,255,0.32)]"
        >
          Save Policies
        </m.button>
        <m.button
          type="button"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          onClick={onReload}
          className="rounded-full border border-white/35 bg-transparent px-6 py-2.5 text-sm font-black text-slate-100 hover:bg-white/8"
        >
          Reload
        </m.button>
      </div>
    </m.div>
  );
}
