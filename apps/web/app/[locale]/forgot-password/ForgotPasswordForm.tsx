"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { forgotPasswordAction } from "./actions";
import { initialForgotPasswordState } from "./state";
import Link from "next/link";
import { useTranslations } from "next-intl";

function SubmitButton() {
  const { pending } = useFormStatus();
  const t = useTranslations("auth");

  return (
    <button type="submit" disabled={pending}>
      {pending ? t("sending") : t("sendResetLink")}
    </button>
  );
}

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(forgotPasswordAction, initialForgotPasswordState);
  const t = useTranslations("auth");

  if (state.success) {
    return (
      <div className="stack" style={{ marginTop: 20 }}>
        <div className="form-message form-message-success" role="status">
          <p style={{ fontWeight: 500, marginBottom: 4 }}>{t("checkYourEmail")}</p>
          <p className="muted" style={{ fontSize: 14 }}>
            {t("emailSentDescription")}
          </p>
        </div>
        <Link href="/login" style={{ marginTop: 12, display: "inline-block" }}>
          {t("backToLogin")}
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="stack" style={{ marginTop: 20 }}>
      <p className="muted" style={{ fontSize: 14, marginBottom: 8 }}>
        {t("enterEmailDescription")}
      </p>
      <label>
        {t("emailLabel")}
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={state.email}
          autoFocus
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
