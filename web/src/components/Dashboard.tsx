import type { IdentityEntry } from "../types";

type DashboardProps = {
  allowedReposCount: number;
  policiesCount: number;
  auditCount: number;
  stepUpActive: boolean;
  identities: IdentityEntry[];
  userId?: string | null;
};

export default function Dashboard({
  allowedReposCount,
  policiesCount,
  auditCount,
  stepUpActive,
  identities,
  userId,
}: DashboardProps) {
  const stats = [
    { label: "Allowed Repos", value: allowedReposCount },
    { label: "Policies", value: policiesCount },
    { label: "Audit Entries", value: auditCount },
    { label: "Step-up Active", value: stepUpActive ? "Yes" : "No" },
  ];

  return (
    <div className="grid">
      <div className="section-card">
        <h2>Overview</h2>
        <div className="stat-grid">
          {stats.map((stat) => (
            <div key={stat.label} className="stat">
              <div className="stat-label">{stat.label}</div>
              <div className="stat-value">{stat.value}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="section-card">
        <h2>Quick Actions</h2>
        <div style={{ marginTop: 8, color: "var(--muted)" }}>
          Use the Agent chat to run actions. Example: "List my repos" or "Create an issue in owner/repo".
        </div>
      </div>
      <div className="section-card">
        <h2>Connected Identities</h2>
        {identities.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>No identities available.</div>
        ) : (
          <table cellPadding={8} className="table">
            <thead>
              <tr>
                <th align="left">Provider</th>
                <th align="left">Connection</th>
                <th align="left">Token</th>
              </tr>
            </thead>
            <tbody>
              {identities.map((identity, idx) => (
                <tr key={`${identity.provider ?? "unknown"}-${idx}`}>
                  <td>{identity.provider ?? "-"}</td>
                  <td>{identity.connection ?? "-"}</td>
                  <td>{identity.hasAccessToken ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card inline-card">
        <div>
          User: <b>{userId ?? "-"}</b>
        </div>
      </div>
    </div>
  );
}
