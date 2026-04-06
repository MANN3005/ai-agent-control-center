import { executeToolWithPolicy } from "./engine";
import type { FanOutAggregate } from "../types";

export type SettledResult = PromiseSettledResult<{
  repo: string;
  statusCode: number;
  body: any;
  durationMs: number;
}>;

type SettledFailureReason = {
  repo: string;
  reason: string;
  statusCode?: number;
  body?: any;
  durationMs?: number;
};

function asErrorMessage(value: unknown) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "Unknown error";
}

function isResponseFailure(statusCode: number, body: any) {
  if (statusCode >= 400) return true;
  const status = String(body?.status || "").toLowerCase();
  return status === "denied" || status === "error";
}

export function aggregateResults(results: SettledResult[]): FanOutAggregate {
  const successes: FanOutAggregate["successes"] = [];
  const failures: FanOutAggregate["failures"] = [];

  for (const item of results) {
    if (item.status === "fulfilled") {
      const { repo, statusCode, body, durationMs } = item.value;
      if (isResponseFailure(statusCode, body)) {
        failures.push({
          repo,
          statusCode,
          body,
          durationMs,
          reason: String(body?.reason || body?.status || "Request failed"),
        });
      } else {
        successes.push({ repo, statusCode, body, durationMs });
      }
      continue;
    }

    const reasonData = item.reason as SettledFailureReason;
    failures.push({
      repo: reasonData?.repo || "unknown",
      statusCode: reasonData?.statusCode,
      body: reasonData?.body,
      durationMs: reasonData?.durationMs,
      reason: reasonData?.reason || asErrorMessage(item.reason),
    });
  }

  const total = results.length;
  const successCount = successes.length;
  const failureCount = failures.length;

  return {
    total,
    successCount,
    failureCount,
    successes,
    failures,
    summary:
      failureCount === 0
        ? `All ${successCount}/${total} repositories completed successfully.`
        : `${successCount}/${total} repositories succeeded; ${failureCount} failed.`,
  };
}

export async function fanOutToolCall(
  userId: string,
  requestId: string,
  tool: string,
  params: Record<string, any>,
  repos: string[],
  approval: { confirmed: boolean; stepUpId: string | null } = {
    confirmed: false,
    stepUpId: null,
  },
): Promise<FanOutAggregate> {
  const results = await Promise.allSettled(
    repos.map(async (repo) => {
      const startedAt = Date.now();
      try {
        const input = { ...params, repo };
        const response = await executeToolWithPolicy(
          userId,
          `${requestId}:${repo}`,
          tool,
          input,
          approval,
        );

        return {
          repo,
          statusCode: response.statusCode,
          body: response.body,
          durationMs: Date.now() - startedAt,
        };
      } catch (err: any) {
        const reason: SettledFailureReason = {
          repo,
          statusCode:
            typeof err?.statusCode === "number" ? err.statusCode : undefined,
          body: err?.body,
          durationMs: Date.now() - startedAt,
          reason: err?.message || "Tool call failed",
        };
        throw reason;
      }
    }),
  );

  return aggregateResults(results);
}
