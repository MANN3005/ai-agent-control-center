import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import {
  Bot,
  ChevronDown,
  Cpu,
  Lock,
  Shield,
  ShieldAlert,
  Sparkles,
  Unlock,
  Workflow,
} from "lucide-react";
import type {
  AgentMessage,
  AgentPayload,
  AgentPlanStep,
  AgentRun,
  AgentStep,
  AgentTrace,
  Issue,
  Pull,
  Repo,
} from "../types";

type StepUpInfo = {
  active: boolean;
  expiresAt: string | null;
  remainingText: string;
  pending: boolean;
};

type AgentPanelProps = {
  agentTask: string;
  onTaskChange: (value: string) => void;
  onSend: () => void;
  agentRun: AgentRun | null;
  agentMessages: AgentMessage[];
  agentSteps: AgentStep[];
  agentTrace: AgentTrace[];
  pendingApprovalStep?: AgentStep | null;
  pendingApprovalStatus: string | null;
  approvalError: string | null;
  onConfirm: () => void;
  onApprove: () => void;
  onAllowListRepo: (repo: string) => void;
  stepUpInfo: StepUpInfo;
  onStartStepUp: () => void;
  agentHealth: {
    status: "STANDBY" | "DISARMED";
    disarmedAt: string | null;
    reason: string | null;
  };
};

