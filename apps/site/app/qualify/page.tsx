"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

function QualifyFormInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  
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
        <h1 className="text-3xl font-bold mb-4">Invalid Link</h1>
        <p className="text-[var(--text-secondary)]">The qualification link appears to be missing or invalid. Please check the email you received.</p>
      </div>
    );
  }

  if (success) {
    return (
      <div className="container max-w-2xl mx-auto py-20 text-center px-4">
        <h1 className="text-3xl font-bold mb-4">Thank You!</h1>
        <p className="text-[var(--text-secondary)]">We&apos;ve received your information. Our team will review your request and get back to you within 24 hours.</p>
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
        setError(data.error || "Something went wrong. Please try again.");
      }
    } catch {
      setError("Failed to submit form. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container max-w-2xl mx-auto py-12 md:py-20 px-4">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold mb-4">Set up your Corgtex trial</h1>
        <p className="text-[var(--text-secondary)]">
          Tell us a bit about your company to help us tailor your workspace.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        {error && (
          <div className="p-4 bg-[var(--accent-red)] bg-opacity-10 text-[var(--accent-red)] rounded-md text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="flex flex-col gap-2">
            <label className="font-medium text-sm text-[var(--text-primary)]">Company Name *</label>
            <input
              type="text"
              required
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="form-input w-full"
              disabled={loading}
              placeholder="Acme Corp"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="font-medium text-sm text-[var(--text-primary)]">Website *</label>
            <input
              type="text"
              required
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              className="form-input w-full"
              disabled={loading}
              placeholder="acme.com"
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="font-medium text-sm text-[var(--text-primary)]">Your Role / Title</label>
          <input
            type="text"
            value={roleTitle}
            onChange={(e) => setRoleTitle(e.target.value)}
            className="form-input w-full"
            disabled={loading}
            placeholder="e.g. CTO, Operations Manager"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="font-medium text-sm text-[var(--text-primary)]">How has your experience with AI been so far? *</label>
          <textarea
            required
            value={aiExperience}
            onChange={(e) => setAiExperience(e.target.value)}
            className="form-input w-full min-h-[100px] resize-y"
            disabled={loading}
            placeholder="Tell us what you've tried..."
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="font-medium text-sm text-[var(--text-primary)]">What help would you appreciate the most? *</label>
          <textarea
            required
            value={helpNeeded}
            onChange={(e) => setHelpNeeded(e.target.value)}
            className="form-input w-full min-h-[100px] resize-y"
            disabled={loading}
            placeholder="e.g. Automating customer support, organizing internal knowledge..."
          />
        </div>

        <div className="mt-4">
          <button type="submit" className="btn btn-primary w-full py-3" disabled={loading}>
            {loading ? "Submitting..." : "Submit Request"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function QualifyPage() {
  return (
    <Suspense fallback={<div className="container max-w-2xl mx-auto py-20 text-center">Loading...</div>}>
      <QualifyFormInner />
    </Suspense>
  );
}
