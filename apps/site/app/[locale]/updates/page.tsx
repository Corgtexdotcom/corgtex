import type { Metadata } from "next";
import { ScrollReveal } from "../../../components/ScrollReveal";
import { StructuredData } from "../../../components/StructuredData";
import { localeFromParams, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";
import { demoGatePathForLocale } from "../../../lib/site";

const updatesEn = [
  { version: "v0.10", name: "Intelligence Layer", date: "Apr 14-15, 2026", prs: "#97-#99", features: ["Integrated O2 organizational methodology alongside Holacracy and Sociocracy.", "Upgraded finance agent UX with seamless inline approval workflows.", "Added native subtitles and improved audio playback for landing page videos."] },
  { version: "v0.9", name: "Production Hardening", date: "Apr 12-13, 2026", prs: "#74-#89", features: ["Separated build-time execution from database mutation for safer deployments.", "Visual upgrade to the Corgtex marketing interface with an editorial newspaper aesthetic.", "Resolved autonomous deployment stability issues.", "Refactored site copy for sharper thought leadership positioning."] },
  { version: "v0.8", name: "Chat & Governance", date: "Apr 9, 2026", prs: "#58-#62", features: ["Introduced the Chat Newsroom interface for conversational briefings.", "Added the ability for agents to autonomously review run results.", "Seeded the first 10 points of the governance constitution automatically for new workspaces."] },
  { version: "v0.7", name: "Newsroom & Chat", date: "Apr 9, 2026", prs: "#51-#56", features: ["Implemented chat streaming for faster conversational responses.", "Refactored the newsroom architecture for better scale and performance.", "Added guided MCP (Model Context Protocol) connection flows.", "Resolved markdown rendering issues in production."] },
  { version: "v0.6", name: "Knowledge & Finance", date: "Apr 9, 2026", prs: "#45-#49", features: ["Launched the Wiki Dashboard for centralized organizational knowledge.", "Introduced full-screen file uploads in the chat interface.", "Released v1 of the Finance and Accounting UI.", "Added automatic brain data seeding for new workspaces.", "Cleaned up legacy knowledge retrieval code."] },
  { version: "v0.5", name: "Event System", date: "Apr 8, 2026", prs: "#32-#33", features: ["Implemented global event ingestion across all organizational tools.", "Fixed issues related to organizational brain backups and restoration."] },
  { version: "v0.4", name: "Organizational Brain", date: "Apr 7, 2026", prs: "#24-#28", features: ["Rewrote the brain data layer for highly accurate RAG search.", "Introduced dedicated brain API routes for agent execution.", "Created the absorb agent workflow for ingesting unstructured data.", "Built out the Brain UI and maintenance tools."] },
  { version: "v0.3", name: "Agent Runtime", date: "Apr 3, 2026", prs: "#11-#14", features: ["Launched Agent Runtime v1 to execute autonomous operations.", "Released the Operator Console for administrative oversight.", "Enhanced security and hardening across the agent boundary.", "Fixed agent testing and documentation scripts."] },
  { version: "v0.2", name: "Business Logic", date: "Apr 2-3, 2026", prs: "#8-#10", features: ["Established business workflow parity with manual processes.", "Completed the event runtime completion state engine.", "Introduced the model gateway for switching between LLM providers."] },
  { version: "v0.1", name: "Foundation", date: "Apr 2, 2026", prs: "#1-#5", features: ["Initial CRUD operations for circles, proposals, and members.", "Foundational UI enhancements and layout framework.", "Comprehensive test coverage integration.", "Established continuous deployment pipelines.", "Implemented server-side pagination."] },
];

const updatesEs = [
  { version: "v0.10", name: "Capa de inteligencia", date: "14-15 abr 2026", prs: "#97-#99", features: ["Integramos la metodología organizacional O2 junto a Holacracy y Sociocracy.", "Mejoramos la UX del agente financiero con flujos de aprobación inline.", "Agregamos subtítulos nativos y mejor reproducción de audio para videos del sitio."] },
  { version: "v0.9", name: "Endurecimiento de producción", date: "12-13 abr 2026", prs: "#74-#89", features: ["Separamos ejecución de build de mutaciones de base de datos para despliegues más seguros.", "Actualizamos visualmente el sitio con una estética editorial tipo periódico.", "Resolvimos problemas de estabilidad en despliegues autónomos.", "Refinamos el copy del sitio para un posicionamiento más claro."] },
  { version: "v0.8", name: "Chat y gobernanza", date: "9 abr 2026", prs: "#58-#62", features: ["Introdujimos la interfaz Chat Newsroom para briefings conversacionales.", "Agregamos capacidad para que agentes revisen resultados de ejecución de forma autónoma.", "Sembramos automáticamente los primeros 10 puntos de la constitución de gobernanza en nuevos workspaces."] },
  { version: "v0.7", name: "Newsroom y chat", date: "9 abr 2026", prs: "#51-#56", features: ["Implementamos streaming de chat para respuestas más rápidas.", "Refactorizamos la arquitectura de newsroom para escala y rendimiento.", "Agregamos flujos guiados de conexión MCP (Model Context Protocol).", "Resolvimos problemas de renderizado Markdown en producción."] },
  { version: "v0.6", name: "Conocimiento y finanzas", date: "9 abr 2026", prs: "#45-#49", features: ["Lanzamos Wiki Dashboard para conocimiento organizacional centralizado.", "Introdujimos cargas de archivos en pantalla completa dentro del chat.", "Publicamos la v1 de la UI de Finanzas y Contabilidad.", "Agregamos seed automático de datos cerebrales para nuevos workspaces.", "Limpiamos código legado de recuperación de conocimiento."] },
  { version: "v0.5", name: "Sistema de eventos", date: "8 abr 2026", prs: "#32-#33", features: ["Implementamos ingesta global de eventos en todas las herramientas organizacionales.", "Corregimos problemas de backups y restauración del cerebro organizacional."] },
  { version: "v0.4", name: "Cerebro organizacional", date: "7 abr 2026", prs: "#24-#28", features: ["Reescribimos la capa de datos del cerebro para búsquedas RAG más precisas.", "Introdujimos rutas API dedicadas para ejecución de agentes.", "Creamos el flujo del agente absorb para ingerir datos no estructurados.", "Desarrollamos la UI del Brain y herramientas de mantenimiento."] },
  { version: "v0.3", name: "Runtime de agentes", date: "3 abr 2026", prs: "#11-#14", features: ["Lanzamos Agent Runtime v1 para ejecutar operaciones autónomas.", "Publicamos Operator Console para supervisión administrativa.", "Endurecimos la seguridad en el límite de agentes.", "Corregimos pruebas y scripts de documentación de agentes."] },
  { version: "v0.2", name: "Lógica de negocio", date: "2-3 abr 2026", prs: "#8-#10", features: ["Logramos paridad de flujos de negocio con procesos manuales.", "Completamos el motor de estado de finalización del runtime de eventos.", "Introdujimos el gateway de modelos para cambiar entre proveedores LLM."] },
  { version: "v0.1", name: "Fundación", date: "2 abr 2026", prs: "#1-#5", features: ["CRUD inicial para círculos, propuestas y miembros.", "Mejoras fundacionales de UI y marco de layout.", "Integración amplia de cobertura de pruebas.", "Establecimos pipelines de despliegue continuo.", "Implementamos paginación server-side."] },
];

const copy = {
  en: {
    metadata: {
      title: "Product Updates",
      description: "Changelog and product updates for Corgtex, the intelligence layer for self-managing organizations.",
    },
    label: "Changelog",
    title: "Product Updates",
    intro: "The continuous evolution of the Corgtex intelligent operating system, built transparently.",
    ctaTitle: "Want to see the latest version?",
    ctaBody: "Walk through circles, proposals, the knowledge base, and an intelligent briefing in our interactive demo.",
    demo: "Try the Live Demo",
    structuredName: "Product Updates",
    structuredDescription: "Changelog and product updates for Corgtex",
    updates: updatesEn,
  },
  es: {
    metadata: {
      title: "Actualizaciones de producto",
      description: "Changelog y actualizaciones de Corgtex, la capa de inteligencia para organizaciones autogestionadas.",
    },
    label: "Changelog",
    title: "Actualizaciones de producto",
    intro: "La evolución continua del sistema operativo inteligente de Corgtex, construido con transparencia.",
    ctaTitle: "¿Quieres ver la última versión?",
    ctaBody: "Explora círculos, propuestas, la base de conocimiento y un briefing inteligente en nuestra demo interactiva.",
    demo: "Probar la demo en vivo",
    structuredName: "Actualizaciones de producto",
    structuredDescription: "Changelog y actualizaciones de producto para Corgtex",
    updates: updatesEs,
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path: "/updates" });
}