function renderAgentOutput(step: AgentStep) {
  const payload = step?.result?.result as AgentPayload | undefined;
  if (!payload) return null;

  const tableClass =
    "min-w-full text-left text-sm [&_th]:border-b [&_th]:border-white/10 [&_td]:border-b [&_td]:border-white/5";

  if (Array.isArray(payload.issues)) {
    return (
      <div className="mt-2 overflow-x-auto rounded-xl border border-white/10 bg-black/25">
        <table className={tableClass}>
          <thead>
            <tr className="bg-slate-900/70 text-xs uppercase tracking-[0.14em] text-slate-400">
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">Link</th>
            </tr>
          </thead>
          <tbody className="text-slate-200 [&_tr:hover]:bg-white/5">
            {payload.issues.map((issue: Issue) => (
              <tr key={issue.id}>
                <td className="px-3 py-2">{issue.number}</td>
                <td className="px-3 py-2">{issue.title}</td>
                <td className="px-3 py-2">{issue.state}</td>
                <td className="px-3 py-2">
                  <a className="text-cyan-300 hover:text-cyan-200" href={issue.htmlUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (Array.isArray(payload.repos)) {
    return (
      <div className="mt-2 overflow-x-auto rounded-xl border border-white/10 bg-black/25">
        <table className={tableClass}>
          <thead>
            <tr className="bg-slate-900/70 text-xs uppercase tracking-[0.14em] text-slate-400">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2">Private</th>
              <th className="px-3 py-2">Updated</th>
              <th className="px-3 py-2">Link</th>
            </tr>
          </thead>
          <tbody className="text-slate-200 [&_tr:hover]:bg-white/5">
            {payload.repos.map((repo: Repo) => (
              <tr key={repo.id}>
                <td className="px-3 py-2">{repo.fullName ?? repo.name}</td>
                <td className="px-3 py-2">{repo.owner ?? ""}</td>
                <td className="px-3 py-2">
                  {repo.private ? (
                    <span className="rounded-full border border-rose-300/60 bg-rose-300/15 px-2 py-1 text-xs font-semibold text-rose-100">
                      Private
                    </span>
                  ) : (
                    <span className="rounded-full border border-emerald-300/60 bg-emerald-300/15 px-2 py-1 text-xs font-semibold text-emerald-100">
                      Public
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{repo.updatedAt}</td>
                <td className="px-3 py-2">
                  <a className="text-cyan-300 hover:text-cyan-200" href={repo.htmlUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (Array.isArray(payload.pulls)) {
    return (
      <div className="mt-2 overflow-x-auto rounded-xl border border-white/10 bg-black/25">
        <table className={tableClass}>
          <thead>
            <tr className="bg-slate-900/70 text-xs uppercase tracking-[0.14em] text-slate-400">
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">Draft</th>
              <th className="px-3 py-2">Link</th>
            </tr>
          </thead>
          <tbody className="text-slate-200 [&_tr:hover]:bg-white/5">
            {payload.pulls.map((pull: Pull) => (
              <tr key={pull.id}>
                <td className="px-3 py-2">{pull.number}</td>
                <td className="px-3 py-2">{pull.title}</td>
                <td className="px-3 py-2">{pull.state}</td>
                <td className="px-3 py-2">{pull.draft ? "Yes" : "No"}</td>
                <td className="px-3 py-2">
                  <a className="text-cyan-300 hover:text-cyan-200" href={pull.htmlUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (payload.issue) {
    return (
      <div className="mt-2 overflow-x-auto rounded-xl border border-white/10 bg-black/25">
        <table className={tableClass}>
          <thead>
            <tr className="bg-slate-900/70 text-xs uppercase tracking-[0.14em] text-slate-400">
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">Link</th>
            </tr>
          </thead>
          <tbody className="text-slate-200 [&_tr:hover]:bg-white/5">
            <tr>
              <td className="px-3 py-2">{payload.issue.number}</td>
              <td className="px-3 py-2">{payload.issue.title}</td>
              <td className="px-3 py-2">{payload.issue.state}</td>
              <td className="px-3 py-2">
                <a className="text-cyan-300 hover:text-cyan-200" href={payload.issue.htmlUrl} target="_blank" rel="noreferrer">
                  Open
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  return null;
}

export default function AgentPanel({
  agentTask,
  onTaskChange,
  onSend,
  agentRun,
  agentMessages,
  agentSteps,
  agentTrace,
  pendingApprovalStep,
  pendingApprovalStatus,
  approvalError,
  onConfirm,
  onApprove,
  onAllowListRepo,
  stepUpInfo,
  onStartStepUp,
  agentHealth,
}: AgentPanelProps) {
  const [expandedOutputIndex, setExpandedOutputIndex] = useState<number | null>(null);
  const [selectedFlowNode, setSelectedFlowNode] = useState<"thought" | "policy" | "tool" | "output">("thought");
  const [nowMs, setNowMs] = useState(() => Date.now());

  const chatMessages: AgentMessage[] = agentMessages.length
    ? agentMessages
    : [{ role: "agent", text: "Say hello to start." }];

  const allowListStep = [...agentSteps]
    .reverse()
    .find((step) => step.reason === "Repo not allow-listed" && step.input?.repo);
  const allowListRepo = allowListStep?.input?.repo as string | undefined;
  const pendingResult = pendingApprovalStep?.result as
    | { preview?: { tool?: string; input?: Record<string, unknown> } }
    | undefined;
  const approvalPreview = pendingResult?.preview;
  const needsStepUp = pendingApprovalStatus === "step_up_required";
  const needsHumanIntervention =
    pendingApprovalStatus === "step_up_required" ||
    pendingApprovalStatus === "confirm_required" ||
    agentRun?.status === "WAITING_APPROVAL";
  const prevNeedsHumanRef = useRef(false);

  const promptStarters = [
    "Summarize issues",
    "List my repos",
    "Show open PRs",
    "Draft Slack update",
  ];

  const latestTraceText = agentTrace[agentTrace.length - 1]?.text ?? "";
  const isDisarmed = agentHealth.status === "DISARMED";

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const disarmedAtMs = agentHealth.disarmedAt
    ? new Date(agentHealth.disarmedAt).getTime()
    : Number.NaN;
  const showDisarmedToast =
    isDisarmed &&
    Number.isFinite(disarmedAtMs) &&
    nowMs - disarmedAtMs >= 0 &&
    nowMs - disarmedAtMs <= 5000;

  const remainingSeconds = useMemo(() => {
    if (!stepUpInfo.remainingText || stepUpInfo.remainingText === "-") return null;
    const [min, sec] = stepUpInfo.remainingText.split(":").map((v) => Number(v));
    if (Number.isNaN(min) || Number.isNaN(sec)) return null;
    return min * 60 + sec;
  }, [stepUpInfo.remainingText]);

  const stepUpTotalSeconds = 900;
  const countdownProgress =
    remainingSeconds !== null
      ? Math.max(0, Math.min(1, remainingSeconds / Math.max(1, stepUpTotalSeconds)))
      : 0;
  const ringCircumference = 2 * Math.PI * 26;
  const ringOffset = ringCircumference * (1 - countdownProgress);

  const flowNodes = [
    { id: "thought", label: "Thought" },
    { id: "policy", label: "Policy Check" },
    { id: "tool", label: "Tool Call" },
    { id: "output", label: "Output" },
  ];

  const latestStepStatus = agentSteps[agentSteps.length - 1]?.status || "";
  const latestStep = agentSteps[agentSteps.length - 1];
  const latestPayload = latestStep?.result?.result as AgentPayload | undefined;
  const flowStage = (() => {
    if (!agentSteps.length) return 1;
    if (["EXECUTED", "COMPLETED", "ERROR", "FAILED"].includes(latestStepStatus)) {
      return 4;
    }
    if (["RUNNING", "APPROVAL_REQUIRED", "WAITING_APPROVAL"].includes(latestStepStatus)) {
      return 3;
    }
    return 2;
  })();

  const flowDetails = {
    thought: {
      title: "Reasoning Stream",
      lines: [
        `Trace events: ${agentTrace.length}`,
        latestTraceText || "Waiting for new thought events...",
      ],
    },
    policy: {
      title: "Policy Evaluation",
      lines: [
        `Pending approval status: ${pendingApprovalStatus || "none"}`,
        pendingApprovalStep?.reason || "No policy gate currently blocking execution.",
      ],
    },
    tool: {
      title: "Current Tool Call",
      lines: [
        `Tool: ${latestStep?.tool || "-"}`,
        `Status: ${latestStep?.status || "-"}`,
        latestStep?.input ? JSON.stringify(latestStep.input) : "No tool input captured yet.",
      ],
    },
    output: {
      title: "Output Snapshot",
      lines: [
        latestPayload?.repos
          ? `Repos returned: ${latestPayload.repos.length}`
          : latestPayload?.issues
            ? `Issues returned: ${latestPayload.issues.length}`
            : latestPayload?.pulls
              ? `PRs returned: ${latestPayload.pulls.length}`
              : latestPayload?.issue
                ? `Issue returned: #${latestPayload.issue.number}`
                : "No structured output yet.",
        latestStep?.result ? "Tool output available. Expand step card to inspect full payload." : "Awaiting tool output...",
      ],
    },
  } as const;

  useEffect(() => {
    if (!needsHumanIntervention || prevNeedsHumanRef.current) {
      prevNeedsHumanRef.current = needsHumanIntervention;
      return;
    }
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) {
        prevNeedsHumanRef.current = needsHumanIntervention;
        return;
      }
      const ctx = new AudioCtx();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 220;
      gain.gain.value = 0.0001;
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.02, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
      oscillator.start(now);
      oscillator.stop(now + 0.24);
      window.setTimeout(() => {
        void ctx.close();
      }, 350);
    } catch {
      // Optional sound cue; ignore failures in restricted browser contexts.
    }
    prevNeedsHumanRef.current = needsHumanIntervention;
  }, [needsHumanIntervention]);

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="rounded-[2.1rem] border border-white/15 bg-white/8 p-6 text-slate-200 backdrop-blur-xl md:p-7"
    >
      <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
        <div>
          <h2 className="inline-flex items-center gap-2 text-3xl font-black tracking-[-0.03em] text-slate-100">
            <Bot className="h-6 w-6 text-cyan-300" />
            Agent
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Command-center for live runs, policy-gated execution, and tool output.
          </p>
        </div>

        <m.div
          whileHover={{ y: -2 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className={`glass-panel rounded-3xl bg-black/35 p-4 ${
            stepUpInfo.active
              ? "hud-unlock-glow border border-cyan-300/65"
              : needsHumanIntervention
              ? "hud-alert-pulse border border-amber-300/70"
              : "border border-slate-500/40"
          }`}
        >
          <div
            className={`inline-flex items-center gap-2 text-xs uppercase tracking-[0.14em] ${
              stepUpInfo.active ? "text-cyan-200" : "text-amber-200"
            }`}
          >
            <ShieldAlert className="h-4 w-4" />
            Step-up HUD
          </div>
          <div className="mt-3 flex items-center gap-3">
            <div className="relative h-18 w-18">
              <svg viewBox="0 0 64 64" className="h-18 w-18 -rotate-90">
                <circle cx="32" cy="32" r="26" stroke="rgba(148,163,184,0.35)" strokeWidth="5" fill="none" />
                <circle
                  cx="32"
                  cy="32"
                  r="26"
                  stroke="rgba(255,184,0,0.9)"
                  strokeWidth="5"
                  fill="none"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={ringOffset}
                  strokeLinecap="round"
                  className="transition-all duration-500"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-slate-100">
                {stepUpInfo.remainingText}
              </div>
            </div>
            <div className="text-sm text-slate-200">
              <div className="inline-flex items-center gap-2">
                {stepUpInfo.active ? (
                  <m.span
                    key="stepup-active"
                    initial={{ scale: 0.85, opacity: 0.72 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.36, ease: "easeOut" }}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-cyan-300/70 bg-cyan-300/20 text-cyan-100 shadow-[0_0_14px_rgba(64,224,255,0.48)] hud-unlock-flash"
                  >
                    <Shield className="h-3.5 w-3.5" />
                  </m.span>
                ) : (
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-500/45 bg-slate-700/25 text-slate-400 grayscale">
                    <Shield className="h-3.5 w-3.5" />
                  </span>
                )}
                <b>{stepUpInfo.active ? "Session Active" : "Session Locked"}</b>
              </div>
              <div className="mt-1 text-xs text-slate-400">
                Expires: {stepUpInfo.expiresAt ? new Date(stepUpInfo.expiresAt).toLocaleTimeString() : "-"}
              </div>
            </div>
          </div>
          <m.button
            type="button"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            onClick={onStartStepUp}
            disabled={stepUpInfo.pending}
            className={`mt-3 rounded-full px-4 py-2 text-sm font-semibold ${
              stepUpInfo.active
                ? "border border-cyan-300/70 bg-cyan-300/20 text-cyan-100"
                : "border border-amber-300/70 bg-amber-300/25 text-amber-100"
            } disabled:cursor-not-allowed disabled:opacity-70`}
          >
            {stepUpInfo.pending
              ? "Step-up in progress..."
              : stepUpInfo.active
                ? "Refresh Step-up"
                : "Start Step-up"}
          </m.button>
        </m.div>
      </div>

      <div
        className={`mt-4 rounded-2xl border p-4 ${
          isDisarmed
            ? "border-rose-300/55 bg-rose-300/12"
            : "border-emerald-300/45 bg-emerald-300/10"
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-slate-200">
              {isDisarmed ? <Lock className="h-4 w-4 text-rose-200" /> : <Unlock className="h-4 w-4 text-emerald-200" />}
              Agent Control Plane
            </div>
            <div className="mt-1 text-sm">
              <span className={`font-black ${isDisarmed ? "text-rose-200" : "text-emerald-200"}`}>
                {isDisarmed ? "DISARMED" : "ARMED"}
              </span>
              {isDisarmed ? (
                <span className="ml-2 text-slate-200">
                  Tool calls are intentionally blocked by Session Lockdown.
                </span>
              ) : (
                <span className="ml-2 text-slate-200">
                  Agent execution path is active.
                </span>
              )}
            </div>
            {agentHealth.disarmedAt ? (
              <div className="mt-1 text-xs text-slate-300">
                Disarmed at {new Date(agentHealth.disarmedAt).toLocaleString()}
                {agentHealth.reason ? ` | Reason: ${agentHealth.reason}` : ""}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {isDisarmed && showDisarmedToast ? (
        <div className="fixed right-5 top-20 z-70 rounded-xl border border-rose-300/45 bg-slate-950/95 px-4 py-3 text-sm text-rose-100 shadow-[0_0_24px_rgba(244,63,94,0.35)]">
          Session is DISARMED. Manage Lockdown/Re-arm from Access page.
        </div>
      ) : null}

      <div className="mt-5 grid gap-3">
        <div className="grid max-h-72 gap-3 overflow-auto rounded-2xl border border-slate-700 bg-slate-900/55 p-3">
          {chatMessages.map((msg: AgentMessage, idx: number) => (
            <div
              key={`${msg.role}-${idx}`}
              className={`rounded-xl border px-3 py-2 ${
                msg.role === "user"
                  ? "border-indigo-300/35 bg-indigo-300/10"
                  : "border-slate-700 bg-slate-900"
              }`}
            >
              <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-slate-400">{msg.role}</div>
              <div>{msg.text}</div>
            </div>
          ))}
        </div>
        {allowListRepo ? (
          <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
            <div className="text-xs uppercase tracking-[0.12em] text-amber-200">Repo not allow-listed</div>
            <div className="mt-1 text-sm text-amber-50">{allowListRepo}</div>
            <div className="mt-3">
              <button
                type="button"
                onClick={() => onAllowListRepo(allowListRepo)}
                className="rounded-full bg-amber-200 px-5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-amber-100"
              >
                Add to allow-list
              </button>
            </div>
          </div>
        ) : null}
        {approvalPreview ? (
          <div className="rounded-2xl border border-slate-700 bg-slate-900/55 p-4">
            <div className="text-xs uppercase tracking-[0.12em] text-slate-400">Approval preview</div>
            <div className="mt-2 text-sm">
              <div>
                Tool: <b>{approvalPreview.tool || "-"}</b>
              </div>
              <div className="mt-2 font-mono text-xs text-slate-400">
                {JSON.stringify(approvalPreview.input || {}, null, 2)}
              </div>
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {promptStarters.map((starter) => (
            <button
              key={starter}
              type="button"
              onClick={() => onTaskChange(starter)}
              className="rounded-full border border-cyan-300/45 bg-cyan-300/10 px-3 py-1.5 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-300/20"
            >
              {starter}
            </button>
          ))}
        </div>
        <div className="grid items-start gap-3 md:grid-cols-[1fr_auto]">
          <textarea
            className="w-full rounded-2xl border border-slate-600 bg-slate-900/80 px-4 py-3 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/40 focus:shadow-[0_0_18px_rgba(64,224,255,0.28)]"
            value={agentTask}
            onChange={(e) => onTaskChange(e.target.value)}
            rows={3}
            placeholder="Ask the agent to do something..."
            onKeyDown={(e) => {
              if (isDisarmed) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            disabled={isDisarmed}
          />
          <m.button
            type="button"
            whileHover={{ scale: 1.04, y: -1 }}
            whileTap={{ scale: 0.98 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            onClick={onSend}
            disabled={isDisarmed}
            className="inline-flex items-center gap-2 rounded-full border border-cyan-200/35 bg-linear-to-r from-cyan-300 to-sky-300 px-6 py-2.5 text-sm font-black text-black shadow-[0_0_20px_rgba(64,224,255,0.32)]"
          >
            <Sparkles className="h-4 w-4" />
            Send
          </m.button>
        </div>
        {agentRun?.status === "WAITING_APPROVAL" && (
          <div className="mt-1">
            {pendingApprovalStatus === "confirm_required" ? (
              <m.button
                type="button"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                onClick={onConfirm}
                className="rounded-full border-2 border-black bg-cyan-300 px-5 py-2 text-sm font-black text-black shadow-[4px_4px_0px_rgba(0,0,0,0.9)]"
              >
                Confirm & Continue
              </m.button>
            ) : (
              <m.button
                type="button"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                onClick={onApprove}
                className="rounded-full border-2 border-black bg-cyan-300 px-5 py-2 text-sm font-black text-black shadow-[4px_4px_0px_rgba(0,0,0,0.9)]"
              >
                Approve & Continue
              </m.button>
            )}
            {approvalError ? (
              <div className="mt-2 text-xs text-rose-300">{approvalError}</div>
            ) : null}
          </div>
        )}
      </div>

      {agentRun && (
        <m.div
          whileHover={{ scale: 1.01 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="mt-5 rounded-[1.8rem] border border-white/15 bg-white/8 p-4 backdrop-blur-xl"
        >
          <h3 className="inline-flex items-center gap-2 text-xl font-black text-slate-100">
            <Workflow className="h-5 w-5 text-fuchsia-300" />
            Plan & Trace
          </h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div>
              <div className="text-xs uppercase tracking-[0.14em] text-slate-400">Status</div>
              <div className="mt-1 text-lg font-semibold text-slate-100">{agentRun.status}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.14em] text-slate-400">Step</div>
              <div className="mt-1 text-lg font-semibold text-slate-100">{agentRun.currentStep}</div>
            </div>
            {agentRun.lastError && (
              <div>
                <div className="text-xs uppercase tracking-[0.14em] text-slate-400">Last Error</div>
                <div className="mt-1 text-sm text-rose-300">{agentRun.lastError}</div>
              </div>
            )}
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
            <div className="space-y-4">
              {Array.isArray(agentRun.plan) && agentRun.plan.length > 0 && (
                <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
                  <h4 className="mb-2 font-semibold text-slate-200">Plan</h4>
                  <div className="overflow-x-auto rounded-xl border border-white/10">
                    <table className="min-w-full text-left text-sm [&_th]:border-b [&_th]:border-white/10 [&_td]:border-b [&_td]:border-white/5">
                      <thead>
                        <tr className="bg-slate-900/70 text-xs uppercase tracking-[0.14em] text-slate-400">
                          <th className="px-3 py-2">Step</th>
                          <th className="px-3 py-2">Tool</th>
                          <th className="px-3 py-2">Input</th>
                        </tr>
                      </thead>
                      <tbody className="bg-slate-950/30 text-slate-200 [&_tr:hover]:bg-white/5">
                        {agentRun.plan.map((step: AgentPlanStep, idx: number) => (
                          <tr key={`${step.tool}-${idx}`}>
                            <td className="px-3 py-2">{idx + 1}</td>
                            <td className="px-3 py-2">{step.tool}</td>
                            <td className="px-3 py-2 font-mono text-xs">{JSON.stringify(step.input)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {agentTrace.length > 0 && (
                <div className="rounded-2xl border border-cyan-300/25 bg-[#0b0d10] p-3">
                  <h4 className="mb-2 inline-flex items-center gap-2 font-semibold text-cyan-100">
                    <Cpu className="h-4 w-4" />
                    Live Thought Stream
                  </h4>
                  <div className="grid max-h-72 gap-2 overflow-auto rounded-xl border border-cyan-300/15 bg-black/55 p-3 font-mono text-sm text-cyan-100">
                    {agentTrace.map((item: AgentTrace, idx: number) => {
                      const isLast = idx === agentTrace.length - 1;
                      return (
                        <div
                          key={`${item.type}-${idx}`}
                          className="rounded-lg border border-white/8 bg-white/3 px-3 py-2"
                          style={{
                            animation: `streamIn 0.35s ease-out ${Math.min(idx * 0.08, 0.45)}s both`,
                          }}
                        >
                          <span className="mr-2 text-cyan-300">[{item.type}]</span>
                          {isLast ? (
                            <span className="relative inline-block max-w-full align-bottom">
                              <span className="invisible whitespace-nowrap">{latestTraceText}</span>
                              <span
                                key={latestTraceText}
                                className="absolute left-0 top-0 block max-w-full overflow-hidden whitespace-nowrap"
                                style={{
                                  animation: `typingClip ${Math.max(2.2, latestTraceText.length * 0.035)}s steps(${Math.max(1, latestTraceText.length)}, end) forwards`,
                                }}
                              >
                                {latestTraceText}
                              </span>
                            </span>
                          ) : (
                            <span>{item.text}</span>
                          )}
                          {isLast ? <span className="ml-1 animate-pulse text-cyan-300">_</span> : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {agentSteps.length > 0 && (
              <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
                <h4 className="mb-3 font-semibold text-slate-200">Execution Timeline</h4>

                <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
                  {flowNodes.map((node, idx) => {
                    const isExecuted = idx < flowStage;
                    const isSelected = selectedFlowNode === node.id;
                    return (
                      <button
                        key={node.id}
                        type="button"
                        onClick={() =>
                          setSelectedFlowNode(
                            node.id as "thought" | "policy" | "tool" | "output",
                          )
                        }
                        className={`rounded-xl px-3 py-2 text-center text-xs font-semibold uppercase tracking-[0.08em] ${
                          isExecuted
                            ? "border border-cyan-300/60 bg-cyan-300/15 text-cyan-100 shadow-[0_0_14px_rgba(64,224,255,0.35)]"
                            : "border border-dashed border-slate-500/65 bg-black/20 text-slate-400"
                        } ${isSelected ? "ring-2 ring-cyan-200/45" : ""}`}
                      >
                        {node.label}
                      </button>
                    );
                  })}
                </div>

                <div className="mb-4 rounded-xl border border-white/10 bg-black/25 p-3 font-mono text-xs text-slate-200">
                  <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-cyan-300">
                    {flowDetails[selectedFlowNode].title}
                  </div>
                  <div className="grid gap-1">
                    {flowDetails[selectedFlowNode].lines.map((line, idx) => (
                      <div key={`${selectedFlowNode}-detail-${idx}`} className="break-all text-slate-300">
                        {line}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="relative pl-6">
                <div className="absolute left-2.75 top-0 h-full w-px bg-slate-700/80" />
                <AnimatePresence>
                  {agentSteps.map((step: AgentStep, idx: number) => {
                    const isPlanning = step.status === "RUNNING";
                    const isPolicyGate = step.status === "APPROVAL_REQUIRED";
                    const isExpanded = expandedOutputIndex === idx;

                    return (
                      <m.div
                        key={`${step.tool}-${idx}`}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 10 }}
                        transition={{ delay: idx * 0.08 }}
                        className="relative mb-3 rounded-2xl border border-slate-700/80 bg-slate-900/45 p-3"
                      >
                        <div
                          className={`absolute -left-5.25 top-4 h-4 w-4 rounded-full border border-black ${
                            isPolicyGate
                              ? "bg-amber-300 shadow-[0_0_14px_rgba(255,184,0,0.75)]"
                              : isPlanning
                                ? "animate-pulse bg-cyan-300 shadow-[0_0_12px_rgba(64,224,255,0.7)]"
                                : "bg-slate-400"
                          }`}
                        />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-xs uppercase tracking-[0.14em] text-slate-400">
                              Step {idx + 1}
                            </div>
                            <div className="text-sm font-semibold text-slate-100">{step.tool}</div>
                          </div>
                          <div className="rounded-full border border-slate-600 px-2 py-1 text-xs text-slate-200">
                            {step.status}
                          </div>
                        </div>
                        {step.reason ? (
                          <div className="mt-2 text-sm text-slate-300">{step.reason}</div>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setExpandedOutputIndex(isExpanded ? null : idx)}
                          className="mt-3 inline-flex items-center gap-1 text-xs uppercase tracking-[0.12em] text-cyan-300"
                        >
                          {isExpanded ? "Hide" : "View"} output
                          <ChevronDown className={`h-3.5 w-3.5 transition ${isExpanded ? "rotate-180" : ""}`} />
                        </button>
                        <AnimatePresence>
                          {isExpanded ? (
                            <m.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: "auto" }}
                              exit={{ opacity: 0, height: 0 }}
                              className="overflow-hidden"
                            >
                              <div className="mt-2 rounded-xl border border-cyan-300/20 bg-[#0b0d10] p-2">
                                {renderAgentOutput(step) || (
                                  <pre className="overflow-x-auto text-xs text-slate-400">
                                    {JSON.stringify(step.result ?? {}, null, 2)}
                                  </pre>
                                )}
                              </div>
                            </m.div>
                          ) : null}
                        </AnimatePresence>
                      </m.div>
                    );
                  })}
                </AnimatePresence>
                </div>
              </div>
            )}
          </div>
        </m.div>
      )}

      <AnimatePresence>
        {needsStepUp ? (
          <m.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-lg"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <m.div
              initial={{ scale: 0.97, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.98, opacity: 0 }}
              className="relative w-full max-w-xl overflow-hidden rounded-4xl border border-cyan-200/20 bg-[#151A21]/90 p-7 text-slate-100"
            >
              <div className="animate-scan-line pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-cyan-300/10 to-transparent" />
              <div className="relative">
                <div className="text-xs uppercase tracking-[0.18em] text-cyan-300">Security Scan</div>
                <h4 className="mt-2 text-3xl font-semibold tracking-[-0.02em]">Step-up approval required</h4>
                <p className="mt-2 text-sm text-slate-300">
                  This action crossed a high-risk policy boundary. Start a step-up
                  session to continue execution.
                </p>
                <m.button
                  type="button"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  onClick={onStartStepUp}
                  className="mt-5 rounded-full border border-cyan-300/60 bg-cyan-300/20 px-5 py-2 text-sm font-semibold text-cyan-100"
                >
                  Start Step-up
                </m.button>
              </div>
            </m.div>
          </m.div>
        ) : null}
      </AnimatePresence>
    </m.div>
  );
}
