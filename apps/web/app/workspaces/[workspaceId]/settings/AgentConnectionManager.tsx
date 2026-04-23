"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Credential = {
  id: string;
  label: string;
  scopes: string[];
  isActive: boolean;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
};

type Provider = "Claude Desktop" | "ChatGPT" | "Cursor";
const PROVIDERS: Provider[] = ["Claude Desktop", "ChatGPT", "Cursor"];

type Props = {
  workspaceId: string;
  mcpUrl: string;
  initialCredentials: Credential[];
  defaultScopes: string[];
  scopeRegistry: Record<string, { label: string; default: boolean }>;
};

function missingScopes(cred: Credential, defaultScopes: string[]): string[] {
  const have = new Set(cred.scopes);
  return defaultScopes.filter((s) => !have.has(s));
}

export function AgentConnectionManager({ workspaceId, mcpUrl, initialCredentials, defaultScopes, scopeRegistry }: Props) {
  const router = useRouter();
  const [credentials, setCredentials] = useState<Credential[]>(initialCredentials);
  const [loadingProvider, setLoadingProvider] = useState<Provider | null>(null);
  const [grantingId, setGrantingId] = useState<string | null>(null);
  const [setupData, setSetupData] = useState<{ provider: Provider; token: string; credentialId: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const activeCredentials = credentials.filter(c => c.isActive);
  const optionalScopes = Object.entries(scopeRegistry)
    .filter(([, meta]) => !meta.default)
    .map(([scope]) => scope);

  const handleConnect = async (provider: Provider) => {
    setLoadingProvider(provider);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/agent-credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: provider, scopes: defaultScopes }),
      });
      if (!res.ok) throw new Error("Failed to create credential");
      const data = await res.json();

      setCredentials(prev => [data.credential, ...prev]);
      setSetupData({ provider, token: data.token, credentialId: data.credential.id });
      router.refresh();
    } catch (err) {
      console.error(err);
      alert("Failed to connect agent");
    } finally {
      setLoadingProvider(null);
    }
  };

  const handleRevoke = async (credentialId: string) => {
    if (!confirm("Are you sure you want to disconnect this integration?")) return;

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/agent-credentials/${credentialId}/revoke`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to revoke credential");

      setCredentials(prev => prev.filter(c => c.id !== credentialId));
      if (setupData?.credentialId === credentialId) {
        setSetupData(null);
      }
      router.refresh();
    } catch (err) {
      console.error(err);
      alert("Failed to disconnect agent");
    }
  };

  // Rotate the bearer token but preserve scopes. Surfaces a fresh token that
  // must be reconfigured in the client. Use this to revoke a leaked token.
  const handleRotate = async (provider: Provider, credentialId: string) => {
    setLoadingProvider(provider);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/agent-credentials/${credentialId}/rotate`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to rotate credential");
      const data = await res.json();

      setCredentials(prev => prev.map(c => c.id === credentialId ? data.credential : c));
      setSetupData({ provider, token: data.token, credentialId: data.credential.id });
      router.refresh();
    } catch (err) {
      console.error(err);
      alert("Failed to rotate token");
    } finally {
      setLoadingProvider(null);
    }
  };

  // Grant scopes without rotating the token. The connected client keeps
  // working with its existing token and immediately gains access.
  const handleGrantScopes = async (credentialId: string, scopesToGrant: string[]) => {
    const cred = credentials.find(c => c.id === credentialId);
    if (!cred) return;
    const target = [...new Set([...cred.scopes, ...scopesToGrant])];
    setGrantingId(credentialId);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/agent-credentials/${credentialId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: target }),
      });
      if (!res.ok) throw new Error("Failed to grant scopes");
      const data = await res.json();
      setCredentials(prev => prev.map(c => c.id === credentialId ? data.credential : c));
      router.refresh();
    } catch (err) {
      console.error(err);
      alert("Failed to grant scopes");
    } finally {
      setGrantingId(null);
    }
  };

  const handleGrantMissing = (credentialId: string) => {
    void handleGrantScopes(credentialId, defaultScopes);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderScopeChips = (cred: Credential) => {
    const missing = missingScopes(cred, defaultScopes);
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {cred.scopes.map((scope) => {
          const meta = scopeRegistry[scope];
          return (
            <span
              key={scope}
              className="tag"
              title={meta?.label ?? scope}
              style={{ fontSize: "0.7rem", padding: "2px 8px" }}
            >
              {scope}
            </span>
          );
        })}
        {missing.length > 0 && (
          <span
            className="tag"
            title={`Missing: ${missing.join(", ")}`}
            style={{ fontSize: "0.7rem", padding: "2px 8px", background: "rgba(255,165,0,0.15)", border: "1px dashed rgba(255,165,0,0.5)" }}
          >
            {missing.length} missing
          </span>
        )}
      </div>
    );
  };

  const renderOptionalScopeGrants = (cred: Credential) => {
    const missingOptional = optionalScopes.filter((scope) => !cred.scopes.includes(scope));
    if (missingOptional.length === 0) return null;

    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        {missingOptional.map((scope) => (
          <button
            key={scope}
            className="button secondary small"
            onClick={() => void handleGrantScopes(cred.id, [scope])}
            disabled={grantingId === cred.id}
            title={scope}
          >
            Grant {scopeRegistry[scope]?.label ?? scope}
          </button>
        ))}
      </div>
    );
  };

  const renderSetupInstructions = () => {
    if (!setupData) return null;
    const { provider, token } = setupData;

    return (
      <div className="panel" style={{ background: "var(--surface)", border: "1px solid var(--line)", padding: 20, borderRadius: 8, marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, color: "var(--accent)" }}>{provider} Setup</h3>
          <button className="button small secondary" onClick={() => setSetupData(null)}>Done</button>
        </div>

        <div style={{ padding: "12px", background: "rgba(255, 165, 0, 0.1)", border: "1px solid rgba(255, 165, 0, 0.3)", borderRadius: "6px", marginBottom: "20px" }}>
          <strong style={{ display: "block", marginBottom: "4px" }}>Save your token</strong>
          <span className="muted" style={{ fontSize: "0.85rem" }}>You won&apos;t be able to see this token again after you close this panel.</span>
        </div>

        {provider === "Claude Desktop" && (
          <>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 12 }}>
              <strong>Option 1: Quick Setup (Terminal)</strong>
            </p>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 8 }}>
              Open your Terminal application and paste this entire block, then restart Claude:
            </p>
            <div style={{ position: "relative", marginBottom: 24 }}>
              <pre style={{ background: "black", padding: 16, borderRadius: 6, fontSize: "0.85rem", overflowX: "auto", border: "1px solid var(--line)", margin: 0 }}>
                <code style={{ fontFamily: "monospace", color: "#e2e8f0" }}>{`cat > ~/Library/Application\\ Support/Claude/claude_desktop_config.json << 'EOF'
{
  "mcpServers": {
    "corgtex": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "${mcpUrl}",
        "--header",
        "Authorization: Bearer ${token}"
      ]
    }
  }
}
EOF`}</code>
              </pre>
              <button
                onClick={() => handleCopy(`cat > ~/Library/Application\\ Support/Claude/claude_desktop_config.json << 'EOF'\n{\n  "mcpServers": {\n    "corgtex": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "mcp-remote@latest",\n        "${mcpUrl}",\n        "--header",\n        "Authorization: Bearer ${token}"\n      ]\n    }\n  }\n}\nEOF`)}
                className="button small"
                style={{ position: "absolute", top: 12, right: 12 }}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>

            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 12 }}>
              <strong>Option 2: Manual Setup</strong>
            </p>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 12 }}>
              Open Claude Desktop → Settings → Developer → Edit Config, and paste this JSON:
            </p>
            <div style={{ position: "relative" }}>
              <pre style={{ background: "black", padding: 16, borderRadius: 6, fontSize: "0.85rem", overflowX: "auto", border: "1px solid var(--line)", margin: 0 }}>
                <code style={{ fontFamily: "monospace", color: "#e2e8f0" }}>{`{
  "mcpServers": {
    "corgtex": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "${mcpUrl}",
        "--header",
        "Authorization: Bearer ${token}"
      ]
    }
  }
}`}</code>
              </pre>
              <button
                onClick={() => handleCopy(`{\n  "mcpServers": {\n    "corgtex": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "mcp-remote@latest",\n        "${mcpUrl}",\n        "--header",\n        "Authorization: Bearer ${token}"\n      ]\n    }\n  }\n}`)}
                className="button small"
                style={{ position: "absolute", top: 12, right: 12 }}
              >
                {copied ? "Copied!" : "Copy JSON"}
              </button>
            </div>
          </>
        )}

        {provider === "ChatGPT" && (
          <>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 12 }}>
              Go to <strong>Settings → Developer → Work with Apps</strong>. When adding an MCP server, copy and paste this command:
            </p>
            <div style={{ position: "relative", marginBottom: 16 }}>
              <pre style={{ background: "black", padding: 16, paddingRight: 100, borderRadius: 6, fontSize: "0.85rem", overflowX: "auto", border: "1px solid var(--line)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                <code style={{ fontFamily: "monospace", color: "#e2e8f0" }}>{`npx -y mcp-remote@latest ${mcpUrl} --header "Authorization: Bearer ${token}"`}</code>
              </pre>
              <button
                onClick={() => handleCopy(`npx -y mcp-remote@latest ${mcpUrl} --header "Authorization: Bearer ${token}"`)}
                className="button small"
                style={{ position: "absolute", top: 12, right: 12 }}
              >
                {copied ? "Copied!" : "Copy Cmd"}
              </button>
            </div>
          </>
        )}

        {provider === "Cursor" && (
          <>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 12 }}>
              Go to <strong>Settings → Features → MCP</strong>. Click <em>+ Add New MCP Server</em>. Select type <strong>SSE</strong>, paste the Endpoint URL, and add the Authorization header below:
            </p>
            <div style={{ display: "grid", gap: "12px" }}>
              <div>
                <strong style={{ fontSize: "0.8rem", display: "block", marginBottom: "4px" }}>Endpoint URL</strong>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input readOnly value={mcpUrl} style={{ flex: 1, fontFamily: "monospace" }} />
                  <button className="button secondary" onClick={() => handleCopy(mcpUrl)}>Copy</button>
                </div>
              </div>
              <div>
                <strong style={{ fontSize: "0.8rem", display: "block", marginBottom: "4px" }}>Authorization Header Value</strong>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input readOnly value={`Bearer ${token}`} style={{ flex: 1, fontFamily: "monospace" }} />
                  <button className="button secondary" onClick={() => handleCopy(`Bearer ${token}`)}>Copy</button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {PROVIDERS.map(provider => {
        const credential = activeCredentials.find(c => c.label === provider);
        const isConnected = !!credential;
        const isSetupActive = setupData?.provider === provider;
        const missing = credential ? missingScopes(credential, defaultScopes) : [];

        return (
          <div key={provider} className="panel" style={{ padding: 16, border: "1px solid var(--line)", borderRadius: 8 }}>
            <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong style={{ fontSize: "1rem" }}>{provider}</strong>
                  {isConnected && (
                    <span className="tag" style={{ background: "var(--accent-soft)", fontWeight: "bold" }}>Connected</span>
                  )}
                  {isConnected && missing.length > 0 && (
                    <span className="tag" style={{ background: "rgba(255,165,0,0.15)", border: "1px dashed rgba(255,165,0,0.5)", fontWeight: "bold" }}>
                      Needs scope upgrade
                    </span>
                  )}
                </div>
                <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                  {isConnected
                    ? `Last used: ${credential.lastUsedAt ? new Date(credential.lastUsedAt).toLocaleDateString() : "Never"}`
                    : `Connect Corgtex to ${provider}`
                  }
                </div>
                {isConnected && (
                  <>
                    {renderScopeChips(credential)}
                    {renderOptionalScopeGrants(credential)}
                  </>
                )}
              </div>

              <div className="actions-inline">
                {!isConnected ? (
                  <button
                    className="button"
                    onClick={() => handleConnect(provider)}
                    disabled={loadingProvider === provider}
                  >
                    {loadingProvider === provider ? "Connecting..." : "Connect"}
                  </button>
                ) : (
                  <>
                    {missing.length > 0 && (
                      <button
                        className="button"
                        onClick={() => handleGrantMissing(credential.id)}
                        disabled={grantingId === credential.id}
                        title={`Grant ${missing.length} missing scope(s) without rotating the token`}
                      >
                        {grantingId === credential.id ? "Granting..." : `Grant ${missing.length} missing`}
                      </button>
                    )}
                    <button
                      className="button secondary"
                      onClick={() => handleRotate(provider, credential.id)}
                      disabled={loadingProvider === provider}
                      title="Issue a new token (same scopes). The old token stops working."
                    >
                      Rotate token
                    </button>
                    <button
                      className="button secondary danger"
                      onClick={() => handleRevoke(credential.id)}
                    >
                      Disconnect
                    </button>
                  </>
                )}
              </div>
            </div>

            {isSetupActive && renderSetupInstructions()}
          </div>
        );
      })}

      {/* Show custom/unknown credentials that were created outside this UI */}
      {activeCredentials.filter(c => !PROVIDERS.includes(c.label as Provider)).length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: "0.95rem", marginBottom: 12 }}>Other Connections</h3>
          <div className="list">
            {activeCredentials.filter(c => !PROVIDERS.includes(c.label as Provider)).map((cred) => {
              const missing = missingScopes(cred, defaultScopes);
              return (
                <div className="item" key={cred.id}>
                  <div className="row">
                    <strong>{cred.label}</strong>
                    <span className="tag">Active</span>
                    {missing.length > 0 && (
                      <span className="tag" style={{ background: "rgba(255,165,0,0.15)", border: "1px dashed rgba(255,165,0,0.5)" }}>
                        Needs scope upgrade
                      </span>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    Last used {cred.lastUsedAt ? new Date(cred.lastUsedAt).toLocaleDateString() : "Never"}
                  </div>
                  {renderScopeChips(cred)}
                  {renderOptionalScopeGrants(cred)}
                  <div className="actions-inline" style={{ marginTop: 8 }}>
                    {missing.length > 0 && (
                      <button
                        className="button small"
                        onClick={() => handleGrantMissing(cred.id)}
                        disabled={grantingId === cred.id}
                      >
                        {grantingId === cred.id ? "Granting..." : `Grant ${missing.length} missing`}
                      </button>
                    )}
                    <button
                      className="button secondary danger small"
                      onClick={() => handleRevoke(cred.id)}
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
