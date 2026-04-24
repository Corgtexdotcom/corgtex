"use client";

import { useTranslations } from "next-intl";

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("error");
  return (
    <div style={{ padding: "40px 24px", display: "flex", justifyContent: "center" }}>
      <section className="panel" style={{ width: "100%", maxWidth: 500 }}>
        <h2>{t("title")}</h2>
        <p className="muted">{error.message || t("defaultMessage")}</p>
        <div className="actions-inline" style={{ marginTop: 24 }}>
          <button onClick={reset}>{t("tryAgain")}</button>
          <a href="/">
            <button type="button" className="secondary">{t("goHome")}</button>
          </a>
        </div>
      </section>
    </div>
  );
}
