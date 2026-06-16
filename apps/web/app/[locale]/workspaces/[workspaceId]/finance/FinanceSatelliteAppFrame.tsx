import type { ModuleManifest } from "@corgtex/domain/modules";

/**
 * Renders a satellite app that has graduated (embed stage) into the finance
 * module as a **first-class, full-tab application** - it replaces the native
 * finance surface entirely, the same way an installed enterprise finance app
 * does. Structured data still lives in the satellite; Corgtex keeps Brain
 * context and governance. Promotion is a Module Manifest config change.
 */
export function FinanceSatelliteAppFrame({
  embed,
  launchUrl,
}: {
  embed: ModuleManifest;
  launchUrl: string;
}) {
  const title = embed.title;
  return (
    <section
      className="enterprise-app-surface-frame"
      aria-label={`${title} finance workspace`}
      data-workspace-surface="satellite-app"
      data-workspace-surface-key="FINANCE"
      style={{
        display: "flex",
        minHeight: "calc(100vh - 32px)",
        width: "100%",
      }}
    >
      <iframe
        title={`${title} finance workspace`}
        src={launchUrl}
        style={{
          background: "transparent",
          border: 0,
          display: "block",
          flex: "1 1 auto",
          minHeight: 720,
          width: "100%",
        }}
        referrerPolicy="no-referrer"
        sandbox="allow-downloads allow-forms allow-popups allow-same-origin allow-scripts"
      />
    </section>
  );
}
