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
