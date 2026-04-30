"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

function QualifyFormInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
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
      <div className="container max-w-2xl mx-auto py-20 text-center px-4">
        <h1 className="text-3xl font-bold mb-4">{t("invalidTitle")}</h1>
        <p className="text-[var(--text-secondary)]">{t("invalidBody")}</p>
      </div>
    );
  }

  if (success) {
    return (
      <div className="container max-w-2xl mx-auto py-20 text-center px-4">
        <h1 className="text-3xl font-bold mb-4">{t("successTitle")}</h1>
        <p className="text-[var(--text-secondary)]">{t("successBody")}</p>
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
    <div className="container max-w-2xl mx-auto py-12 md:py-20 px-4">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold mb-4">{t("title")}</h1>
        <p className="text-[var(--text-secondary)]">{t("description")}</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        {error && (
          <div className="p-4 bg-[var(--accent-red)] bg-opacity-10 text-[var(--accent-red)] rounded-md text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="flex flex-col gap-2">
            <label className="font-medium text-sm text-[var(--text-primary)]">{t("companyName")}</label>
            <input type="text" required value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="form-input w-full" disabled={loading} placeholder="Acme Corp" />
          </div>
          <div className="flex flex-col gap-2">
            <label className="font-medium text-sm text-[var(--text-primary)]">{t("website")}</label>
            <input type="text" required value={website} onChange={(e) => setWebsite(e.target.value)} className="form-input w-full" disabled={loading} placeholder="acme.com" />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="font-medium text-sm text-[var(--text-primary)]">{t("roleTitle")}</label>
          <input type="text" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} className="form-input w-full" disabled={loading} placeholder={t("rolePlaceholder")} />
        </div>

        <div className="flex flex-col gap-2">
          <label className="font-medium text-sm text-[var(--text-primary)]">{t("aiExperience")}</label>
          <textarea required value={aiExperience} onChange={(e) => setAiExperience(e.target.value)} className="form-input w-full min-h-[100px] resize-y" disabled={loading} placeholder={t("aiPlaceholder")} />
        </div>

        <div className="flex flex-col gap-2">
          <label className="font-medium text-sm text-[var(--text-primary)]">{t("helpNeeded")}</label>
          <textarea required value={helpNeeded} onChange={(e) => setHelpNeeded(e.target.value)} className="form-input w-full min-h-[100px] resize-y" disabled={loading} placeholder={t("helpPlaceholder")} />
        </div>

        <div className="mt-4">
          <button type="submit" className="btn btn-primary w-full py-3" disabled={loading}>
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
    <Suspense fallback={<div className="container max-w-2xl mx-auto py-20 text-center">{t("loading")}</div>}>
      <QualifyFormInner />
    </Suspense>
  );
}
