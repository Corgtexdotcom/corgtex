"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { loginAction } from "./actions";
import { initialLoginActionState } from "./state";
import { useTranslations } from "next-intl";

function SubmitButton({ label, loadingLabel }: { label: string, loadingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? loadingLabel : label}
    </button>
  );
}

export function LoginForm() {
  const [state, formAction] = useActionState(loginAction, initialLoginActionState);
  const t = useTranslations("auth");
  const common = useTranslations("common");

  return (
    <form action={formAction} className="stack" style={{ marginTop: 20 }}>
      <label>
        {t("emailLabel")}
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={state.email}
        />
      </label>
      <label>
        {t("passwordLabel")}
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="current-password"
        />
      </label>
      <div style={{ textAlign: "right", marginTop: -4 }}>
        <Link href="/forgot-password" className="muted" style={{ fontSize: 13 }}>
          {t("forgotPassword")}
        </Link>
      </div>
      {state.error ? (
        <p className="form-message form-message-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <SubmitButton label={t("loginButton")} loadingLabel={common("loading")} />
    </form>
  );
}
