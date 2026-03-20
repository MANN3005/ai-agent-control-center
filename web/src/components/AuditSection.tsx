import type { AuditEntry } from "../types";

type AuditSectionProps = {
  audit: AuditEntry[];
};

export default function AuditSection({ audit }: AuditSectionProps) {
  return (
    <div className="section-card">
      <h2>Audit Log (latest 25)</h2>
      <div className="table-wrap">
        <table cellPadding={8} className="table">
          <thead>
            <tr>
              <th align="left">Time</th>
              <th align="left">Tool</th>
              <th align="left">Decision</th>
              <th align="left">Executed</th>
              <th align="left">Reason</th>
              <th align="left">Reasoning</th>
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
                <td>{a.reasoning ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
