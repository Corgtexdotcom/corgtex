"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { loginAction } from "./actions";
import { initialLoginActionState } from "./state";
import { useLocale, useTranslations } from "next-intl";

function SubmitButton({ label, loadingLabel }: { label: string, loadingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? loadingLabel : label}
    </button>
  );
}

export function LoginForm({ initialEmail = "" }: { initialEmail?: string }) {
  const [state, formAction] = useActionState(loginAction, initialLoginActionState);
  const locale = useLocale();
  const forgotPasswordHref = locale === "es" ? "/es/forgot-password" : "/forgot-password";
  const t = useTranslations("auth");
  const common = useTranslations("common");

  useEffect(() => {
    if (state.redirectTo) {
      window.location.assign(state.redirectTo);
    }
  }, [state.redirectTo]);

  return (
    <form action={formAction} className="stack" style={{ marginTop: 20 }}>
      <input type="hidden" name="locale" value={locale} />
      <label>
        {t("emailLabel")}
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={state.email || initialEmail}
          suppressHydrationWarning
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
          suppressHydrationWarning
        />
      </label>
      <div style={{ textAlign: "right", marginTop: -4 }}>
        <Link href={forgotPasswordHref} prefetch={false} className="muted" style={{ fontSize: 13 }}>
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
