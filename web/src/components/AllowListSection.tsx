import { useEffect, useMemo, useState } from "react";
import { m } from "framer-motion";
import {
  Check,
  Github,
  ShieldCheck,
  ShieldPlus,
  Sparkles,
  X,
} from "lucide-react";
import type { GithubRepoPreview } from "../api";

type AllowListSectionProps = {
  allowedReposText: string;
  onChange: (value: string) => void;
  onSave: () => Promise<void> | void;
  githubRepos: GithubRepoPreview[];
  loadingRepos: boolean;
};

export default function AllowListSection({
  allowedReposText,
  onChange,
  onSave,
  githubRepos,
  loadingRepos,
}: AllowListSectionProps) {
  const [draftRepo, setDraftRepo] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "synced">("idle");

  const chips = useMemo(
    () =>
      allowedReposText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [allowedReposText],
  );

  const repoIndex = useMemo(() => {
    const map = new Map<string, GithubRepoPreview[]>();
    githubRepos.forEach((repo) => {
      const full = String(repo.fullName || "").toLowerCase().trim();
      const name = String(repo.name || "").toLowerCase().trim();
      if (full) map.set(full, [repo]);
      if (name) {
        const existing = map.get(name) || [];
        existing.push(repo);
        map.set(name, existing);
      }
    });
    return map;
  }, [githubRepos]);

  useEffect(() => {
    if (saveState !== "synced") return;
    const timeoutId = window.setTimeout(() => setSaveState("idle"), 1400);
    return () => window.clearTimeout(timeoutId);
  }, [saveState]);

  function setChips(next: string[]) {
    onChange(next.join("\n"));
  }

  function addRepo(raw: string) {
    const value = raw.trim();
    if (!value) return;
    if (chips.some((chip) => chip.toLowerCase() === value.toLowerCase())) {
      setDraftRepo("");
      return;
    }
    setChips([...chips, value]);
    setDraftRepo("");
  }

  function removeRepo(target: string) {
    setChips(chips.filter((chip) => chip !== target));
  }

  async function handleSave() {
    setSaveState("saving");
    await Promise.resolve(onSave());
    setSaveState("synced");
  }

  const placeholderText = "e.g., facebook/react, your-org/private-repo";

  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="grid w-full gap-5 rounded-[2.1rem] border border-white/15 bg-white/8 p-6 text-slate-200 backdrop-blur-xl lg:grid-cols-[1.25fr_0.75fr] md:p-7"
    >
      <div>
        <h2 className="inline-flex items-center gap-2 text-3xl font-black tracking-[-0.03em] text-slate-100">
          <ShieldPlus className="h-6 w-6 text-cyan-300" />
          Allowed Repos
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-300">
          Add repositories as controlled scope chips. Agents can only execute repo
          actions against this verified set.
        </p>

        <div className="glass-panel mt-5 rounded-3xl border border-white/10 bg-black/35 p-4">
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => {
              const key = chip.toLowerCase();
              const lookup = repoIndex.get(key) || [];
              const verified = lookup.length > 0;
              const resolved = verified ? lookup[0] : null;
              return (
                <div
                  key={chip}
                  className="w-full rounded-2xl border border-white/12 bg-white/5 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="inline-flex items-center gap-2 text-sm font-medium text-slate-100">
                      <Github className="h-4 w-4 text-cyan-300" />
                      {chip}
                    </div>
                    <div className="inline-flex items-center gap-2">
                      {verified ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/40 bg-emerald-300/15 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-emerald-100">
                          <Check className="h-3 w-3" />
                          Verified
                        </span>
                      ) : (
                        <span className="rounded-full border border-amber-300/40 bg-amber-300/15 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-amber-100">
                          Unverified
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeRepo(chip)}
                        className="rounded-full border border-white/20 p-1 text-slate-300 transition hover:text-white"
                        aria-label={`Remove ${chip}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {resolved ? (
                    <div className="mt-1 text-xs text-slate-400">
                      {typeof resolved.stargazersCount === "number"
                        ? `${resolved.stargazersCount.toLocaleString()} stars`
                        : "Repository detected"}
                      {resolved.description ? ` • ${resolved.description}` : ""}
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-slate-500">
                      No live match yet. Ensure this is owner/repo and linked to your GitHub account.
                    </div>
                  )}
                </div>
              );
            })}
            {!chips.length ? (
              <div className="rounded-xl border border-dashed border-white/15 px-3 py-2 text-sm text-slate-500">
                {placeholderText}
              </div>
            ) : null}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <input
              type="text"
              value={draftRepo}
              onChange={(e) => setDraftRepo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRepo(draftRepo);
                }
              }}
              className="w-full rounded-xl border border-white/15 bg-black/35 px-3 py-2 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-300"
              placeholder={placeholderText}
            />
            <m.button
              type="button"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              onClick={() => addRepo(draftRepo)}
              className="rounded-full border border-cyan-300/50 bg-cyan-300/15 px-4 py-2 text-sm font-semibold text-cyan-100"
            >
              Add
            </m.button>
          </div>

          <div className="mt-4">
            <m.button
              type="button"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              onClick={handleSave}
              disabled={saveState === "saving"}
              className="inline-flex items-center gap-2 rounded-full border border-cyan-200/40 bg-linear-to-r from-cyan-300 to-sky-300 px-6 py-2.5 text-sm font-black text-black shadow-[0_0_24px_rgba(64,224,255,0.28)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {saveState === "saving" ? "Syncing..." : saveState === "synced" ? "Policies Synced" : "Save Allow-list"}
              {saveState === "synced" ? <Check className="h-4 w-4" /> : null}
            </m.button>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="glass-panel rounded-3xl border border-emerald-300/20 bg-emerald-300/8 p-4">
          <div className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.12em] text-emerald-100">
            <ShieldCheck className="h-4 w-4 text-emerald-300 drop-shadow-[0_0_12px_rgba(52,211,153,0.45)]" />
            Active Scope
          </div>
          <p className="mt-2 text-sm text-emerald-50/90">
            Agents can only see these specific resources.
          </p>
          <p className="mt-2 text-xs uppercase tracking-widest text-emerald-100/80">
            Current Policy: Hard-Block on all other repositories.
          </p>
        </div>

        <div className="glass-panel rounded-3xl border border-white/10 bg-black/25 p-4">
          <div className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-slate-400">
            <Sparkles className="h-4 w-4 text-cyan-300" />
            Live Verification
          </div>
          <p className="mt-2 text-sm text-slate-300">
            {loadingRepos
              ? "Checking GitHub access and loading repository metadata..."
              : `Connected visibility: ${githubRepos.length} repositories detected from your linked GitHub identity.`}
          </p>
        </div>
      </div>
    </m.div>
  );
}
