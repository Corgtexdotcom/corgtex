import type { Metadata } from "next";
import { ScrollReveal } from "../../../components/ScrollReveal";
import { StructuredData } from "../../../components/StructuredData";
import { localeFromParams, hrefFor, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";
import { demoUrlForLocale } from "../../../lib/site";

const copy = {
  en: {
    metadata: {
      title: "FAQ - AI Workforce Governance",
      description: "Answers to common questions about governing AI workforces, agent visibility, cost attribution, and Corgtex.",
    },
    label: "Knowledge Base",
    title: "Frequently Asked Questions",
    intro: "Everything you need to know about Corgtex, AI workforce governance, and implementing governed AI operations.",
    productUpdates: "Product Updates",
    productUpdatesBody: "See what's new in Corgtex - latest features, improvements, and fixes.",
    changelog: "View Changelog ->",
    ctaTitle: "Ready to see it in action?",
    ctaBody: "Walk through the Workforce Graph, governance workflows, cost attribution, and your morning briefing in our interactive demo.",
    demo: "Access the Demo",
    briefing: "Schedule a Briefing",
    faqs: [
      ["What is Corgtex?", "Corgtex is a governed AI workforce platform. It gives you total visibility into every AI agent - what it's doing, what data it touches, what it costs - governed by your organizational policies."],
      ["How does Corgtex work?", "Corgtex maps your AI tools and agents into a Workforce Graph, applies governance policies and approvals, attributes costs to real work, and surfaces everything in a personalized daily briefing."],
      ["What is an organizational operating system?", "An organizational operating system unifies the management of your AI workforce. Instead of separate dashboards for each tool, one platform governs agents, tracks costs, and surfaces outcomes."],
      ["How does Corgtex use AI for governance?", "Corgtex uses AI to automatically route proposals to the correct domain experts based on organizational structure. It facilitates consent-based decision-making by tracking objections, ensuring policies are followed, and providing a complete, cited audit trail for every decision made."],
      ["What is a personalized organizational briefing?", "A personalized briefing is the role-specific daily surface for your AI workforce. Instead of generic company-wide updates, Corgtex shows each leader the agent activity, governance decisions, costs, and anomalies they need to know and act on."],
      ["How does Corgtex compare to GlassFrog or Holacracy tools?", "While GlassFrog primarily enforces Holacracy rules and records structure, Corgtex adds AI workforce visibility, governance guardrails, cost attribution, and personalized briefings on top of structural accountability."],
      ["Can Corgtex replace traditional management software?", "Yes. Corgtex is designed to replace passive wikis, governance tools, and fragmented communication platforms. It provides a unified interface for knowledge management, organizational communication, financial tracking, and decentralized decision-making."],
      ["How long does it take to set up Corgtex?", "Corgtex can be live in weeks. Weeks 1-2 involve connecting your existing tools and mapping your organizational structure. Weeks 2-4 involve the AI classifying historical data and running initial governance workflows. By week 4, personalized briefings are fully operational."],
      ["Does Corgtex integrate with existing tools?", "Yes. Corgtex integrates with platforms you already use, such as Slack and Google Workspace. Additionally, via the Model Context Protocol (MCP), Corgtex can surface governed AI workforce context directly inside interfaces like ChatGPT, Claude, and Gemini."],
      ["Is Corgtex available on-premise?", "Yes. Corgtex offers flexible deployment options. We offer a fully managed Cloud version, an On-Premise appliance where data never leaves your building, and a Hybrid option keeping sensitive data local while offloading processing to the cloud."],
      ["What kind of organizations use Corgtex?", "Corgtex is used by enterprise clients scaling decentralized structures. For example, our enterprise launch partner uses Corgtex to transform a portfolio of 1,000 acquired companies across the United States into self-managing, employee-owned entities."],
      ["How does Corgtex handle data security?", "Data security is handled through strict role-based access controls mapped to your organizational structure. For organizations with extreme security requirements, our On-Premise appliance option ensures proprietary data never touches external cloud networks."],
      ["What is consent-based decision-making?", "Consent-based decision-making is a governance process where a proposal advances unless a participant raises a substantiated, paramount objection. It prevents committee bottlenecks by prioritizing 'safe to try' actions over absolute consensus."],
      ["How does Corgtex eliminate institutional knowledge loss?", "Corgtex prevents knowledge loss by indexing every document, meeting transcription, and formal decision. When an employee asks why a decision was made years ago, Corgtex instantly retrieves the records, dissenting opinions, and outcome - with citations."],
      ["How much does Corgtex cost?", "Corgtex operates on custom enterprise pricing. The cost is scaled based on the size of your organization, the deployment model required, and the specific intelligence capabilities implemented. Contact us to schedule a scoping briefing."],
    ],
  },
  es: {
    metadata: {
      title: "FAQ - Gobernanza de fuerza laboral de IA",
      description: "Respuestas a preguntas comunes sobre gobernar fuerzas laborales de IA, visibilidad de agentes, atribución de costos y Corgtex.",
    },
    label: "Base de conocimiento",
    title: "Preguntas frecuentes",
    intro: "Todo lo que necesitas saber sobre Corgtex, gobernanza de fuerzas laborales de IA e implementación de operaciones de IA gobernadas.",
    productUpdates: "Actualizaciones de producto",
    productUpdatesBody: "Ve qué hay de nuevo en Corgtex: funciones recientes, mejoras y correcciones.",
    changelog: "Ver changelog ->",
    ctaTitle: "¿Listo para verlo en acción?",
    ctaBody: "Explora el Workforce Graph, los flujos de gobernanza, la atribución de costos y tu briefing matutino en nuestra demo interactiva.",
    demo: "Acceder a la demo",
    briefing: "Agendar una sesión",
    faqs: [
      ["¿Qué es Corgtex?", "Corgtex es una plataforma de fuerza laboral de IA gobernada. Te da visibilidad total sobre cada agente de IA: qué hace, qué datos toca y cuánto cuesta, bajo tus políticas organizacionales."],
      ["¿Cómo funciona Corgtex?", "Corgtex mapea tus herramientas y agentes de IA en un Workforce Graph, aplica políticas y aprobaciones de gobernanza, atribuye costos al trabajo real y muestra todo en un briefing diario personalizado."],
      ["¿Qué es un sistema operativo organizacional?", "Un sistema operativo organizacional unifica la gestión de tu fuerza laboral de IA. En lugar de tableros separados para cada herramienta, una sola plataforma gobierna agentes, rastrea costos y muestra resultados."],
      ["¿Cómo usa Corgtex la IA para gobernanza?", "Corgtex usa IA para enviar automáticamente propuestas a los expertos de dominio correctos según la estructura organizacional. Facilita la toma de decisiones por consentimiento al rastrear objeciones, verificar políticas y entregar una auditoría completa con citas."],
      ["¿Qué es un briefing organizacional personalizado?", "Es la superficie diaria específica por rol para tu fuerza laboral de IA. En lugar de actualizaciones genéricas, Corgtex muestra a cada líder la actividad de agentes, decisiones, costos y anomalías que necesita conocer y atender."],
      ["¿Cómo se compara Corgtex con GlassFrog o herramientas de Holacracy?", "GlassFrog principalmente registra estructura y reglas de Holacracy. Corgtex agrega visibilidad de fuerza laboral de IA, guardrails de gobernanza, atribución de costos y briefings personalizados sobre la responsabilidad estructural."],
      ["¿Puede Corgtex reemplazar software de gestión tradicional?", "Sí. Corgtex está diseñado para reemplazar wikis pasivas, herramientas de gobernanza y plataformas de comunicación fragmentadas. Ofrece una interfaz unificada para conocimiento, comunicación organizacional, finanzas y toma de decisiones descentralizada."],
      ["¿Cuánto tarda configurar Corgtex?", "Corgtex puede estar en vivo en semanas. Las semanas 1-2 conectan herramientas y mapean estructura. Las semanas 2-4 clasifican datos históricos y ejecutan los primeros flujos de gobernanza. Para la semana 4, los briefings personalizados están operativos."],
      ["¿Corgtex se integra con herramientas existentes?", "Sí. Corgtex se integra con plataformas que ya usas, como Slack y Google Workspace. Además, mediante Model Context Protocol (MCP), Corgtex puede mostrar contexto gobernado directamente en ChatGPT, Claude y Gemini."],
      ["¿Corgtex está disponible on-premise?", "Sí. Corgtex ofrece despliegue Cloud administrado, appliance On-Premise donde los datos nunca salen de tu edificio y modalidad híbrida para mantener datos sensibles localmente mientras se procesa en la nube."],
      ["¿Qué tipo de organizaciones usan Corgtex?", "Corgtex es usado por clientes enterprise que escalan estructuras descentralizadas. Por ejemplo, nuestro partner enterprise inicial usa Corgtex para transformar un portafolio de 1,000 empresas adquiridas en organizaciones autogestionadas y propiedad de empleados."],
      ["¿Cómo maneja Corgtex la seguridad de datos?", "La seguridad se maneja con controles estrictos basados en roles mapeados a tu estructura organizacional. Para requisitos extremos, el appliance On-Premise asegura que los datos propietarios no toquen redes cloud externas."],
      ["¿Qué es la toma de decisiones por consentimiento?", "Es un proceso de gobernanza donde una propuesta avanza salvo que alguien plantee una objeción fundamentada y primordial. Evita cuellos de botella de comités al priorizar acciones 'seguras para probar' sobre consenso absoluto."],
      ["¿Cómo elimina Corgtex la pérdida de conocimiento institucional?", "Corgtex evita esa pérdida indexando documentos, transcripciones y decisiones formales. Cuando alguien pregunta por qué se tomó una decisión años atrás, Corgtex recupera registros, opiniones disidentes y resultado, con citas."],
      ["¿Cuánto cuesta Corgtex?", "Corgtex opera con precios enterprise personalizados. El costo escala según el tamaño de tu organización, el modelo de despliegue requerido y las capacidades de inteligencia implementadas. Contáctanos para agendar una sesión de alcance."],
    ],
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path: "/faq" });
}

