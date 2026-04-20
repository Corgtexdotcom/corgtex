"use client";

import { upsertSsoConfigAction } from "./actions";

type SsoConfig = {
  provider: string;
  clientId: string;
  allowedDomains: string[];
  isEnabled: boolean;
};

export function SsoConfigManager({
  workspaceId,
  configs,
}: {
  workspaceId: string;
  configs: SsoConfig[];
}) {
  const googleConfig = configs.find(c => c.provider === "GOOGLE");
  const microsoftConfig = configs.find(c => c.provider === "MICROSOFT");

  return (
    <section>
      <h2 className="nr-section-header">Single Sign-On (SSO)</h2>
      <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
        Configure enterprise login for your workspace.
      </p>

      {/* Google SSO */}
      <details style={{ marginBottom: 16 }}>
        <summary className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0, cursor: "pointer", color: googleConfig?.isEnabled ? "var(--accent)" : "inherit" }}>
          {googleConfig?.isEnabled ? "▶ Google Workspace (Active)" : "▶ Google Workspace (Disabled)"}
        </summary>
        <form action={upsertSsoConfigAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="provider" value="GOOGLE" />
          
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>
              Client ID
              <input name="clientId" defaultValue={googleConfig?.clientId} required />
            </label>
            <label>
              Client Secret
              <input name="clientSecret" type="password" placeholder={googleConfig ? "********" : ""} required={!googleConfig} />
            </label>
          </div>
          <label>
            Allowed Domains (comma-separated)
            <input name="allowedDomains" defaultValue={googleConfig?.allowedDomains.join(", ")} placeholder="acme.com, acmecorp.com" required />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <input type="checkbox" name="isEnabled" defaultChecked={googleConfig?.isEnabled} value="true" />
            Enable Google SSO
          </label>
          <button type="submit" className="small" style={{ width: "fit-content" }}>Save Google SSO</button>
        </form>
      </details>

      {/* Microsoft SSO */}
      <details>
        <summary className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0, cursor: "pointer", color: microsoftConfig?.isEnabled ? "var(--accent)" : "inherit" }}>
          {microsoftConfig?.isEnabled ? "▶ Microsoft 365 (Active)" : "▶ Microsoft 365 (Disabled)"}
        </summary>
        <form action={upsertSsoConfigAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="provider" value="MICROSOFT" />
          
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>
              Client ID
              <input name="clientId" defaultValue={microsoftConfig?.clientId} required />
            </label>
            <label>
              Client Secret
              <input name="clientSecret" type="password" placeholder={microsoftConfig ? "********" : ""} required={!microsoftConfig} />
            </label>
          </div>
          <label>
            Allowed Domains (comma-separated)
            <input name="allowedDomains" defaultValue={microsoftConfig?.allowedDomains.join(", ")} placeholder="acme.com, acmecorp.com" required />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <input type="checkbox" name="isEnabled" defaultChecked={microsoftConfig?.isEnabled} value="true" />
            Enable Microsoft SSO
          </label>
          <button type="submit" className="small" style={{ width: "fit-content" }}>Save Microsoft SSO</button>
        </form>
      </details>
    </section>
  );
}
