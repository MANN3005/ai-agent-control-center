import { useEffect, useState } from "react";
import { getMe, getPolicies, putPolicies } from "./api";

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

export default function App() {
  const [me, setMe] = useState<any>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    const [m, p] = await Promise.all([getMe(), getPolicies()]);
    setMe(m);
    setPolicies(p.length ? p : DEFAULTS);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save() {
    const updated = await putPolicies(policies);
    setPolicies(updated);
  }

  if (loading) return <div style={{ padding: 24 }}>Loading...</div>;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, Arial" }}>
      <h1>AI Agent Control Center — Initial Setup</h1>
      <p>
        User: <b>{me?.userId}</b>
      </p>

      <h2>Tool Policies</h2>
      <table cellPadding={10} style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th align="left">Tool</th>
            <th align="left">Risk</th>
            <th align="left">Mode</th>
          </tr>
        </thead>
        <tbody>
          {policies.map((p, idx) => (
            <tr key={p.toolName} style={{ borderTop: "1px solid #ddd" }}>
              <td>{p.toolName}</td>
              <td>
                <select
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
        <button onClick={save} style={{ padding: "8px 12px" }}>
          Save Policies
        </button>
        <button onClick={refresh} style={{ padding: "8px 12px", marginLeft: 8 }}>
          Reload
        </button>
      </div>
    </div>
  );
}