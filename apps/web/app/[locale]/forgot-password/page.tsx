import { ForgotPasswordForm } from "./ForgotPasswordForm";
import { getTranslations } from "next-intl/server";

export default async function ForgotPasswordPage() {
  const t = await getTranslations("auth");

  return (
    <main className="login-shell">
      <section className="panel login-card">
        <span className="tag">Corgtex</span>
        <h1 style={{ marginTop: 16 }}>{t("resetPasswordTitle")}</h1>
        <p className="muted">
          {t("resetPasswordSubtitle")}
        </p>

        <ForgotPasswordForm />
      </section>
    </main>
  );
}
