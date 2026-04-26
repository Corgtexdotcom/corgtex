"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

export function DemoButton() {
  const [isLoading, setIsLoading] = useState(false);
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
        window.location.href = `/workspaces/${data.workspaceId}`;
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
        style={{ 
          width: "100%", 
          background: "linear-gradient(135deg, #0f172a 0%, #334155 100%)",
          boxShadow: "0 4px 12px rgba(15, 23, 42, 0.2)",
          fontWeight: 600
        }}
      >
        {isLoading ? t("preparing") : t("explore")}
      </button>
    </div>
  );
}
