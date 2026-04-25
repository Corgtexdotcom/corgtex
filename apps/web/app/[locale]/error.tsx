"use client";

import { useTranslations } from "next-intl";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("common");
  return (
    <main className="page-shell">
      <section className="panel" style={{ maxWidth: 600, margin: "40px auto" }}>
        <h2>{t("somethingWentWrong")}</h2>
        <p className="muted">{error.message || t("unexpectedError")}</p>
        <div className="actions-inline" style={{ marginTop: 16 }}>
          <button onClick={reset}>{t("tryAgain")}</button>
          <a href="/">
            <button type="button" className="secondary">{t("goHome")}</button>
          </a>
        </div>
      </section>
    </main>
  );
}
