import { ResetPasswordForm } from "./ResetPasswordForm";
import { getTranslations } from "next-intl/server";

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const t = await getTranslations("auth");

  return (
    <main className="login-shell">
      <section className="panel login-card">
        <span className="tag">Corgtex</span>
        <h1 style={{ marginTop: 16 }}>{t("setNewPasswordTitle")}</h1>
        <p className="muted">
          {t("setNewPasswordSubtitle")}
        </p>

        <ResetPasswordForm token={token} />
      </section>
    </main>
  );
}
