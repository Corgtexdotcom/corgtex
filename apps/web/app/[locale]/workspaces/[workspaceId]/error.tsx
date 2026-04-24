"use client";

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{ padding: "40px 24px", display: "flex", justifyContent: "center" }}>
      <section className="panel" style={{ width: "100%", maxWidth: 500 }}>
        <h2>Something went wrong</h2>
        <p className="muted">{error.message || "An unexpected error occurred."}</p>
        <div className="actions-inline" style={{ marginTop: 24 }}>
          <button onClick={reset}>Try again</button>
          <a href="/">
            <button type="button" className="secondary">Go home</button>
          </a>
        </div>
      </section>
    </div>
  );
}
