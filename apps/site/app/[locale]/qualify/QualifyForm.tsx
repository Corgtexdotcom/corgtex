"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { signupUrlForLocale } from "../../../lib/site";

function QualifyFormInner() {
  const searchParams = useSearchParams();
  const token = searchParams?.get("token");
  const t = useTranslations("qualify");
  const locale = useLocale();

  const [companyName, setCompanyName] = useState("");
  const [website, setWebsite] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [aiExperience, setAiExperience] = useState("");
  const [helpNeeded, setHelpNeeded] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [linkStatus, setLinkStatus] = useState<"checking" | "available" | "unavailable" | "error">("checking");
  const [checkAttempt, setCheckAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    if (!token) {
      setLinkStatus("unavailable");
      return;
    }
    setLinkStatus("checking");
    void fetch("/api/demo-leads/qualify/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
    }).then(async (response) => {
      const data = await response.json();
      if (!current) return;
      setLinkStatus(response.ok && data.available === true ? "available"
        : data.error?.code === "QUALIFICATION_LINK_UNAVAILABLE" ? "unavailable" : "error");
    }).catch(() => { if (current) setLinkStatus("error"); });
    return () => { current = false; };
  }, [token, checkAttempt]);

  if (!token || linkStatus === "unavailable") {
    return (
      <div className="container qualify-state">
        <h1>{t("invalidTitle")}</h1>
        <p>{t("invalidBody")}</p>
        <a href={signupUrlForLocale(locale)} className="btn btn-primary">{t("startAgain")}</a>
      </div>
    );
  }

  if (linkStatus === "checking") {
    return <div className="container qualify-state" role="status">{t("loading")}</div>;
  }

  if (linkStatus === "error") {
    return (
      <div className="container qualify-state">
        <h1>{t("checkErrorTitle")}</h1>
        <p>{t("checkErrorBody")}</p>
        <button type="button" className="btn btn-primary" onClick={() => setCheckAttempt((attempt) => attempt + 1)}>{t("tryAgain")}</button>
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
      const res = await fetch("/api/demo-leads/qualify", {
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
        if (data.error?.code === "QUALIFICATION_LINK_UNAVAILABLE") {
          setLinkStatus("unavailable");
          return;
        }
        const message = typeof data.error === "string" ? data.error : data.error?.message;
        setError(typeof message === "string" ? message : t("genericError"));
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
