"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";

function SsoSubmitButton() {
  const { pending } = useFormStatus();
  const t = useTranslations("auth");

  return (
    <button type="submit" disabled={pending} className="button-outline">
      {pending ? t("ssoRedirecting") : t("ssoContinue")}
    </button>
  );
}

export function SsoLoginForm() {
  const [showSso, setShowSso] = useState(false);
  const t = useTranslations("auth");

  if (!showSso) {
    return (
      <button 
        type="button" 
        className="button-outline" 
        style={{ width: "100%", marginTop: 10 }}
        onClick={() => setShowSso(true)}
      >
        {t("ssoSignIn")}
      </button>
    );
  }

  return (
    <form action="/api/auth/sso/init" method="GET" className="stack" style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--line)" }}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        {t("ssoDescription")}
      </p>
      <label>
        {t("workEmailLabel")}
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
        />
      </label>
      <SsoSubmitButton />
    </form>
  );
}
