import { getSatelliteEmbedForModule } from "@corgtex/domain/modules";

/**
 * Renders a satellite app that has graduated (embed stage) into the finance
 * module as a first-class deep-tab section, while its data stays satellite-owned.
 * Driven entirely by the Module Manifest registry graduation config - promoting
 * Practice Ledger into the finance tab is a config change, not a rewrite.
 */
export function PracticeLedgerEmbed() {
  const embed = getSatelliteEmbedForModule("finance");
  if (!embed?.satellite) return null;

  const appUrl = process.env[embed.satellite.appUrlEnv]?.trim();
  const repositoryUrl = `https://${embed.satellite.repository}`;

  return (
    <section className="nr-item" style={{ marginBottom: 24, padding: 16, border: "1px solid var(--line)", borderRadius: 10 }}>
      <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
        <strong className="nr-item-title">{embed.title}</strong>
        <span className="tag">Embedded · data stays in {embed.title}</span>
      </div>
      <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: "6px 0 12px" }}>{embed.description}</p>

      {appUrl ? (
        <iframe
          src={appUrl}
          title={embed.title}
          style={{ width: "100%", height: 460, border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface)" }}
        />
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <p className="nr-item-meta" style={{ fontSize: "0.82rem" }}>
            Connect the {embed.title} app to embed it here. Structured finance records (budgets, time, margin, burn) stay in {embed.title} and sync summaries back into Corgtex Brain.
          </p>
          <a href={repositoryUrl} target="_blank" rel="noreferrer" className="nr-button" style={{ alignSelf: "flex-start" }}>
            Open {embed.title}
          </a>
        </div>
      )}
    </section>
  );
}
