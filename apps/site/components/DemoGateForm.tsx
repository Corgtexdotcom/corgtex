"use client";

import { useState, useEffect } from "react";
import { getSiteConfig } from "../lib/site";

export function DemoGateForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [showGate, setShowGate] = useState(true);

  // If they already submitted their email in the past, just show a plain link
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (localStorage.getItem("corgtex_demo_lead")) {
        setShowGate(false);
      }
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !email.includes("@")) return;

    setLoading(true);
    try {
      const res = await fetch("/api/demo-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (res.ok) {
        localStorage.setItem("corgtex_demo_lead", email);
        const { demoUrl } = getSiteConfig();
        window.location.href = demoUrl;
      } else {
        alert("Failed to access demo. Please try again.");
        setLoading(false);
      }
    } catch {
      alert("Failed to access demo. Please try again.");
      setLoading(false);
    }
  };

  if (!showGate) {
    const { demoUrl } = getSiteConfig();
    return (
      <a href={demoUrl} className="btn btn-secondary" target="_blank" rel="noopener noreferrer">
        Access the Demo
      </a>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="demo-gate-form" style={{ display: "flex", gap: "8px", alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}>
      <input
        type="email"
        placeholder="Enter your email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        disabled={loading}
        className="form-input"
      />
      <button type="submit" className="btn btn-secondary" disabled={loading}>
        {loading ? "..." : "Access the Demo"}
      </button>
    </form>
  );
}
