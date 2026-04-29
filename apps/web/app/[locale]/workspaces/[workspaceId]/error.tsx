"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { useTranslations } from "next-intl";

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("error");

  useEffect(() => {
    Sentry.captureException(error, {
      tags: error.digest ? { next_digest: error.digest } : undefined,
    });
  }, [error]);

  return (
    <div style={{ padding: "40px 24px", display: "flex", justifyContent: "center" }}>
      <section className="panel" style={{ width: "100%", maxWidth: 500 }}>
        <h2>{t("title")}</h2>
        <p className="muted">{error.message || t("defaultMessage")}</p>
        {error.digest && (
          <p className="muted" style={{ fontSize: "0.8rem", marginTop: 12 }}>
            Reference: {error.digest}
          </p>
        )}
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
