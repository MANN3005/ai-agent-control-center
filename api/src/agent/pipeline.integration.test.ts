import assert from "node:assert/strict";
import test from "node:test";
import { extractFieldsFromText } from "./contextExtractor";
import { CF, normalizeFields, resolveRepoFields } from "./fieldRegistry";

test("repro: delete issue #1 in owner/repo produces canonical payload", () => {
  const userInput = "delete issue #1 in h202201297/IT-314-Labs";

  const llmStepInput = {
    action: "close",
    repo: "h202201297/IT-314-Labs",
  };

  const normalized = resolveRepoFields(normalizeFields(llmStepInput));
  const textContext = resolveRepoFields(
    normalizeFields(extractFieldsFromText(userInput) as Record<string, any>),
  );

  const merged = { ...normalized } as Record<string, any>;
  for (const [key, value] of Object.entries(textContext)) {
    if (merged[key] == null && value != null) {
      merged[key] = value;
    }
  }

  const finalInput = resolveRepoFields(normalizeFields(merged));

  assert.deepEqual(finalInput, {
    action: "close",
    owner: "h202201297",
    repo: "IT-314-Labs",
    issue_number: 1,
  });
});

test("field name drift normalizes to canonical fields", () => {
  const input = {
    issueNumbers: 42,
    repoName: "my-app",
  };

  const normalized = normalizeFields(input);
  assert.equal(normalized[CF.ISSUE_NUMBER], 42);
  assert.equal(normalized[CF.REPO_NAME], "my-app");
});

test("repo slash split resolves owner + repo", () => {
  const input = {
    repo: "h202201297/IT-314-Labs",
  };

  const resolved = resolveRepoFields(normalizeFields(input));
  assert.equal(resolved[CF.REPO_OWNER], "h202201297");
  assert.equal(resolved[CF.REPO_NAME], "IT-314-Labs");
});
