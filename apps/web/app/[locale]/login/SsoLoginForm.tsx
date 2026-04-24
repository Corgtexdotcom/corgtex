"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

function SsoSubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className="button-outline">
      {pending ? "Redirecting..." : "Continue with SSO"}
    </button>
  );
}

export function SsoLoginForm() {
  const [showSso, setShowSso] = useState(false);

  if (!showSso) {
    return (
      <button 
        type="button" 
        className="button-outline" 
        style={{ width: "100%", marginTop: 10 }}
        onClick={() => setShowSso(true)}
      >
        Sign in with Google / Microsoft
      </button>
    );
  }

  return (
    <form action="/api/auth/sso/init" method="GET" className="stack" style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--line)" }}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        Enter your work email to continue to your organization&apos;s identity provider.
      </p>
      <label>
        Work Email
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
