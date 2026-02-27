import { useEffect, useMemo, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import {
  getMe,
  getPolicies,
  putPolicies,
  getAllowedRepos,
  putAllowedRepos,
  startStepUp,
  executeTool,
  runAgent,
  continueAgent,
  getAudit,
} from "./api";
import "./App.css";

type Policy = {
  toolName: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  mode: "AUTO" | "CONFIRM" | "STEP_UP";
};

const DEFAULTS: Policy[] = [
  { toolName: "list_repos", riskLevel: "LOW", mode: "AUTO" },
  { toolName: "list_issues", riskLevel: "LOW", mode: "AUTO" },
  { toolName: "create_issue", riskLevel: "MEDIUM", mode: "CONFIRM" },
  { toolName: "close_issue", riskLevel: "HIGH", mode: "STEP_UP" },
];

function uuid() {
  return crypto.randomUUID();
}

export default function App() {
  const { isAuthenticated, user, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0();
  const navigate = useNavigate();

  const [me, setMe] = useState<any>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [allowedReposText, setAllowedReposText] = useState("");
  const [stepUpId, setStepUpId] = useState<string | null>(null);
  const [lastExec, setLastExec] = useState<any>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [repoInput, setRepoInput] = useState("");
  const [listState, setListState] = useState<"open" | "closed" | "all">("open");
  const [createTitle, setCreateTitle] = useState("");
  const [createBody, setCreateBody] = useState("");
  const [closeIssueNumber, setCloseIssueNumber] = useState("");
  const [agentTask, setAgentTask] = useState("");
  const [agentResult, setAgentResult] = useState<any>(null);
  const [agentRequestId, setAgentRequestId] = useState<string | null>(null);

  async function getApiToken() {
    return getAccessTokenSilently({
      authorizationParams: { audience: "https://control-center-api" },
    });
  }

  async function refresh() {
    setLoading(true);

    if (!isAuthenticated) {
      setMe(null);
      setPolicies([]);
      setAllowedReposText("");
      setAudit([]);
      setLastExec(null);
      setStepUpId(null);
      setLoading(false);
      return;
    }

    const accessToken = await getApiToken();

    const [m, p, repos, logs] = await Promise.all([
      getMe(accessToken),
      getPolicies(accessToken),
      getAllowedRepos(accessToken),
      getAudit(accessToken, 25),
    ]);

    setMe(m);
    setPolicies((p?.length ? p : DEFAULTS) as Policy[]);
    setAllowedReposText(((repos ?? []) as string[]).join("\n"));
    setAudit(logs ?? []);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  async function savePolicies() {
    const accessToken = await getApiToken();
    const updated = await putPolicies(accessToken, policies);
    setPolicies(updated);
    await refresh();
  }

  async function saveAllowedRepos() {
    const accessToken = await getApiToken();

    const repos = allowedReposText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    await putAllowedRepos(accessToken, repos);
    await refresh();
  }

  async function doStepUp() {
    const accessToken = await getApiToken();
    const r = await startStepUp(accessToken);
    setStepUpId(r.stepUpId);
    await refresh();
    return r.stepUpId as string;
  }

  async function runTool(
    tool: "list_repos" | "list_issues" | "create_issue" | "close_issue",
    input: Record<string, any>
  ) {
    const accessToken = await getApiToken();

    const r = await executeTool(accessToken, {
      requestId: uuid(),
      tool,
      input,
      approval: { confirmed: false, stepUpId },
    });

    setLastExec(r);
    await refresh();
  }

  async function runToolAndGo(
    tool: "list_repos" | "list_issues" | "create_issue" | "close_issue",
    input: Record<string, any>
  ) {
    await runTool(tool, input);
    navigate("/tools");
  }

  function goToToolsWithRepoHint() {
    navigate("/tools");
  }

  async function approveLast(preview: { tool: any; input: any }) {
    const accessToken = await getApiToken();

    const r = await executeTool(accessToken, {
      requestId: uuid(),
      tool: preview.tool,
      input: preview.input,
      approval: { confirmed: true, stepUpId },
    });

    setLastExec(r);
    await refresh();
  }

  async function runAgentFlow() {
    const accessToken = await getApiToken();
    const issueNumber = Number(closeIssueNumber);
    const requestId = uuid();

    const context: Record<string, any> = {
      repo: repoInput || undefined,
      state: listState,
      title: createTitle || undefined,
      body: createBody || undefined,
      issueNumber: Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : undefined,
    };

    const r = await runAgent(accessToken, {
      requestId,
      task: agentTask,
      context,
    });

    setAgentRequestId(requestId);
    setAgentResult(r);
  }

  async function continueAgentFlow() {
    if (!agentResult || !agentRequestId) return;
    const accessToken = await getApiToken();
    const stepIndex = Number(agentResult.stepIndex ?? -1);
    const steps = Array.isArray(agentResult.steps) ? agentResult.steps : [];
    const needsStepUp = agentResult.response?.status === "step_up_required";
    let currentStepUpId = stepUpId;

    if (needsStepUp && !currentStepUpId) {
      currentStepUpId = await doStepUp();
    }

    const r = await continueAgent(accessToken, {
      requestId: agentRequestId,
      stepIndex,
      steps,
      approval: { confirmed: true, stepUpId: currentStepUpId },
    });

    setAgentResult(r);
  }

  const authProvider = user?.sub?.split("|")[0];
  const showConnectGithub =
    isAuthenticated && authProvider !== "github" && me && !me.hasGithub;
  const agentSteps = Array.isArray(agentResult?.steps) ? agentResult.steps : [];
  const agentResults = Array.isArray(agentResult?.results) ? agentResult.results : [];

  const loginCard = (
    <div className="card">
      <h2>Welcome</h2>
      <p>Please log in to view and manage policies.</p>
    </div>
  );

  const userBadge = (
    <div className="card inline-card">
      <div>User: <b>{me?.userId}</b></div>
    </div>
  );

  const allowListSection = (
    <div className="section-card">
      <h2>Allowed Repos (Allow-list)</h2>
      <p>Enter one repo per line (format: <code>owner/repo</code>). Repo-scoped tools will be denied unless allow-listed.</p>
      <textarea
        value={allowedReposText}
        onChange={(e) => setAllowedReposText(e.target.value)}
        rows={6}
        className="input textarea"
        placeholder="e.g.\nocto-org/octo-repo"
      />
      <div style={{ marginTop: 8 }}>
        <button onClick={saveAllowedRepos}>Save Allowed Repos</button>
      </div>
    </div>
  );

  const policiesSection = (
    <div className="section-card">
      <h2>Tool Policies</h2>
      <table cellPadding={10} className="table">
        <thead>
          <tr>
            <th align="left">Tool</th>
            <th align="left">Risk</th>
            <th align="left">Mode</th>
          </tr>
        </thead>
        <tbody>
          {policies.map((p, idx) => (
            <tr key={p.toolName}>
              <td>{p.toolName}</td>
              <td>
                <select
                  className="select"
                  value={p.riskLevel}
                  onChange={(e) => {
                    const next = [...policies];
                    next[idx] = { ...p, riskLevel: e.target.value as any };
                    setPolicies(next);
                  }}
                >
                  <option>LOW</option>
                  <option>MEDIUM</option>
                  <option>HIGH</option>
                </select>
              </td>
              <td>
                <select
                  className="select"
                  value={p.mode}
                  onChange={(e) => {
                    const next = [...policies];
                    next[idx] = { ...p, mode: e.target.value as any };
                    setPolicies(next);
                  }}
                >
                  <option>AUTO</option>
                  <option>CONFIRM</option>
                  <option>STEP_UP</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 16 }}>
        <button onClick={savePolicies}>Save Policies</button>
        <button onClick={refresh} style={{ marginLeft: 8 }}>
          Reload
        </button>
      </div>
    </div>
  );

  const toolSection = (
    <div className="section-card">
      <h2>Tool Execution Test</h2>
      <p>
        Current step-up session: <b>{stepUpId ?? "none"}</b>
        <button onClick={doStepUp} style={{ marginLeft: 8 }}>
          Start Step-up (2 min)
        </button>
      </p>

      <div className="form-grid">
        <label>
          Repo (owner/repo)
          <input
            className="input"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="e.g. octo-org/octo-repo"
          />
        </label>

        <label>
          List issues state
          <select
            className="select"
            value={listState}
            onChange={(e) => setListState(e.target.value as any)}
          >
            <option value="open">open</option>
            <option value="closed">closed</option>
            <option value="all">all</option>
          </select>
        </label>

        <label>
          Create issue title
          <input className="input" value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} />
        </label>

        <label>
          Create issue body
          <textarea
            className="input textarea"
            value={createBody}
            onChange={(e) => setCreateBody(e.target.value)}
            rows={4}
          />
        </label>

        <label>
          Close issue number
          <input
            className="input"
            value={closeIssueNumber}
            onChange={(e) => setCloseIssueNumber(e.target.value)}
            placeholder="e.g. 123"
          />
        </label>
      </div>

      <div className="button-row">
        <button onClick={() => runTool("list_repos", {})}>Run: list_repos (AUTO)</button>
        <button onClick={() => runTool("list_issues", { repo: repoInput, state: listState })}>
          Run: list_issues (repo allow-list required)
        </button>
        <button
          onClick={() =>
            runTool("create_issue", {
              repo: repoInput,
              title: createTitle,
              body: createBody,
            })
          }
        >
          Run: create_issue (CONFIRM)
        </button>
        <button
          onClick={() =>
            runTool("close_issue", {
              repo: repoInput,
              issueNumber: Number(closeIssueNumber),
            })
          }
        >
          Run: close_issue (STEP_UP + CONFIRM)
        </button>
      </div>

      <p style={{ marginTop: 8 }}>
        ⚠️ Use a repo string you added to the allow-list.
      </p>

      {lastExec && (
        <div className="card">
          <h3>Last Execution Response</h3>
          <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(lastExec, null, 2)}</pre>

          {lastExec.status === "executed" && Array.isArray(lastExec.result?.issues) && (
            <div style={{ marginTop: 12 }}>
              <h4>Issues</h4>
              <table cellPadding={6} className="table">
                <thead>
                  <tr>
                    <th align="left">#</th>
                    <th align="left">Title</th>
                    <th align="left">State</th>
                    <th align="left">Link</th>
                  </tr>
                </thead>
                <tbody>
                  {lastExec.result.issues.map((issue: any) => (
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
          )}

          {lastExec.status === "executed" && Array.isArray(lastExec.result?.repos) && (
            <div style={{ marginTop: 12 }}>
              <h4>Repos</h4>
              <table cellPadding={6} className="table">
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
                  {lastExec.result.repos.map((repo: any) => (
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
          )}

          {lastExec.status === "executed" && lastExec.result?.issue && (
            <div style={{ marginTop: 12 }}>
              <h4>Issue</h4>
              <table cellPadding={6} className="table">
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
                    <td>{lastExec.result.issue.number}</td>
                    <td>{lastExec.result.issue.title}</td>
                    <td>{lastExec.result.issue.state}</td>
                    <td>
                      <a href={lastExec.result.issue.htmlUrl} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {lastExec.status === "confirm_required" && lastExec.preview && (
            <button onClick={() => approveLast(lastExec.preview)} style={{ marginTop: 8 }}>
              Approve & Execute
            </button>
          )}
        </div>
      )}
    </div>
  );

  function renderAgentOutput(result: any) {
    const payload = result?.response?.result;
    if (!payload) return null;

    if (Array.isArray(payload.issues)) {
      return (
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
            {payload.issues.map((issue: any) => (
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
      );
    }

    if (Array.isArray(payload.repos)) {
      return (
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
            {payload.repos.map((repo: any) => (
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
      );
    }

    if (payload.issue) {
      return (
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
      );
    }

    return null;
  }

  const agentSection = (
    <div className="section-card">
      <h2>Agent Runner (Groq)</h2>
      <p>Describe a task and the agent will plan tool calls and stop if approval is required.</p>
      <div className="form-grid">
        <label>
          Task
          <textarea
            className="input textarea"
            value={agentTask}
            onChange={(e) => setAgentTask(e.target.value)}
            rows={3}
            placeholder="e.g. List open issues and create a new issue summarizing findings"
          />
        </label>
        <button onClick={runAgentFlow} style={{ width: 160 }}>
          Run Agent
        </button>
      </div>

      {agentResult && (
        <div className="card">
          <h3>Agent Result</h3>
          <div className="agent-summary">
            <div>
              <div className="meta-label">Status</div>
              <div className="meta-value">{agentResult.status}</div>
            </div>
            {typeof agentResult.stepIndex === "number" && (
              <div>
                <div className="meta-label">Step</div>
                <div className="meta-value">{agentResult.stepIndex + 1}</div>
              </div>
            )}
            {agentResult.response?.reason && (
              <div>
                <div className="meta-label">Reason</div>
                <div className="meta-value">{agentResult.response.reason}</div>
              </div>
            )}
          </div>

          {agentSteps.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h4>Agent Plan</h4>
              <table cellPadding={6} className="table">
                <thead>
                  <tr>
                    <th align="left">Step</th>
                    <th align="left">Tool</th>
                    <th align="left">Input</th>
                  </tr>
                </thead>
                <tbody>
                  {agentSteps.map((step: any, idx: number) => (
                    <tr key={`${step.tool}-${idx}`}>
                      <td>{idx + 1}</td>
                      <td>{step.tool}</td>
                      <td>{JSON.stringify(step.input)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {agentResults.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h4>Agent Results</h4>
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
                  {agentResults.map((result: any, idx: number) => (
                    <tr key={`${result.step?.tool}-${idx}`}>
                      <td>{idx + 1}</td>
                      <td>{result.step?.tool}</td>
                      <td>{result.response?.status}</td>
                      <td>{result.response?.reason ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {agentResults.map((result: any, idx: number) => (
                <div key={`output-${idx}`} style={{ marginTop: 12 }}>
                  <div className="meta-label">Step {idx + 1} output</div>
                  {renderAgentOutput(result) || (
                    <div style={{ color: "var(--muted)" }}>No output.</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {agentResult.status === "approval_required" && (
            <div style={{ marginTop: 12 }}>
              <p>
                Approval required for step {agentResult.stepIndex + 1}: {agentResult.step?.tool}
              </p>
              {agentResult.response?.status === "step_up_required" && (
                <button onClick={doStepUp} style={{ marginRight: 8 }}>
                  Start Step-up (2 min)
                </button>
              )}
              <button
                onClick={continueAgentFlow}
                disabled={agentResult.response?.status === "step_up_required" && !stepUpId}
              >
                Approve & Continue
              </button>
            </div>
          )}

          <details style={{ marginTop: 12 }}>
            <summary>Show raw response</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(agentResult, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );

  const auditSection = (
    <div className="section-card">
      <h2>Audit Log (latest 25)</h2>
      <table cellPadding={8} className="table">
        <thead>
          <tr>
            <th align="left">Time</th>
            <th align="left">Tool</th>
            <th align="left">Decision</th>
            <th align="left">Executed</th>
            <th align="left">Reason</th>
          </tr>
        </thead>
        <tbody>
          {audit.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.createdAt).toLocaleString()}</td>
              <td>{a.toolName}</td>
              <td>{a.decision}</td>
              <td>{String(a.executed)}</td>
              <td>{a.reason ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const dashboardStats = useMemo(
    () => [
      { label: "Allowed Repos", value: allowedReposText ? allowedReposText.split("\n").filter(Boolean).length : 0 },
      { label: "Policies", value: policies.length },
      { label: "Audit Entries", value: audit.length },
      { label: "Step-up Active", value: stepUpId ? "Yes" : "No" },
    ],
    [allowedReposText, policies.length, audit.length, stepUpId],
  );

  if (loading) return <div className="app">Loading...</div>;

  const dashboard = (
    <div className="grid">
      <div className="section-card">
        <h2>Overview</h2>
        <div className="stat-grid">
          {dashboardStats.map((stat) => (
            <div key={stat.label} className="stat">
              <div className="stat-label">{stat.label}</div>
              <div className="stat-value">{stat.value}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="section-card">
        <h2>Quick Actions</h2>
        <div className="button-row">
          <button onClick={() => runToolAndGo("list_repos", {})}>List Repos</button>
          <button
            onClick={() =>
              repoInput
                ? runToolAndGo("list_issues", { repo: repoInput, state: listState })
                : goToToolsWithRepoHint()
            }
          >
            List Issues
          </button>
          <button onClick={doStepUp}>Start Step-up</button>
        </div>
        {!repoInput && (
          <div style={{ marginTop: 8, color: "var(--muted)" }}>
            Tip: set a repo in Tools before running List Issues.
          </div>
        )}
      </div>
      {userBadge}
    </div>
  );

  return (
    <div className="app shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="eyebrow">Secure Agentic Ops</div>
          <div className="brand-title">AI Agent Control Center</div>
        </div>
        <nav className="side-nav">
          <NavLink to="/">Home</NavLink>
          <NavLink to="/allow-list">Allow-list</NavLink>
          <NavLink to="/policies">Policies</NavLink>
          <NavLink to="/tools">Tools</NavLink>
          <NavLink to="/agent">Agent</NavLink>
          <NavLink to="/audit">Audit</NavLink>
        </nav>
      </aside>
      <div className="content">
        <header className="topbar">
          <div>
            <h1 className="title">Control Plane</h1>
            <div className="subtitle">Policy-gated tool execution with audit trails</div>
          </div>
          <div className="auth-row">
            {!isAuthenticated ? (
              <button
                type="button"
                onClick={() =>
                  loginWithRedirect({
                    authorizationParams: {
                      redirect_uri: window.location.origin,
                      audience: "https://control-center-api",
                    },
                  })
                }
              >
                Log in
              </button>
            ) : (
              <>
                <span>
                  Logged in as <b>{user?.email ?? user?.name ?? user?.sub}</b>
                </span>
                <button
                  type="button"
                  onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
                >
                  Log out
                </button>
              </>
            )}
          </div>
        </header>

        <main className="page">
        {!isAuthenticated ? (
          loginCard
        ) : (
          <>
            {showConnectGithub && (
              <div className="card inline-card">
                <button
                  type="button"
                  onClick={() =>
                    loginWithRedirect({
                      authorizationParams: {
                        redirect_uri: window.location.origin,
                        audience: "https://control-center-api",
                        connection: "github",
                        prompt: "login",
                      },
                    })
                  }
                >
                  Connect GitHub
                </button>
                <span style={{ marginLeft: 8 }}>
                  This opens GitHub login; your account will be linked if linking is enabled in Auth0.
                </span>
              </div>
            )}
            <Routes>
              <Route path="/" element={dashboard} />
              <Route path="/allow-list" element={allowListSection} />
              <Route path="/policies" element={policiesSection} />
              <Route path="/tools" element={toolSection} />
              <Route path="/agent" element={agentSection} />
              <Route path="/audit" element={auditSection} />
              <Route path="*" element={dashboard} />
            </Routes>
          </>
        )}
        </main>
      </div>
    </div>
  );
}