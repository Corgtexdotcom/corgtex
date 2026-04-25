"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

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
  const t = useTranslations("settings");

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
      if (!res.ok) throw new Error(t("errorCreateCredential"));
      const data = await res.json();

      setCredentials(prev => [data.credential, ...prev]);
      setSetupData({ provider, token: data.token, credentialId: data.credential.id });
      router.refresh();
    } catch (err) {
      console.error(err);
      alert(t("errorConnectAgent"));
    } finally {
      setLoadingProvider(null);
    }
  };

  const handleRevoke = async (credentialId: string) => {
    if (!confirm(t("confirmDisconnect"))) return;

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/agent-credentials/${credentialId}/revoke`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(t("errorRevokeCredential"));

      setCredentials(prev => prev.filter(c => c.id !== credentialId));
      if (setupData?.credentialId === credentialId) {
        setSetupData(null);
      }
      router.refresh();
    } catch (err) {
      console.error(err);
      alert(t("errorDisconnectAgent"));
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
      if (!res.ok) throw new Error(t("errorRotateCredential"));
      const data = await res.json();

      setCredentials(prev => prev.map(c => c.id === credentialId ? data.credential : c));
      setSetupData({ provider, token: data.token, credentialId: data.credential.id });
      router.refresh();
    } catch (err) {
      console.error(err);
      alert(t("errorRotateToken"));
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
      if (!res.ok) throw new Error(t("errorGrantScopes"));
      const data = await res.json();
      setCredentials(prev => prev.map(c => c.id === credentialId ? data.credential : c));
      router.refresh();
    } catch (err) {
      console.error(err);
      alert(t("errorGrantScopes"));
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
            title={t("lblMissing", { missing: missing.join(", ") })}
            style={{ fontSize: "0.7rem", padding: "2px 8px", background: "rgba(255,165,0,0.15)", border: "1px dashed rgba(255,165,0,0.5)" }}
          >
            {t("lblMissingCount", { count: missing.length })}
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
            {t("btnGrantScope", { scope: scopeRegistry[scope]?.label ?? scope })}
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
          <h3 style={{ margin: 0, color: "var(--accent)" }}>{t("titleProviderSetup", { provider })}</h3>
          <button className="button small secondary" onClick={() => setSetupData(null)}>{t("btnDone")}</button>
        </div>

        <div style={{ padding: "12px", background: "rgba(255, 165, 0, 0.1)", border: "1px solid rgba(255, 165, 0, 0.3)", borderRadius: "6px", marginBottom: "20px" }}>
          <strong style={{ display: "block", marginBottom: "4px" }}>{t("titleSaveToken")}</strong>
          <span className="muted" style={{ fontSize: "0.85rem" }}>{t("descSaveToken")}</span>
        </div>

        {provider === "Claude Desktop" && (
          <>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 12 }}>
              <strong>{t("opt1QuickSetup")}</strong>
            </p>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 8 }}>
              {t("descQuickSetup")}
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
                {copied ? t("btnCopied") : t("btnCopy")}
              </button>
            </div>

            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 12 }}>
              <strong>{t("opt2ManualSetup")}</strong>
            </p>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 12 }}>
              {t("descManualSetup")}
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
                {copied ? t("btnCopied") : t("btnCopyJson")}
              </button>
            </div>
          </>
        )}

        {provider === "ChatGPT" && (
          <>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 12 }}>
              {t("descChatGptSetup")}
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
                {copied ? t("btnCopied") : t("btnCopyCmd")}
              </button>
            </div>
          </>
        )}

        {provider === "Cursor" && (
          <>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 12 }}>
              {t("descCursorSetup")}
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
                    <span className="tag" style={{ background: "var(--accent-soft)", fontWeight: "bold" }}>{t("lblConnected")}</span>
                  )}
                  {isConnected && missing.length > 0 && (
                    <span className="tag" style={{ background: "rgba(255,165,0,0.15)", border: "1px dashed rgba(255,165,0,0.5)", fontWeight: "bold" }}>
                      {t("lblNeedsScopeUpgrade")}
                    </span>
                  )}
                </div>
                <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                  {isConnected
                    ? t("lblLastUsed", { date: credential.lastUsedAt ? new Date(credential.lastUsedAt).toLocaleDateString() : t("valNever") })
                    : t("lblConnectProvider", { provider })
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
                    {loadingProvider === provider ? t("btnConnecting") : t("btnConnect")}
                  </button>
                ) : (
                  <>
                    {missing.length > 0 && (
                      <button
                        className="button"
                        onClick={() => handleGrantMissing(credential.id)}
                        disabled={grantingId === credential.id}
                        title={t("titleGrantMissing", { count: missing.length })}
                      >
                        {grantingId === credential.id ? t("btnGranting") : t("btnGrantMissingCount", { count: missing.length })}
                      </button>
                    )}
                    <button
                      className="button secondary"
                      onClick={() => handleRotate(provider, credential.id)}
                      disabled={loadingProvider === provider}
                      title={t("titleRotateToken")}
                    >
                      {t("btnRotateToken")}
                    </button>
                    <button
                      className="button secondary danger"
                      onClick={() => handleRevoke(credential.id)}
                    >
                      {t("btnDisconnect")}
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
          <h3 style={{ fontSize: "0.95rem", marginBottom: 12 }}>{t("titleOtherConnections")}</h3>
          <div className="list">
            {activeCredentials.filter(c => !PROVIDERS.includes(c.label as Provider)).map((cred) => {
              const missing = missingScopes(cred, defaultScopes);
              return (
                <div className="item" key={cred.id}>
                  <div className="row">
                    <strong>{cred.label}</strong>
                    <span className="tag">{t("lblActive")}</span>
                    {missing.length > 0 && (
                      <span className="tag" style={{ background: "rgba(255,165,0,0.15)", border: "1px dashed rgba(255,165,0,0.5)" }}>
                        {t("lblNeedsScopeUpgrade")}
                      </span>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {t("lblLastUsedOther", { date: cred.lastUsedAt ? new Date(cred.lastUsedAt).toLocaleDateString() : t("valNever") })}
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
                        {grantingId === cred.id ? t("btnGranting") : t("btnGrantMissingCount", { count: missing.length })}
                      </button>
                    )}
                    <button
                      className="button secondary danger small"
                      onClick={() => handleRevoke(cred.id)}
                    >
                      {t("btnDisconnect")}
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
