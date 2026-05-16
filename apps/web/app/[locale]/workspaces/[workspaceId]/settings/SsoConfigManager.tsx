"use client";

import { upsertSsoConfigAction } from "./actions";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

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
  const [isHydrated, setIsHydrated] = useState(false);
  const googleConfig = configs.find(c => c.provider === "GOOGLE");
  const microsoftConfig = configs.find(c => c.provider === "MICROSOFT");
  const t = useTranslations("settings");

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  if (!isHydrated) {
    return (
      <section aria-hidden="true">
        <div className="nr-form-section" style={{ minHeight: 160, border: "1px solid var(--line)", borderRadius: 8 }} />
      </section>
    );
  }

  return (
    <section>
      <h2 className="nr-section-header">{t("sectionSso")}</h2>
      <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
        {t("descSso")}
      </p>

      {/* Google SSO */}
      <details style={{ marginBottom: 16 }}>
        <summary className="nr-hide-marker settings-disclosure-summary" style={{ color: googleConfig?.isEnabled ? "var(--accent)" : "inherit" }}>
          {googleConfig?.isEnabled ? t("ssoGoogleActive") : t("ssoGoogleDisabled")}
        </summary>
        <form action={upsertSsoConfigAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="provider" value="GOOGLE" />
          
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>
              {t("labelClientId")}
              <input name="clientId" defaultValue={googleConfig?.clientId} required />
            </label>
            <label>
              {t("labelClientSecret")}
              <input name="clientSecret" type="password" placeholder={googleConfig ? "********" : ""} required={!googleConfig} />
            </label>
          </div>
          <label>
            {t("labelAllowedDomains")}
            <input name="allowedDomains" defaultValue={googleConfig?.allowedDomains.join(", ")} placeholder="acme.com, acmecorp.com" required />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <input type="checkbox" name="isEnabled" defaultChecked={googleConfig?.isEnabled} value="true" />
            {t("enableGoogleSso")}
          </label>
          <button type="submit" className="small" style={{ width: "fit-content" }}>{t("btnSaveGoogleSso")}</button>
        </form>
      </details>

      {/* Microsoft SSO */}
      <details>
        <summary className="nr-hide-marker settings-disclosure-summary" style={{ color: microsoftConfig?.isEnabled ? "var(--accent)" : "inherit" }}>
          {microsoftConfig?.isEnabled ? t("ssoMicrosoftActive") : t("ssoMicrosoftDisabled")}
        </summary>
        <form action={upsertSsoConfigAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="provider" value="MICROSOFT" />
          
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>
              {t("labelClientId")}
              <input name="clientId" defaultValue={microsoftConfig?.clientId} required />
            </label>
            <label>
              {t("labelClientSecret")}
              <input name="clientSecret" type="password" placeholder={microsoftConfig ? "********" : ""} required={!microsoftConfig} />
            </label>
          </div>
          <label>
            {t("labelAllowedDomains")}
            <input name="allowedDomains" defaultValue={microsoftConfig?.allowedDomains.join(", ")} placeholder="acme.com, acmecorp.com" required />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <input type="checkbox" name="isEnabled" defaultChecked={microsoftConfig?.isEnabled} value="true" />
            {t("enableMicrosoftSso")}
          </label>
          <button type="submit" className="small" style={{ width: "fit-content" }}>{t("btnSaveMicrosoftSso")}</button>
        </form>
      </details>
    </section>
  );
}
