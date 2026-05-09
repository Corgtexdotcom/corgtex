"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import { useTranslations } from "next-intl";

export function DemoButton() {
  const [isLoading, setIsLoading] = useState(false);
  const locale = useLocale();
  const t = useTranslations("demo");

  const handleDemoLogin = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/demo-login", {
        method: "POST",
      });
      
      const data = await response.json();
      
      if (data.success && data.workspaceId) {
        // Force a hard navigation to clear any cached states
        window.location.href = locale === "es"
          ? `/es/workspaces/${data.workspaceId}`
          : `/workspaces/${data.workspaceId}`;
      } else {
        alert(t("unavailable"));
        setIsLoading(false);
      }
    } catch (e) {
      alert(t("connectionFailed"));
      setIsLoading(false);
    }
  };

  return (
    <div style={{ marginTop: 24, paddingTop: 24, borderTop: "1px solid var(--line)" }}>
      <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginBottom: 12, textAlign: "center" }}>
        {t("prompt")}
      </p>
      <button 
        type="button" 
        onClick={handleDemoLogin}
        disabled={isLoading}
        className="login-demo-button secondary"
      >
        {isLoading ? t("preparing") : t("explore")}
      </button>
    </div>
  );
}
