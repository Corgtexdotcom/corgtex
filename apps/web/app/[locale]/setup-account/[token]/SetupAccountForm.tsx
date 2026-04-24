"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { setupAccountAction } from "./actions";
import { initialResetPasswordState } from "./state";
import Link from "next/link";
import { useTranslations } from "next-intl";

function SubmitButton() {
  const { pending } = useFormStatus();
  const t = useTranslations("auth");

  return (
    <button type="submit" disabled={pending}>
      {pending ? t("settingUp") : t("setPasswordButton")}
    </button>
  );
}

export function SetupAccountForm({ token }: { token: string }) {
  const [state, formAction] = useActionState(setupAccountAction, initialResetPasswordState);
  const t = useTranslations("auth");

  return (
    <form action={formAction} className="stack" style={{ marginTop: 20 }}>
      <input type="hidden" name="token" value={token} />
      <label>
        {t("newPasswordLabel")}
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          autoFocus
        />
      </label>
      <label>
        {t("confirmPasswordLabel")}
        <input
          name="confirmPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />
      </label>
      {state.error ? (
        <p className="form-message form-message-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <SubmitButton />
      <Link href="/login" className="muted" style={{ fontSize: 14, marginTop: 8, display: "inline-block" }}>
        {t("backToLogin")}
      </Link>
    </form>
  );
}