export default async function FAQPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: t.faqs.map(([question, answer]) => ({
      "@type": "Question",
      name: question,
      acceptedAnswer: {
        "@type": "Answer",
        text: answer,
      },
    })),
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
          <div className="faq-grid" style={{ display: "flex", flexDirection: "column", gap: "48px" }}>
            {t.faqs.map(([question, answer], index) => (
              <ScrollReveal key={question} delay={Math.min(index * 50, 300)}>
                <div className="faq-item" id={`faq-${index}`}>
                  <h3 style={{ fontSize: "1.5rem", marginBottom: "16px", fontFamily: "var(--font-serif)" }}>{question}</h3>
                  <p style={{ fontSize: "1.1rem", lineHeight: "1.7", color: "var(--text-secondary)" }}>{answer}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: "32px", paddingBottom: "32px" }}>
        <div className="container" style={{ maxWidth: "800px" }}>
          <ScrollReveal>
            <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "24px", flexWrap: "wrap" }}>
              <div>
                <h3 style={{ fontSize: "1.3rem", marginBottom: "8px" }}>{t.productUpdates}</h3>
                <p style={{ color: "var(--text-secondary)", margin: 0 }}>{t.productUpdatesBody}</p>
              </div>
              <a href={hrefFor(locale, "/updates")} className="btn btn-secondary" style={{ whiteSpace: "nowrap" }}>{t.changelog}</a>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-dark cta-banner">
        <div className="container">
          <ScrollReveal>
            <h2>{t.ctaTitle}</h2>
            <p>{t.ctaBody}</p>
            <div className="btn-group">
              <a href={demoUrlForLocale(locale)} className="btn btn-primary" target="_blank" rel="noopener noreferrer">{t.demo}</a>
              <a href="https://calendar.app.google/jJd5yeSuDStVZm896" className="btn btn-secondary" target="_blank" rel="noopener noreferrer">{t.briefing}</a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
