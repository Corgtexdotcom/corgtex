"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { signupAction } from "./actions";
import type { SignupState } from "./state";

function SubmitButton() {
  const { pending } = useFormStatus();
  const t = useTranslations("auth");

  return (
    <button type="submit" disabled={pending}>
      {pending ? t("signupSubmitting") : t("signupSubmit")}
    </button>
  );
}

function AccountLinks() {
  const locale = useLocale();
  const t = useTranslations("auth");
  const loginHref = locale === "es" ? "/es/login" : "/login";
  const findAccountHref = locale === "es" ? "/es/find-account" : "/find-account";

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8, fontSize: 14 }}>
      <Link href={loginHref} className="muted">
        {t("backToLogin")}
      </Link>
      <Link href={findAccountHref} className="muted">
        {t("findEnterpriseAccount")}
      </Link>
    </div>
  );
}

export function SignupForm({ initialState }: { initialState: SignupState }) {
  const [state, formAction] = useActionState(signupAction, initialState);
  const t = useTranslations("auth");

  if (state.status === "active") {
    return (
      <div className="stack" style={{ marginTop: 20 }}>
        <div className="form-message form-message-success" role="status">
          <p style={{ fontWeight: 600, marginBottom: 4 }}>{t("signupSuccessTitle")}</p>
          <p className="muted" style={{ fontSize: 14 }}>
            {t("signupSuccessDescription")}
          </p>
        </div>
        <AccountLinks />
      </div>
    );
  }

  if (state.status === "review") {
    return (
      <div className="stack" style={{ marginTop: 20 }}>
        <div className="form-message form-message-success" role="status">
          <p style={{ fontWeight: 600, marginBottom: 4 }}>{t("signupReviewTitle")}</p>
          <p className="muted" style={{ fontSize: 14 }}>
            {t("signupReviewDescription")}
          </p>
        </div>
        <AccountLinks />
      </div>
    );
  }

  if (state.status === "existingAccount") {
    return (
      <div className="stack" style={{ marginTop: 20 }}>
        <div className="form-message form-message-success" role="status">
          <p style={{ fontWeight: 600, marginBottom: 4 }}>{t("signupExistingAccountTitle")}</p>
          <p className="muted" style={{ fontSize: 14 }}>
            {t("signupExistingAccountDescription")}
          </p>
        </div>
        <AccountLinks />
      </div>
    );
  }

  return (
    <form action={formAction} className="stack" style={{ marginTop: 20 }}>
      <input type="hidden" name="idempotencyKey" value={state.idempotencyKey} />
      <label>
        {t("signupCompanyLabel")}
        <input
          name="companyName"
          type="text"
          required
          autoComplete="organization"
          defaultValue={state.companyName}
          autoFocus
        />
      </label>
      <label>
        {t("signupNameLabel")}
        <input
          name="adminName"
          type="text"
          autoComplete="name"
          defaultValue={state.adminName}
        />
      </label>
      <label>
        {t("workEmailLabel")}
        <input
          name="adminEmail"
          type="email"
          required
          autoComplete="email"
          defaultValue={state.adminEmail}
        />
      </label>
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, lineHeight: 1.45 }}>
        <input
          name="acceptedTerms"
          type="checkbox"
          required
          style={{ width: 18, marginTop: 2 }}
        />
        <span>{t("signupTerms")}</span>
      </label>
      {state.errorKey ? (
        <p className="form-message form-message-error" role="alert">
          {t(`signupErrors.${state.errorKey}`)}
        </p>
      ) : null}
      <SubmitButton />
      <AccountLinks />
    </form>
  );
}
