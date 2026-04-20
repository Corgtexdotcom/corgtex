"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="login-shell">
          <section className="panel login-card">
            <span className="tag">Corgtex</span>
            <h1 style={{ marginTop: 16 }}>Something went wrong</h1>
            <p className="muted" style={{ marginBottom: 20 }}>
              The error has been reported. Try again or return to your workspace.
            </p>
            <button type="button" onClick={reset}>
              Try again
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
