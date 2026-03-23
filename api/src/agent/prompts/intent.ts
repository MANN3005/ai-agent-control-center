import { IntentCandidate } from "../intentRouter";

function slimContext(context: Record<string, any>) {
  const out: Record<string, any> = {};
  const entries = Object.entries(context || {}).slice(0, 18);
  for (const [key, value] of entries) {
    if (typeof value === "string") out[key] = value.slice(0, 120);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 8);
  }
  return out;
}

export function buildIntentPrompt(
  task: string,
  context: Record<string, any>,
  candidates: IntentCandidate[],
) {
  const candidateLines = candidates.map((candidate, index) => {
    const req = candidate.requiredFields.join(", ") || "none";
    const opt = candidate.optionalFields.join(", ") || "none";
    return `${index + 1}. ${candidate.toolName} | required: ${req} | optional: ${opt} | note: ${candidate.description}`;
  });

  const system =
    "You are an intent router for an agent. Return ONLY JSON with keys: tool, input, question. " +
    "Choose exactly one tool from candidates. If required info is missing, set tool to empty string and provide a specific question.";

  const user = JSON.stringify({
    task,
    context: slimContext(context),
    candidates: candidateLines,
  });

  return { system, user };
}
