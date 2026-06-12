"use client";

import { FormEvent, useState } from "react";
import { useTranslations } from "next-intl";
import type { EnterpriseAccountMatch } from "@corgtex/domain";

type LookupState =
  | { status: "idle"; matches: EnterpriseAccountMatch[]; email: string; error: string | null }
  | { status: "loading"; matches: EnterpriseAccountMatch[]; email: string; error: string | null }
  | { status: "redirecting"; matches: EnterpriseAccountMatch[]; email: string; error: string | null }
  | { status: "ready"; matches: EnterpriseAccountMatch[]; email: string; error: string | null };

export function FindAccountForm() {
  const t = useTranslations("auth");
  const [state, setState] = useState<LookupState>({
    status: "idle",
    matches: [],
    email: "",
    error: null,
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    setState({ status: "loading", matches: [], email, error: null });

    try {
      const response = await fetch("/api/auth/enterprise-accounts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      });
      const body = await response.json().catch(() => null) as {
        email?: string;
        matches?: EnterpriseAccountMatch[];
        error?: { message?: string };
      } | null;

      if (!response.ok) {
        throw new Error(body?.error?.message ?? t("findAccountError"));
      }

      const matches = body?.matches ?? [];
      if (matches.length === 1 && matches[0]) {
        setState({ status: "redirecting", matches, email, error: null });
        window.location.assign(matches[0].loginUrl);
        return;
      }

      setState({
        status: "ready",
        matches,
        email: body?.email ?? email,
        error: matches.length === 0 ? t("findAccountNoMatch") : null,
      });
    } catch (error) {
      setState({
        status: "ready",
        matches: [],
        email,
        error: error instanceof Error ? error.message : t("findAccountError"),
      });
    }
  }

  const pending = state.status === "loading" || state.status === "redirecting";

  return (
    <form onSubmit={onSubmit} className="stack" style={{ marginTop: 20 }}>
      <label>
        {t("workEmailLabel")}
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={state.email}
          placeholder="you@company.com"
        />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? t("findAccountSearching") : t("findAccountSubmit")}
      </button>

      {state.error ? (
        <p className="form-message form-message-error" role="alert">
          {state.error}
        </p>
      ) : null}

      {state.status === "ready" && state.matches.length > 1 ? (
        <div className="stack" style={{ marginTop: 8 }}>
          <p className="muted" style={{ fontSize: 14 }}>
            {t("findAccountMultiple")}
          </p>
          {state.matches.map((match) => (
            <a
              key={`${match.source}:${match.workspaceId ?? match.slug}`}
              href={match.loginUrl}
              className="button-outline"
              style={{ display: "block", textAlign: "left", textDecoration: "none" }}
            >
              <strong>{match.label}</strong>
              <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 2 }}>
                {match.source === "directory" ? t("findAccountDedicated") : t("findAccountCentral")}
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </form>
  );
}
