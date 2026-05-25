import { randomUUID } from "node:crypto";
import { getTranslations } from "next-intl/server";
import { SignupForm } from "./SignupForm";
import { initialSignupState } from "./state";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const t = await getTranslations("auth");

  return (
    <main className="login-shell">
      <section className="panel login-card" style={{ width: "min(100%, 520px)" }}>
        <span className="tag">Corgtex</span>
        <h1>{t("signupTitle")}</h1>
        <p className="muted" style={{ marginBottom: "20px" }}>
          {t("signupSubtitle")}
        </p>

        <SignupForm initialState={initialSignupState(randomUUID())} />
      </section>
    </main>
  );
}
