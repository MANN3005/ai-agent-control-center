import { AgentStep, ToolDefinition } from "../types";
import { CF, FIELD_ALIASES } from "./fieldRegistry";

export interface ValidationResult {
  valid: boolean;
  missingField?: string;
  missingFieldQuestion?: string;
  stepIndex?: number;
}

function readValue(input: Record<string, any>, field: string) {
  const canonical = FIELD_ALIASES[field] ?? field;
  return input[canonical] ?? input[field];
}

function hasValue(value: any) {
  return !(value == null || value === "" || value === undefined);
}

function buildMissingFieldQuestion(
  field: string,
  toolName: string,
  existingInput: Record<string, any>,
): string {
  const questions: Record<string, string> = {
    [CF.ISSUE_NUMBER]: "Which issue number should I use?",
    [CF.REPO_NAME]: `Which repository? ${
      existingInput[CF.REPO_OWNER]
        ? `(I already have the owner: ${existingInput[CF.REPO_OWNER]})`
        : ""
    }`,
    [CF.BRANCH_NAME]: "What should the branch be named?",
    [CF.BASE_BRANCH]: "Which branch should this be based on?",
    [CF.PR_NUMBER]: "Which pull request number?",
    [CF.MESSAGE]: "What message should I send?",
    [CF.CHANNEL]: "Which channel should I send it to?",
    [CF.QUERY]: "What should I search for?",
  };

  return (
    questions[field] ||
    `I need a value for "${field}" to proceed with ${toolName}.`
  );
}

export function validateAllSteps(
  steps: AgentStep[],
  tools: ToolDefinition[],
): ValidationResult {
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const input = step.input && typeof step.input === "object" ? step.input : {};
    const tool = tools.find((t) => t.name === step.tool);

    const required = Array.isArray(tool?.inputSchema?.required)
      ? (tool!.inputSchema!.required as string[])
      : [];

    for (const requiredField of required) {
      const canonical = (FIELD_ALIASES[requiredField] ?? requiredField) as string;
      const value = readValue(input, requiredField);
      if (!hasValue(value)) {
        return {
          valid: false,
          missingField: canonical,
          missingFieldQuestion: buildMissingFieldQuestion(
            canonical,
            step.tool,
            input,
          ),
          stepIndex: i,
        };
      }
    }

    if (step.tool === "intent_manage_issue") {
      const action = String(readValue(input, CF.ACTION) || "").toLowerCase();
      if (action === "close" || action === "reopen" || action === "comment") {
        const issueNumber = readValue(input, CF.ISSUE_NUMBER);
        if (!hasValue(issueNumber)) {
          return {
            valid: false,
            missingField: CF.ISSUE_NUMBER,
            missingFieldQuestion: buildMissingFieldQuestion(
              CF.ISSUE_NUMBER,
              step.tool,
              input,
            ),
            stepIndex: i,
          };
        }
      }

      if (action === "create") {
        const title = readValue(input, CF.ISSUE_TITLE);
        if (!hasValue(title)) {
          return {
            valid: false,
            missingField: CF.ISSUE_TITLE,
            missingFieldQuestion: buildMissingFieldQuestion(
              CF.ISSUE_TITLE,
              step.tool,
              input,
            ),
            stepIndex: i,
          };
        }
      }

      if (action === "comment") {
        const comment = readValue(input, "comment");
        if (!hasValue(comment)) {
          return {
            valid: false,
            missingField: "comment",
            missingFieldQuestion: buildMissingFieldQuestion(
              "comment",
              step.tool,
              input,
            ),
            stepIndex: i,
          };
        }
      }
    }
  }

  return { valid: true };
}
