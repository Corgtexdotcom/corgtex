"use client";

import { useState, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { trackEvent } from "../lib/analytics-client";
import { demoUrlForLocale } from "../lib/site";

const trackedGateViews = new Set<string>();

function trackGateView(eventName: string) {
  const path = window.location.pathname;
  const key = `${eventName}:${path}`;
  if (trackedGateViews.has(key)) return;

  trackedGateViews.add(key);
  trackEvent(eventName, { path });
}

export function DemoGateForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [showGate, setShowGate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const locale = useLocale();
  const t = useTranslations("demoGate");

  // If they already submitted their email in the past, just show a plain link
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (localStorage.getItem("corgtex_demo_lead")) {
        setShowGate(false);
        trackGateView("demo_gate_known_lead");
      } else {
        trackGateView("demo_gate_viewed");
      }
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !email.includes("@")) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/demo-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (res.ok) {
        localStorage.setItem("corgtex_demo_lead", email);
        trackEvent("demo_gate_submitted", { path: window.location.pathname });
        window.location.href = demoUrlForLocale(locale);
      } else {
        setError(t("error"));
        setLoading(false);
      }
    } catch {
      setError(t("error"));
      setLoading(false);
    }
  };

  if (!showGate) {
    return (
      <a href={demoUrlForLocale(locale)} className="btn btn-secondary" target="_blank" rel="noopener noreferrer">
        {t("button")}
      </a>
    );
  }

  return (
    <div className="demo-gate-shell">
      <form onSubmit={handleSubmit} className="demo-gate-form">
        <input
          type="email"
          placeholder={t("emailPlaceholder")}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (error) setError(null);
          }}
          required
          disabled={loading}
          className="form-input"
        />
        <button type="submit" className="btn btn-secondary" disabled={loading}>
          {loading ? t("loading") : t("button")}
        </button>
      </form>
      {error && (
        <p style={{ color: "var(--accent-red)", fontSize: "0.85rem", margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
