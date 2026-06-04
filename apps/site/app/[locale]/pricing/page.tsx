import type { Metadata } from "next";
import { ScrollReveal } from "../../../components/ScrollReveal";
import { StructuredData } from "../../../components/StructuredData";
import { localeFromParams, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";
import { getSiteConfig, signupUrlForLocale } from "../../../lib/site";

const copy = {
  en: {
    metadata: {
      title: "Pricing - Enterprise Rollout",
      description: "Corgtex operates on custom enterprise pricing tailored to the size of your organization and chosen deployment model.",
    },
    label: "Pricing",
    title: "Your AI Workforce, Priced for Scale",
    intro: "We partner with organizations serious about governing their AI workforce at scale without losing control of data, roles, decisions, or human review. Our pricing is custom, based on your scale and compliance needs.",
    deploymentLabel: "Deployment Modes",
    deploymentTitle: "Your Data, Your Infrastructure, Your Control",
    deployments: [
      { number: "I", title: "Cloud SaaS", body: "We handle the infrastructure under your governance rules. Automatic updates, zero maintenance overhead, hosted securely on our enterprise cloud." },
      { number: "II", title: "Hybrid", body: "Sensitive documents stay on your hardware. Governed metadata and processing are handled by our secure cloud." },
      { number: "III", title: "On-Premise", body: "A completely self-contained deployment. Your data and operating context never leave your building." },
    ],
    includedLabel: "All Inclusive",
    includedTitle: "Everything Included in Every Plan",
    includedBody: "No per-seat fees. No feature gates. Every enterprise partner gets the complete governed AI workforce.",
    selfServe: "Start Free Trial",
    selfServeNote: "Shared-cloud trial for teams that want to register with a work email and move immediately.",
    features: [
      ["Personalized Briefings", "Daily AI workforce briefings for every member based on their roles."],
      ["Workforce Graph", "Every AI agent mapped - what it does, what data it touches, who owns it."],
      ["Governance & Guardrails", "Policies, approvals, and human review for high-impact agent actions."],
      ["Methodology Agnostic", "Native support for O2, Holacracy, Sociocracy, employee ownership, or custom operating models."],
      ["Spend & ROI", "AI costs attributed to real work. Budgets, forecasts, surfaced next to output."],
      ["MCP Integrations", "Bring Corgtex data directly into ChatGPT, Claude, or Gemini natively."],
      ["Dedicated Success", "Direct channel to our engineering team for methodology alignment."],
    ],
    scoping: "Schedule a Scoping Briefing",
    scopingNote: "30-minute discovery call with our founding team.",
    faqTitle: "Frequently Asked Questions",
    questions: [
      ["Do you charge per seat?", "Decentralization doesn't work if you have to pay a toll for every new contributor. We price based on organizational scale and the computational resources required for your intelligence layer, not an arbitrary per-seat license."],
      ["Can we start with a pilot?", "Yes. For qualifying organizations, we offer a bounded pilot where we connect Corgtex to a subset of your tools, such as Slack and Google Drive for one division, to prove the viability of the personalized briefings before a full rollout."],
    ],
    structuredName: "Pricing",
    structuredDescription: "Enterprise pricing for Corgtex",
    offerDescription: "Custom enterprise pricing for governed AI workforce platform",
  },
  es: {
    metadata: {
      title: "Precios - Implementación enterprise",
      description: "Corgtex opera con precios enterprise personalizados según el tamaño de tu organización y el modelo de despliegue elegido.",
    },
    label: "Precios",
    title: "Tu fuerza laboral de IA, con precio para escalar",
    intro: "Trabajamos con organizaciones que toman en serio gobernar su fuerza laboral de IA a escala sin perder control de datos, roles, decisiones ni revisión humana. El precio es personalizado, según tu escala y tus necesidades de cumplimiento.",
    deploymentLabel: "Modelos de despliegue",
    deploymentTitle: "Tus datos, tu infraestructura, tu control",
    deployments: [
      { number: "I", title: "Cloud SaaS", body: "Nos encargamos de la infraestructura bajo tus reglas de gobernanza. Actualizaciones automáticas, cero mantenimiento y hosting seguro en nuestra nube enterprise." },
      { number: "II", title: "Híbrido", body: "Los documentos sensibles permanecen en tu hardware. Los metadatos gobernados y el procesamiento se manejan en nuestra nube segura." },
      { number: "III", title: "On-Premise", body: "Un despliegue completamente autónomo. Tus datos y contexto operativo nunca salen de tu edificio." },
    ],
    includedLabel: "Todo incluido",
    includedTitle: "Todo incluido en cada plan",
    includedBody: "Sin tarifas por usuario. Sin funciones bloqueadas. Cada partner enterprise recibe la fuerza laboral de IA gobernada completa.",
    selfServe: "Empezar prueba",
    selfServeNote: "Trial shared-cloud para equipos que quieren registrarse con un correo laboral y avanzar de inmediato.",
    features: [
      ["Briefings personalizados", "Briefings diarios de la fuerza laboral de IA para cada miembro según sus roles."],
      ["Workforce Graph", "Cada agente de IA mapeado: qué hace, qué datos toca y quién lo posee."],
      ["Gobernanza y guardrails", "Políticas, aprobaciones y revisión humana para acciones de agentes de alto impacto."],
      ["Agnóstico a metodología", "Soporte nativo para O2, Holacracy, Sociocracy, propiedad de empleados o modelos operativos personalizados."],
      ["Gasto y ROI", "Costos de IA atribuidos al trabajo real. Presupuestos y proyecciones junto a los resultados."],
      ["Integraciones MCP", "Lleva datos de Corgtex directamente a ChatGPT, Claude o Gemini de forma nativa."],
      ["Acompañamiento dedicado", "Canal directo con nuestro equipo de ingeniería para alinear metodología."],
    ],
    scoping: "Agendar una sesión de alcance",
    scopingNote: "Llamada de descubrimiento de 30 minutos con nuestro equipo fundador.",
    faqTitle: "Preguntas frecuentes",
    questions: [
      ["¿Cobran por usuario?", "La descentralización no funciona si tienes que pagar un peaje por cada nuevo contribuidor. Cobramos según la escala organizacional y los recursos computacionales requeridos para tu capa de inteligencia, no por una licencia arbitraria por usuario."],
      ["¿Podemos empezar con un piloto?", "Sí. Para organizaciones calificadas ofrecemos un piloto acotado en el que conectamos Corgtex a una parte de tus herramientas, como Slack y Google Drive para una división, para probar la viabilidad de los briefings personalizados antes del despliegue completo."],
    ],
    structuredName: "Precios",
    structuredDescription: "Precios enterprise para Corgtex",
    offerDescription: "Precios enterprise personalizados para una plataforma de fuerza laboral de IA gobernada",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path: "/pricing" });
}

