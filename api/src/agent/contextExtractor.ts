import { CF } from "./fieldRegistry";

export function extractFieldsFromText(
  text: string,
): Partial<Record<string, any>> {
  const extracted: Record<string, any> = {};

  const issueMatch = text.match(/(?:issue\s*)?#(\d+)/i) ?? text.match(/issue\s+(\d+)/i);
  if (issueMatch) {
    extracted[CF.ISSUE_NUMBER] = parseInt(issueMatch[1], 10);
  }

  const prMatch = text.match(/(?:PR|pull\s*request)\s*#?(\d+)/i);
  if (prMatch) {
    extracted[CF.PR_NUMBER] = parseInt(prMatch[1], 10);
  }

  const repoMatch = text.match(/\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\b/);
  if (repoMatch) {
    extracted[CF.REPO_OWNER] = repoMatch[1];
    extracted[CF.REPO_NAME] = repoMatch[2];
  }

  const branchMatch =
    text.match(/branch\s+(?:named\s+)?["']?([a-zA-Z0-9/_.-]+)["']?/i) ??
    text.match(/["']([a-zA-Z0-9/_.-]+)["']\s+branch/i);
  if (branchMatch) {
    extracted[CF.BRANCH_NAME] = branchMatch[1];
  }

  if (/\bdelete\b/i.test(text) && /\bissue\b/i.test(text)) {
    extracted[CF.ACTION] = "close";
  }
  if (/\breopen\b/i.test(text) && /\bissue\b/i.test(text)) {
    extracted[CF.ACTION] = "reopen";
  }

  return extracted;
}
