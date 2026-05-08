"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

function QualifyFormInner() {
  const searchParams = useSearchParams();
  const token = searchParams?.get("token");
  const t = useTranslations("qualify");

  const [companyName, setCompanyName] = useState("");
  const [website, setWebsite] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [aiExperience, setAiExperience] = useState("");
  const [helpNeeded, setHelpNeeded] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!token) {
    return (
      <div className="container qualify-state">
        <h1>{t("invalidTitle")}</h1>
        <p>{t("invalidBody")}</p>
      </div>
    );
  }

  if (success) {
    return (
      <div className="container qualify-state">
        <h1>{t("successTitle")}</h1>
        <p>{t("successBody")}</p>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName || !website || !aiExperience || !helpNeeded) return;

    setLoading(true);
    setError(null);
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.corgtex.com";
      const res = await fetch(`${appUrl}/api/demo-leads/qualify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          companyName,
          website,
          roleTitle: roleTitle || undefined,
          aiExperience,
          helpNeeded,
        }),
      });

      if (res.ok) {
        setSuccess(true);
      } else {
        const data = await res.json();
        setError(data.error || t("genericError"));
      }
    } catch {
      setError(t("networkError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container qualify-shell">
      <div className="qualify-header">
        <h1>{t("title")}</h1>
        <p>{t("description")}</p>
      </div>

      <form onSubmit={handleSubmit} className="qualify-form">
        {error && (
          <div className="form-alert">
            {error}
          </div>
        )}

        <div className="qualify-grid">
          <div className="form-field">
            <label className="form-label">{t("companyName")}</label>
            <input type="text" required value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="form-input" disabled={loading} placeholder="Acme Corp" />
          </div>
          <div className="form-field">
            <label className="form-label">{t("website")}</label>
            <input type="text" required value={website} onChange={(e) => setWebsite(e.target.value)} className="form-input" disabled={loading} placeholder="acme.com" />
          </div>
        </div>

        <div className="form-field">
          <label className="form-label">{t("roleTitle")}</label>
          <input type="text" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} className="form-input" disabled={loading} placeholder={t("rolePlaceholder")} />
        </div>

        <div className="form-field">
          <label className="form-label">{t("aiExperience")}</label>
          <textarea required value={aiExperience} onChange={(e) => setAiExperience(e.target.value)} className="form-input form-textarea" disabled={loading} placeholder={t("aiPlaceholder")} />
        </div>

        <div className="form-field">
          <label className="form-label">{t("helpNeeded")}</label>
          <textarea required value={helpNeeded} onChange={(e) => setHelpNeeded(e.target.value)} className="form-input form-textarea" disabled={loading} placeholder={t("helpPlaceholder")} />
        </div>

        <div>
          <button type="submit" className="btn btn-primary full-width" disabled={loading}>
            {loading ? t("submitting") : t("submit")}
          </button>
        </div>
      </form>
    </div>
  );
}

export function QualifyForm() {
  const t = useTranslations("qualify");

  return (
    <Suspense fallback={<div className="container qualify-state">{t("loading")}</div>}>
      <QualifyFormInner />
    </Suspense>
  );
}
