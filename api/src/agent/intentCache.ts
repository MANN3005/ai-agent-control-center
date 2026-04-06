import crypto from "crypto";
import { AgentStep } from "../types";

export type CachedIntentPlan = {
  steps: AgentStep[];
  question: string;
};

type IntentCacheEntry = {
  expiresAt: number;
  value: CachedIntentPlan;
};

const INTENT_CACHE = new Map<string, IntentCacheEntry>();
const DEFAULT_TTL_MS = 60_000;

function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${parts.join(",")}}`;
}

export function makeIntentCacheKey(
  task: string,
  context: Record<string, any>,
  toolNames: string[],
) {
  const payload = `${task}::${stableStringify(context)}::${toolNames.sort().join(",")}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function getCachedIntentPlan(key: string): CachedIntentPlan | null {
  const now = Date.now();
  const hit = INTENT_CACHE.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    INTENT_CACHE.delete(key);
    return null;
  }
  return hit.value;
}

export function setCachedIntentPlan(
  key: string,
  value: CachedIntentPlan,
  ttlMs = DEFAULT_TTL_MS,
) {
  INTENT_CACHE.set(key, {
    expiresAt: Date.now() + Math.max(1_000, ttlMs),
    value,
  });
}

export function clearIntentCache() {
  INTENT_CACHE.clear();
}
