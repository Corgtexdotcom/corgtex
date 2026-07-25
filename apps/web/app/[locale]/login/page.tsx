import { LoginForm } from "./LoginForm";
import { DemoButton } from "./DemoButton";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { hasDeploymentWorkspaceScope } from "@/lib/deployment-workspace-scope";

function singleSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const t = await getTranslations("auth");
  const findAccountHref = locale === "es" ? "/es/find-account" : "/find-account";

  function pageErrorMessage(rawError: string | string[] | undefined) {
    const error = singleSearchParam(rawError);
    if (error === "session-unavailable") {
      return t("sessionUnavailable");
    }
    return null;
  }

  function pageSuccessMessage(rawMessage: string | string[] | undefined) {
    const message = singleSearchParam(rawMessage);
    if (message === "password-reset") {
      return t("passwordReset");
    }
    if (message === "account-ready") {
      return t("accountReady");
    }
    return null;
  }

  const pageError = pageErrorMessage(resolvedSearchParams.error);
  const pageSuccess = pageSuccessMessage(resolvedSearchParams.message);
  const initialEmail = singleSearchParam(resolvedSearchParams.email);
  const showDemoLogin = !hasDeploymentWorkspaceScope();

  return (
    <main className="login-shell">
      <section className="panel login-card">
        <span className="tag">Corgtex</span>
        <h1>{t("welcomeTitle")}</h1>
        <p className="muted" style={{ marginBottom: "20px" }}>
          {t("welcomeSubtitle")}
        </p>

        {pageSuccess ? (
          <p className="form-message form-message-success" role="status" style={{ marginTop: 20 }}>
            {pageSuccess}
          </p>
        ) : null}

        {pageError ? (
          <p className="form-message form-message-error" role="alert" style={{ marginTop: 20 }}>
            {pageError}
          </p>
        ) : null}

        <LoginForm initialEmail={initialEmail} />
        <Link href={findAccountHref} className="muted" style={{ display: "inline-block", fontSize: 14, marginTop: 12 }}>
          {t("findEnterpriseAccount")}
        </Link>
        {showDemoLogin ? <DemoButton /> : null}
      </section>
    </main>
  );
}
