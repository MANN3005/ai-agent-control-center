import { useEffect, useState } from "react";
import { getMe, getPolicies, putPolicies } from "./api";
import { useAuth0 } from "@auth0/auth0-react";

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
  const { isAuthenticated, user, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0();
  const [me, setMe] = useState<any>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
  setLoading(true);

  if (!isAuthenticated) {
    setMe(null);
     setPolicies([]);   // <— empty when logged out
  
    // setPolicies(DEFAULTS);
    setLoading(false);
    return;
  }

  const accessToken = await getAccessTokenSilently({
    authorizationParams: {
      audience: "https://control-center-api",
    },
  });

  const [m, p] = await Promise.all([getMe(accessToken), getPolicies(accessToken)]);
  setMe(m);
  setPolicies(p.length ? p : DEFAULTS);
  setLoading(false);
}
  useEffect(() => {
  refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [isAuthenticated]);

  async function save() {
  const accessToken = await getAccessTokenSilently({
    authorizationParams: {
      audience: "https://control-center-api",
    },
  });
  const updated = await putPolicies(accessToken, policies);
  setPolicies(updated);
}
  if (loading) return <div style={{ padding: 24 }}>Loading...</div>;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, Arial" }}>
      <h1>AI Agent Control Center — Initial Setup</h1>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
  {!isAuthenticated ? (
   <button
  type="button"
  onClick={(e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log("Login clicked. Redirecting to Auth0…");
    loginWithRedirect({
      authorizationParams: {
        redirect_uri: window.location.origin,
        audience: "https://control-center-api",
      },
    });
  }}
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
      {!isAuthenticated ? (
  <p>Please log in to view and manage policies.</p>
) : (
  <>
    <p>
      User: <b>{me?.userId}</b>
    </p>
    {/* keep your policies table + buttons here */}
  </>
)}

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