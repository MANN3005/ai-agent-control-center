export type Policy = {
  toolName: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  mode: "AUTO" | "CONFIRM" | "STEP_UP";
};

export type Me = {
  userId: string;
  hasGithub: boolean;
  hasSlack: boolean;
};

export type AuditEntry = {
  id: string;
  createdAt: string;
  requestId?: string | null;
  toolName: string;
  decision: string;
  executed: boolean;
  reason?: string | null;
  reasoning?: string | null;
  inputJson?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
};

export type LlmAuditEntry = {
  id: string;
  createdAt: string;
  callType: "plan" | "recovery" | "reply" | "policy";
  model: string;
  requestId?: string | null;
  runId?: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
};

export type AgentMessage = {
  role: "user" | "agent";
  text: string;
};

export type AgentTrace = {
  type: string;
  text: string;
};

export type AgentPlanStep = {
  tool: string;
  input: Record<string, unknown>;
};

export type AgentStepResult = {
  status?: string;
  result?: AgentPayload;
  [key: string]: unknown;
} | null;

export type AgentStep = {
  tool: string;
  status: string;
  reason?: string | null;
  input?: Record<string, unknown>;
  result?: AgentStepResult;
};

export type AgentRun = {
  id: string;
  status: string;
  currentStep: number;
  lastError?: string | null;
  plan?: AgentPlanStep[];
  trace?: AgentTrace[];
  steps?: AgentStep[];
  messages?: AgentMessage[];
};

export type Issue = {
  id: string | number;
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
};

export type Pull = {
  id: string | number;
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  htmlUrl: string;
};

export type Repo = {
  id: string | number;
  fullName?: string;
  name?: string;
  owner?: string;
  private?: boolean;
  updatedAt?: string;
  htmlUrl: string;
};

export type AgentPayload = {
  issues?: Issue[];
  repos?: Repo[];
  pulls?: Pull[];
  issue?: Issue;
};

export type IdentityEntry = {
  provider: string | null;
  connection: string | null;
  userId: string | null;
  hasAccessToken: boolean;
};

export type AccessToolState = {
  name: string;
  domain: string;
  description: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  mode: "AUTO" | "CONFIRM" | "STEP_UP";
  providerConnected: boolean;
  requiresAllowedResource: boolean;
  hasRequiredAllowList: boolean;
  requiresStepUp: boolean;
  canExecuteNow: boolean;
  recentDecisions: Array<
    "ALLOWED" | "DENIED" | "CONFIRM_REQUIRED" | "STEP_UP_REQUIRED" | "ERROR"
  >;
  lastAuthorizedAt: string | null;
  riskScore: number;
  riskBand: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskReasons: string[];
  policyEvaluations: Array<{
    rule: string;
    result: "PASS" | "FAIL";
    detail: string;
  }>;
  blockedReasons: string[];
};

export type AccessTokenHealth = {
  provider: string | null;
  connection: string | null;
  domain: "github" | "slack" | "google" | "other";
  hasAccessToken: boolean;
  expiresAt: string | null;
  ttlMs: number | null;
  vaultStatus: "protected_by_auth0_vault" | "not_available";
  isolationStatus: "token_isolated" | "not_linked";
};

export type AccessPolicyDecision = {
  id: string;
  at: string;
  toolName: string;
  decision:
    | "ALLOWED"
    | "DENIED"
    | "CONFIRM_REQUIRED"
    | "STEP_UP_REQUIRED"
    | "ERROR";
  reason: string;
  requestId: string;
};

export type AccessState = {
  userId: string;
  now: string;
  identities: {
    hasGithub: boolean;
    hasSlack: boolean;
    linked: Array<{
      provider: string | null;
      connection: string | null;
      providerUserId: string | null;
      hasAccessToken: boolean;
    }>;
  };
  resources: {
    allowedRepos: string[];
    allowedRepoCount: number;
    verifiedAllowedRepos: string[];
    verifiedAllowedRepoCount: number;
    unverifiedAllowedRepos: string[];
    repoVerificationStatus: "verified" | "unavailable" | "not_checked";
    breakdown: Array<{
      resourceId: string;
      level: "full_access" | "metadata_only" | "blocked";
      label: string;
      permissions: {
        read: boolean;
        write: boolean;
        delete: boolean;
      };
    }>;
  };
  tokenHealth: AccessTokenHealth[];
  stepUp: {
    active: boolean;
    id: string | null;
    expiresAt: string | null;
    remainingMs: number;
  };
  tools: AccessToolState[];
  policyDecisions: AccessPolicyDecision[];
  agentHealth: {
    status: "STANDBY" | "DISARMED";
    disarmedAt: string | null;
    reason: string | null;
  };
};
