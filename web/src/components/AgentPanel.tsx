import type {
  AgentMessage,
  AgentPayload,
  AgentPlanStep,
  AgentRun,
  AgentStep,
  AgentTrace,
  Issue,
  Pull,
  Repo,
} from "../types";

type StepUpInfo = {
  active: boolean;
  expiresAt: string | null;
  remainingText: string;
};

type AgentPanelProps = {
  agentTask: string;
  onTaskChange: (value: string) => void;
  onSend: () => void;
  agentRun: AgentRun | null;
  agentMessages: AgentMessage[];
  agentSteps: AgentStep[];
  agentTrace: AgentTrace[];
  pendingApprovalStep?: AgentStep | null;
  pendingApprovalStatus: string | null;
  approvalError: string | null;
  onConfirm: () => void;
  onApprove: () => void;
  onAllowListRepo: (repo: string) => void;
  stepUpInfo: StepUpInfo;
  onStartStepUp: () => void;
};

function renderAgentOutput(step: AgentStep) {
  const payload = step?.result?.result as AgentPayload | undefined;
  if (!payload) return null;

  if (Array.isArray(payload.issues)) {
    return (
      <div className="table-wrap">
        <table cellPadding={6} className="table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th align="left">#</th>
              <th align="left">Title</th>
              <th align="left">State</th>
              <th align="left">Link</th>
            </tr>
          </thead>
          <tbody>
            {payload.issues.map((issue: Issue) => (
              <tr key={issue.id}>
                <td>{issue.number}</td>
                <td>{issue.title}</td>
                <td>{issue.state}</td>
                <td>
                  <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (Array.isArray(payload.repos)) {
    return (
      <div className="table-wrap">
        <table cellPadding={6} className="table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th align="left">Name</th>
              <th align="left">Owner</th>
              <th align="left">Private</th>
              <th align="left">Updated</th>
              <th align="left">Link</th>
            </tr>
          </thead>
          <tbody>
            {payload.repos.map((repo: Repo) => (
              <tr key={repo.id}>
                <td>{repo.fullName ?? repo.name}</td>
                <td>{repo.owner ?? ""}</td>
                <td>{String(repo.private)}</td>
                <td>{repo.updatedAt}</td>
                <td>
                  <a href={repo.htmlUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (Array.isArray(payload.pulls)) {
    return (
      <div className="table-wrap">
        <table cellPadding={6} className="table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th align="left">#</th>
              <th align="left">Title</th>
              <th align="left">State</th>
              <th align="left">Draft</th>
              <th align="left">Link</th>
            </tr>
          </thead>
          <tbody>
            {payload.pulls.map((pull: Pull) => (
              <tr key={pull.id}>
                <td>{pull.number}</td>
                <td>{pull.title}</td>
                <td>{pull.state}</td>
                <td>{pull.draft ? "Yes" : "No"}</td>
                <td>
                  <a href={pull.htmlUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (payload.issue) {
    return (
      <div className="table-wrap">
        <table cellPadding={6} className="table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th align="left">#</th>
              <th align="left">Title</th>
              <th align="left">State</th>
              <th align="left">Link</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{payload.issue.number}</td>
              <td>{payload.issue.title}</td>
              <td>{payload.issue.state}</td>
              <td>
                <a href={payload.issue.htmlUrl} target="_blank" rel="noreferrer">
                  Open
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  return null;
}

export default function AgentPanel({
  agentTask,
  onTaskChange,
  onSend,
  agentRun,
  agentMessages,
  agentSteps,
  agentTrace,
  pendingApprovalStep,
  pendingApprovalStatus,
  approvalError,
  onConfirm,
  onApprove,
  onAllowListRepo,
  stepUpInfo,
  onStartStepUp,
}: AgentPanelProps) {
  const chatMessages: AgentMessage[] = agentMessages.length
    ? agentMessages
    : [{ role: "agent", text: "Say hello to start." }];

  const allowListStep = [...agentSteps]
    .reverse()
    .find((step) => step.reason === "Repo not allow-listed" && step.input?.repo);
  const allowListRepo = allowListStep?.input?.repo as string | undefined;
  const approvalPreview = (pendingApprovalStep?.result as any)?.preview as
    | { tool?: string; input?: Record<string, unknown> }
    | undefined;

  return (
    <div className="section-card">
      <h2>Agent</h2>
      <p>
        Everything is driven by messages. Ask the agent to list repos, issues, or PRs, create issues,
        or post summaries to Slack. Approvals are handled by replying here when prompted.
      </p>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="meta-label">Step-up Session</div>
        <div style={{ marginTop: 6 }}>
          <div>
            Status: <b>{stepUpInfo.active ? "Active" : "Inactive"}</b>
          </div>
          <div>
            Expires: {stepUpInfo.expiresAt ? new Date(stepUpInfo.expiresAt).toLocaleTimeString() : "-"}
          </div>
          <div>Remaining: {stepUpInfo.remainingText}</div>
          <div style={{ marginTop: 8 }}>
            <button onClick={onStartStepUp}>Start Step-up</button>
          </div>
        </div>
      </div>

      <div className="chat">
        <div className="chat-log">
          {chatMessages.map((msg: AgentMessage, idx: number) => (
            <div key={`${msg.role}-${idx}`} className={`chat-bubble ${msg.role}`}>
              <div className="chat-role">{msg.role}</div>
              <div>{msg.text}</div>
            </div>
          ))}
        </div>
        {allowListRepo ? (
          <div className="card" style={{ marginTop: 10 }}>
            <div className="meta-label">Repo not allow-listed</div>
            <div style={{ marginTop: 6 }}>{allowListRepo}</div>
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => onAllowListRepo(allowListRepo)}>
                Add to allow-list
              </button>
            </div>
          </div>
        ) : null}
        {approvalPreview ? (
          <div className="card" style={{ marginTop: 10 }}>
            <div className="meta-label">Approval preview</div>
            <div style={{ marginTop: 6 }}>
              <div>
                Tool: <b>{approvalPreview.tool || "-"}</b>
              </div>
              <div style={{ marginTop: 6, color: "var(--muted)", fontSize: 12 }}>
                {JSON.stringify(approvalPreview.input || {}, null, 2)}
              </div>
            </div>
          </div>
        ) : null}
        <div className="chat-input-row">
          <textarea
            className="input textarea"
            value={agentTask}
            onChange={(e) => onTaskChange(e.target.value)}
            rows={3}
            placeholder="Ask the agent to do something..."
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          <button onClick={onSend}>Send</button>
        </div>
        {agentRun?.status === "WAITING_APPROVAL" && (
          <div style={{ marginTop: 12 }}>
            {pendingApprovalStatus === "confirm_required" ? (
              <button onClick={onConfirm}>Confirm & Continue</button>
            ) : (
              <button onClick={onApprove}>Approve & Continue</button>
            )}
            {approvalError ? (
              <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted)" }}>
                {approvalError}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {agentRun && (
        <div className="card">
          <h3>Plan & Trace</h3>
          <div className="agent-summary">
            <div>
              <div className="meta-label">Status</div>
              <div className="meta-value">{agentRun.status}</div>
            </div>
            <div>
              <div className="meta-label">Step</div>
              <div className="meta-value">{agentRun.currentStep}</div>
            </div>
            {agentRun.lastError && (
              <div>
                <div className="meta-label">Last Error</div>
                <div className="meta-value">{agentRun.lastError}</div>
              </div>
            )}
          </div>

          {Array.isArray(agentRun.plan) && agentRun.plan.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h4>Plan</h4>
              <div className="table-wrap">
                <table cellPadding={6} className="table">
                  <thead>
                    <tr>
                      <th align="left">Step</th>
                      <th align="left">Tool</th>
                      <th align="left">Input</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentRun.plan.map((step: AgentPlanStep, idx: number) => (
                      <tr key={`${step.tool}-${idx}`}>
                        <td>{idx + 1}</td>
                        <td>{step.tool}</td>
                        <td>{JSON.stringify(step.input)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {agentTrace.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h4>Thought Log</h4>
              <div className="trace-log">
                {agentTrace.map((item: AgentTrace, idx: number) => (
                  <div key={`${item.type}-${idx}`} className={`trace-item ${item.type}`}>
                    <div className="trace-type">{item.type}</div>
                    <div>{item.text}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {agentSteps.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h4>Timeline</h4>
              <div className="table-wrap">
                <table cellPadding={6} className="table">
                  <thead>
                    <tr>
                      <th align="left">Step</th>
                      <th align="left">Tool</th>
                      <th align="left">Status</th>
                      <th align="left">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentSteps.map((step: AgentStep, idx: number) => (
                      <tr key={`${step.tool}-${idx}`}>
                        <td>{idx + 1}</td>
                        <td>{step.tool}</td>
                        <td>{step.status}</td>
                        <td>{step.reason ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {agentSteps.map((step: AgentStep, idx: number) => (
                <div key={`output-${idx}`} style={{ marginTop: 12 }}>
                  <div className="meta-label">Step {idx + 1} output</div>
                  {renderAgentOutput(step) || (
                    <div style={{ color: "var(--muted)" }}>No output.</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
