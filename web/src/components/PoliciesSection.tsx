import type { Policy } from "../types";

type PoliciesSectionProps = {
  policies: Policy[];
  onChange: (next: Policy[]) => void;
  onSave: () => void;
  onReload: () => void;
};

export default function PoliciesSection({
  policies,
  onChange,
  onSave,
  onReload,
}: PoliciesSectionProps) {
  return (
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
                    const riskLevel = e.target.value as Policy["riskLevel"];
                    next[idx] = { ...p, riskLevel };
                    onChange(next);
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
                    const mode = e.target.value as Policy["mode"];
                    next[idx] = { ...p, mode };
                    onChange(next);
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
        <button onClick={onSave}>Save Policies</button>
        <button onClick={onReload} style={{ marginLeft: 8 }}>
          Reload
        </button>
      </div>
    </div>
  );
}
