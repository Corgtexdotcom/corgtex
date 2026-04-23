"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type OAuthAppInfo = {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  isActive: boolean;
  createdAt: Date | string;
};

type Provider = "Claude Desktop" | "Cursor";
const PROVIDERS: Provider[] = ["Claude Desktop", "Cursor"];

type Props = {
  workspaceId: string;
  mcpUrl: string;
  oauthApps: OAuthAppInfo[];
};

export function CustomGptConnectionManager({ workspaceId, mcpUrl, oauthApps }: Props) {
  const router = useRouter();
  const [apps, setApps] = useState<OAuthAppInfo[]>(oauthApps);
  const [loading, setLoading] = useState(false);
  const [setupData, setSetupData] = useState<{ clientId: string; clientSecret: string; authorizeUrl: string; tokenUrl: string; schemaUrl: string; orgName: string } | null>(null);

  const activeApps = apps.filter(c => c.isActive);

  const handleConnect = async () => {
    setLoading(true);
    try {
      const orgNameInput = prompt("Enter a short name/identifier for this workspace (used in the GPT system prompt, e.g. Acme Corp):");
      if (!orgNameInput) return; // cancelled

      const res = await fetch(`/api/workspaces/${workspaceId}/oauth-apps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          name: `Custom GPT Integration - ${orgNameInput}`, 
          // Default OpenAI Callback URL pattern - they will configure actual in UI later,
          // but we accept a generic starting point or a wildcard placeholder. 
          // For actual security they should come back and update it to their specific 
          // GPT's callback URL once OpenAI generates it.
          redirectUris: ["https://chatgpt.com/aip/g-PLACEHOLDER/oauth/callback"] 
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create OAuth App");
      }
      const data = await res.json();

      setApps(prev => [data.app, ...prev]);
      
      const origin = window.location.origin;
      setSetupData({ 
        clientId: data.clientId, 
        clientSecret: data.clientSecret,
        authorizeUrl: `${origin}/oauth/authorize`,
        tokenUrl: `${origin}/api/oauth/token`,
        schemaUrl: `${origin}/api/gpt/v1/openapi.json`,
        orgName: orgNameInput
      });
      router.refresh();
    } catch (err: any) {
      console.error(err);
      alert(err.message || "Failed to connect Custom GPT");
    } finally {
      setLoading(false);
    }
  };

  const renderSetupInstructions = () => {
    if (!setupData) return null;

    const systemPromptTemplate = `You are the organizing mind for ${setupData.orgName}, a self-managed organization operating on the Corgtex platform.

Your primary objective is to assist team members in participating effectively within their governance structure. You have direct access to the ${setupData.orgName} workspace via your Actions.

# Core Principles
- The organization uses a decentralized, role-based structure.
- Work is organized into "Circles" consisting of "Roles".
- Members resolve issues by processing "Tensions" into "Proposals" or "Actions".

# Guidelines
1. Answer questions based on the structural reality in the workspace. Use the search and workspace endpoints to gather context.
2. Formulate changes through Actions or Proposals using the endpoints.
3. Always provide Corgtex web links (webUrl) in responses.
4. Keep tone professional, authoritative, and concise.`;

    return (
      <div className="panel" style={{ background: "var(--surface)", border: "1px solid var(--border)", padding: 20, borderRadius: 8, marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, color: "var(--accent)" }} className="row gap-2">ChatGPT Custom GPT Setup</h3>
          <button className="button small secondary" onClick={() => setSetupData(null)}>Done</button>
        </div>

        <div style={{ padding: "12px", background: "rgba(255, 165, 0, 0.1)", border: "1px solid rgba(255, 165, 0, 0.3)", borderRadius: "6px", marginBottom: "20px" }}>
          <strong style={{ display: "block", marginBottom: "4px" }}>Save your Client Secret</strong>
          <span className="muted" style={{ fontSize: "0.85rem" }}>You won&apos;t be able to see this secret again after you close this panel.</span>
          <div className="mt-2 row gap-2">
            <code style={{ flex: 1, padding: "4px 8px", background: "rgba(0,0,0,0.2)", borderRadius: 4 }}>{setupData.clientSecret}</code>
          </div>
        </div>

        <ol className="stack" style={{ gap: 16, paddingLeft: 16, fontSize: "0.85rem", margin: 0 }}>
          <li>
            <strong>Create GPT</strong>
            <p className="muted mt-1">Go to <a href="https://chatgpt.com/gpts/editor" target="_blank" rel="noreferrer" style={{color: "var(--accent)"}}>ChatGPT -&gt; Explore -&gt; Create</a></p>
          </li>
          
          <li>
            <strong>Set Instructions</strong>
            <p className="muted mt-1 mb-2">Paste this template into the <strong>Instructions</strong> box:</p>
            <textarea readOnly value={systemPromptTemplate} rows={5} className="w-full text-xs font-mono p-2 bg-[var(--surface-sunken)] border border-[var(--border)] rounded" />
          </li>

          <li>
            <strong>Add Action Schema</strong>
            <p className="muted mt-1 mb-2">Scroll down to <strong>Actions</strong> and click <strong>Create new action</strong>. Click <strong>Import from URL</strong> and paste:</p>
            <div className="row gap-2">
              <input readOnly value={setupData.schemaUrl} className="flex-1 bg-[var(--surface-sunken)] text-xs font-mono p-2 rounded border border-[var(--border)]" />
            </div>
          </li>

          <li>
            <strong>Configure OAuth</strong>
            <p className="muted mt-1 mb-2">Click the gear icon next to <strong>Authentication</strong>, select <strong>OAuth</strong>, and paste:</p>
            <div className="grid grid-cols-[120px_1fr] gap-2 items-center">
              <span className="text-right text-xs">Client ID</span>
              <input readOnly value={setupData.clientId} className="bg-[var(--surface-sunken)] text-xs font-mono p-1 rounded border border-[var(--line)]" />
              <span className="text-right text-xs">Client Secret</span>
              <span className="text-xs muted">(from the orange box above)</span>
              <span className="text-right text-xs">Authorization URL</span>
              <input readOnly value={setupData.authorizeUrl} className="bg-[var(--surface-sunken)] text-xs font-mono p-1 rounded border border-[var(--line)]" />
              <span className="text-right text-xs">Token URL</span>
              <input readOnly value={setupData.tokenUrl} className="bg-[var(--surface-sunken)] text-xs font-mono p-1 rounded border border-[var(--line)]" />
            </div>
          </li>
          
          <li>
            <strong>Finalize Callback URL</strong>
            <p className="muted mt-1">After saving, ChatGPT will generate a <strong>Callback URL</strong> at the bottom of the Action screen. Note it down—you must update this App integration later if you want strict security, though it defaults to allowing any ChatGPT OAuth flow.</p>
          </li>
        </ol>
      </div>
    );
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      
      <div className="panel" style={{ padding: 16, border: "1px solid var(--border)", borderRadius: 8 }}>
        <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: "1rem" }}>ChatGPT</strong>
              {activeApps.length > 0 && (
                <span className="tag" style={{ background: "var(--accent-soft)", fontWeight: "bold" }}>Connected</span>
              )}
            </div>
            <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
              Setup a personalized Custom GPT for this workspace. Requires ChatGPT Plus.
            </div>
          </div>

          <div className="actions-inline">
            <button
              className="button"
              onClick={handleConnect}
              disabled={loading}
            >
              {loading ? "..." : "+ Add Integration"}
            </button>
          </div>
        </div>

        {setupData && renderSetupInstructions()}

        {activeApps.length > 0 && (
          <div className="mt-4 pt-4 border-t border-[var(--border)] stack gap-3">
             {activeApps.map(app => (
               <div key={app.id} className="row justify-between text-sm">
                 <div>
                   <div className="font-medium">{app.name}</div>
                   <code className="text-xs muted">{app.clientId}</code>
                 </div>
                 <span className="text-xs muted">
                    {new Date(app.createdAt).toLocaleDateString()}
                 </span>
               </div>
             ))}
          </div>
        )}
      </div>
    </div>
  );
}
