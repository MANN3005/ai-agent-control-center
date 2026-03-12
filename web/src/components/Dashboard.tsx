import { useState } from "react";
import type { IdentityEntry } from "../types";

type DashboardProps = {
  allowedReposCount: number;
  policiesCount: number;
  auditCount: number;
  stepUpActive: boolean;
  identities: IdentityEntry[];
  userId?: string | null;
  primaryUserId?: string | null;
  onUnlinkIdentity: (provider: string, providerUserId: string) => Promise<unknown>;
  onStartLink: (provider: "github" | "slack") => void;
  linkError?: string | null;
  linking?: boolean;
};

export default function Dashboard({
  allowedReposCount,
  policiesCount,
  auditCount,
  stepUpActive,
  identities,
  userId,
  primaryUserId,
  onUnlinkIdentity,
  onStartLink,
  linkError,
  linking,
}: DashboardProps) {
  const [unlinkBusyKey, setUnlinkBusyKey] = useState<string | null>(null);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  async function handleUnlink(provider: string | null, providerUserId: string | null) {
    if (!provider || !providerUserId) return;
    const key = `${provider}:${providerUserId}`;
    setUnlinkBusyKey(key);
    setUnlinkError(null);
    try {
      await onUnlinkIdentity(provider, String(providerUserId));
    } catch (err: any) {
      setUnlinkError(err?.message || "Unlink failed.");
    } finally {
      setUnlinkBusyKey(null);
    }
  }
  const stats = [
    { label: "Allowed Repos", value: allowedReposCount },
    { label: "Policies", value: policiesCount },
    { label: "Audit Entries", value: auditCount },
    { label: "Step-up Active", value: stepUpActive ? "Yes" : "No" },
  ];

  const isPrimaryUser = Boolean(primaryUserId && userId && primaryUserId === userId);
  const canManageLinks = Boolean(primaryUserId && isPrimaryUser);
  const canShowUnlink = (provider: string | null, connection: string | null) => {
    if (connection && ["github", "sign-in-with-slack"].includes(connection)) return true;
    return Boolean(provider && ["github", "slack", "sign-in-with-slack", "oauth2"].includes(provider));
  };

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
        <div className="identity-header">
          <div>
            <h2>Connected Identities</h2>
            <div className="identity-subtitle">
              Manage identity links for GitHub and Slack from the primary Google account.
            </div>
          </div>
          {canManageLinks ? (
            <div className="identity-actions">
              <button type="button" onClick={() => onStartLink("github")} disabled={Boolean(linking)}>
                {linking ? "Linking..." : "Link GitHub"}
              </button>
              <button type="button" onClick={() => onStartLink("slack")} disabled={Boolean(linking)}>
                {linking ? "Linking..." : "Link Slack"}
              </button>
            </div>
          ) : null}
        </div>
        <div className="identity-meta">
          <span className="pill pill-muted">Primary</span>
          <span>{primaryUserId ?? "Not stored yet"}</span>
        </div>
        {!canManageLinks ? (
          <div style={{ color: "var(--muted)", marginTop: 8 }}>
            Log in with the primary Google account to manage links.
          </div>
        ) : null}
        {identities.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>No identities available.</div>
        ) : (
          <div className="table-wrap">
            <table cellPadding={8} className="table">
              <thead>
                <tr>
                  <th align="left">Provider</th>
                  <th align="left">Connection</th>
                  <th align="left">Token</th>
                  <th align="left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {identities.map((identity, idx) => (
                  <tr key={`${identity.provider ?? "unknown"}-${idx}`}>
                    <td>
                      <span className="pill">{identity.provider ?? "-"}</span>
                    </td>
                    <td>
                      <span className="pill pill-muted">{identity.connection ?? "-"}</span>
                    </td>
                    <td>
                      <span className={`badge ${identity.hasAccessToken ? "badge-yes" : "badge-no"}`}>
                        {identity.hasAccessToken ? "Active" : "Missing"}
                      </span>
                    </td>
                    <td>
                      {canManageLinks && canShowUnlink(identity.provider, identity.connection) && identity.userId ? (
                        <button
                          type="button"
                          onClick={() => handleUnlink(identity.provider, identity.userId)}
                          disabled={unlinkBusyKey === `${identity.provider}:${identity.userId}`}
                        >
                          {unlinkBusyKey === `${identity.provider}:${identity.userId}` ? "Unlinking..." : "Unlink"}
                        </button>
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {unlinkError ? (
          <div style={{ marginTop: 8, color: "var(--muted)" }}>{unlinkError}</div>
        ) : null}
        {linkError ? <div style={{ marginTop: 8, color: "var(--muted)" }}>{linkError}</div> : null}
        <div style={{ marginTop: 10, color: "var(--muted)" }}>
          Linking will redirect to the provider, then switch back to the Google session.
        </div>
      </div>
      <div className="card inline-card">
        <div>
          User: <b>{userId ?? "-"}</b>
        </div>
      </div>
    </div>
  );
}