export default async function UpdatesPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: t.structuredName,
    description: t.structuredDescription,
    publisher: {
      "@id": "https://corgtex.com/#organization",
    },
  };

  return (
    <>
      <StructuredData data={structuredData} />

      <section className="section" style={{ paddingBottom: "48px" }}>
        <div className="container" style={{ maxWidth: "800px", textAlign: "center" }}>
          <ScrollReveal><span className="section-label">{t.label}</span></ScrollReveal>
          <ScrollReveal delay={100}><h1 style={{ marginTop: "24px" }}>{t.title}</h1></ScrollReveal>
          <ScrollReveal delay={200}>
            <p style={{ fontSize: "1.2rem", maxWidth: "620px", margin: "24px auto 0", color: "var(--text-secondary)" }}>{t.intro}</p>
          </ScrollReveal>
        </div>
      </section>

      <div className="rule-strong" style={{ maxWidth: "var(--max-width)", margin: "0 auto" }} />

      <section className="section">
        <div className="container" style={{ maxWidth: "800px" }}>
          <div className="changelog-timeline">
            {t.updates.map((update, index) => (
              <ScrollReveal key={update.version} delay={Math.min(index * 50, 300)}>
                <div className="changelog-entry">
                  <div className="changelog-header">
                    <div className="changelog-version">
                      <span className="version-badge">{update.version}</span>
                      <span className="version-name">{update.name}</span>
                    </div>
                    <div className="changelog-meta">
                      <span className="changelog-date">{update.date}</span>
                      <span className="changelog-prs">{update.prs}</span>
                    </div>
                  </div>
                  <ul className="changelog-features">
                    {update.features.map((feature) => <li key={feature}>{feature}</li>)}
                  </ul>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-dark cta-banner">
        <div className="container">
          <ScrollReveal>
            <h2>{t.ctaTitle}</h2>
            <p>{t.ctaBody}</p>
            <div className="btn-group">
              <a href={demoGatePathForLocale(locale)} className="btn btn-primary">{t.demo}</a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
