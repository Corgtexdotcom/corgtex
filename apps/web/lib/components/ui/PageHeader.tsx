export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
      <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>
        {title}
      </h1>
      {subtitle && (
        <div className="nr-masthead-meta">
          <span>{subtitle}</span>
        </div>
      )}
    </header>
  );
}