export default async function PricingPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];
  const { bookDemoUrl } = getSiteConfig();
  const signupUrl = signupUrlForLocale(locale);
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: t.structuredName,
    description: t.structuredDescription,
    offer: {
      "@type": "Offer",
      businessFunction: "http://purl.org/goodrelations/v1#ProvideService",
      description: t.offerDescription,
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

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">{t.deploymentLabel}</span>
              <h2>{t.deploymentTitle}</h2>
            </div>
          </ScrollReveal>

          <div className="cards-grid deployment-cards">
            {t.deployments.map((deployment, index) => (
              <ScrollReveal key={deployment.title} delay={index * 100}>
                <div className="card">
                  <div className="card-number" style={{ fontSize: "2rem" }}>{deployment.number}</div>
                  <h3>{deployment.title}</h3>
                  <p>{deployment.body}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container" style={{ maxWidth: "800px" }}>
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">{t.includedLabel}</span>
              <h2>{t.includedTitle}</h2>
              <p>{t.includedBody}</p>
            </div>
          </ScrollReveal>

          <ScrollReveal delay={100}>
            <div className="pricing-features">
              <div className="pricing-feature-list">
                {t.features.map(([title, body]) => (
                  <div className="pricing-feature-item" key={title}>
                    <strong>{title}</strong>
                    <span>{body}</span>
                  </div>
                ))}
              </div>
            </div>
          </ScrollReveal>

          <ScrollReveal delay={200}>
            <div className="pricing-cta">
              <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
                <a href={signupUrl} className="btn btn-primary">
                  {t.selfServe}
                </a>
                <a href={bookDemoUrl} className="btn btn-secondary" target="_blank" rel="noopener noreferrer">
                  {t.scoping}
                </a>
              </div>
              <p style={{ marginTop: "16px", fontSize: "0.9rem", color: "var(--text-secondary)" }}>{t.selfServeNote}</p>
              <p style={{ marginTop: "6px", fontSize: "0.85rem", color: "var(--text-tertiary)" }}>
                {t.scoping}
                {" - "}
                {t.scopingNote}
              </p>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container" style={{ maxWidth: "800px" }}>
          <ScrollReveal>
            <div className="section-header">
              <h2>{t.faqTitle}</h2>
            </div>
          </ScrollReveal>

          <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
            {t.questions.map(([question, answer], index) => (
              <ScrollReveal key={question} delay={index * 100}>
                <div>
                  <h3 style={{ fontSize: "1.3rem", marginBottom: "8px" }}>{question}</h3>
                  <p style={{ color: "var(--text-secondary)" }}>{answer}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
