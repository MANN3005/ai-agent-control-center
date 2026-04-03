export type ToolName = string;

export type AgentTask = {
  requestId: string;
  task: string;
  context?: Record<string, any>;
  repos?: string[];
};

export type ToolDefinition = {
  name: ToolName;
  domain?: "github" | "slack";
  needsRepo: boolean;
  defaultRisk: "LOW" | "MEDIUM" | "HIGH";
  defaultMode: "AUTO" | "CONFIRM" | "STEP_UP";
  description?: string;
  inputSchema?: Record<string, any> | null;
  handler?: (userId: string, input: Record<string, any>) => Promise<any>;
};

export type AgentRunStatus =
  | "PLANNING"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "NEEDS_INPUT"
  | "COMPLETED"
  | "ERROR";

export type AgentStepStatus =
  | "PLANNED"
  | "EXECUTED"
  | "ERROR"
  | "APPROVAL_REQUIRED";

export type AgentStep = { tool: ToolName; input: Record<string, any> };

export type AgentStepRecord = AgentStep & {
  status: AgentStepStatus;
  result?: any;
  reason?: string;
  retries: number;
};

export type AgentTraceItem = {
  type: "thought" | "action" | "status";
  text: string;
  at: string;
};

export type AgentRun = {
  id: string;
  userId: string;
  task: string;
  context: Record<string, any>;
  status: AgentRunStatus;
  plan: AgentStep[];
  steps: AgentStepRecord[];
  currentStep: number;
  pendingStepIndex: number | null;
  lastError?: string;
  messages: Array<{ role: "user" | "agent"; text: string }>;
  trace: AgentTraceItem[];
};

export type FanOutSuccess = {
  repo: string;
  statusCode: number;
  body: any;
  durationMs: number;
};

export type FanOutFailure = {
  repo: string;
  reason: string;
  statusCode?: number;
  body?: any;
  durationMs?: number;
};

export type FanOutAggregate = {
  total: number;
  successCount: number;
  failureCount: number;
  successes: FanOutSuccess[];
  failures: FanOutFailure[];
  summary: string;
};
