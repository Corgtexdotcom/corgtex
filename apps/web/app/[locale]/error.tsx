"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="page-shell">
      <section className="panel" style={{ maxWidth: 600, margin: "40px auto" }}>
        <h2>Something went wrong</h2>
        <p className="muted">{error.message || "An unexpected error occurred."}</p>
        <div className="actions-inline" style={{ marginTop: 16 }}>
          <button onClick={reset}>Try again</button>
          <a href="/">
            <button type="button" className="secondary">Go home</button>
          </a>
        </div>
      </section>
    </main>
  );
}
