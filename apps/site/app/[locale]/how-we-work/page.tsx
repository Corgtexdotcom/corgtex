import type { Metadata } from "next";
import { ScrollReveal } from "../../../components/ScrollReveal";
import { localeFromParams, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";
import { demoUrlForLocale } from "../../../lib/site";

const copy = {
  en: {
    metadata: {
      title: "How We Work - From Briefing to Full Ownership",
      description: "Corgtex deploys a governed AI workforce in 8 weeks. From first briefing to full ownership - no per-seat fees, no lock-in.",
    },
    label: "Engagement Model",
    title: "From First Briefing to Full Ownership",
    intro: "We don't sell software and walk away. We install a governed AI workforce, train your people, and hand you the keys.",
    phases: [
      { number: "01", badge: "45 Min", title: "Briefing", body: "We show your data on a working Corgtex. You see your organization through the newspaper for the first time." },
      { number: "02", badge: "2 Weeks", title: "Scoping", body: "We map your tools, your governance rules, your risks. A blueprint tailored to your AI landscape." },
      { number: "03", badge: "8 Weeks", title: "Implementation", body: "We install, connect, and train your people. Every agent governed, every cost visible, every workflow live." },
      { number: "04", badge: "Ongoing", title: "Live, and Yours", body: "Integrated from day one. Move it to your infrastructure whenever you want - or never. No per-seat fees. No lock-in." },
    ],
    ctaTitle: "Start With a Briefing",
    ctaBody: "45 minutes. Your data. No slides.",
    briefing: "Schedule a Briefing",
    demo: "Access the Demo",
  },
  es: {
    metadata: {
      title: "Cómo trabajamos - Del briefing a la propiedad completa",
      description: "Corgtex despliega una fuerza laboral de IA gobernada en 8 semanas. Del primer briefing a la propiedad completa: sin tarifas por usuario ni lock-in.",
    },
    label: "Modelo de colaboración",
    title: "Del primer briefing a la propiedad completa",
    intro: "No vendemos software para luego desaparecer. Instalamos una fuerza laboral de IA gobernada, entrenamos a tu equipo y te entregamos las llaves.",
    phases: [
      { number: "01", badge: "45 min", title: "Briefing", body: "Mostramos tus datos en un Corgtex funcional. Ves tu organización a través del periódico por primera vez." },
      { number: "02", badge: "2 semanas", title: "Alcance", body: "Mapeamos tus herramientas, reglas de gobernanza y riesgos. Un blueprint adaptado a tu paisaje de IA." },
      { number: "03", badge: "8 semanas", title: "Implementación", body: "Instalamos, conectamos y entrenamos a tu gente. Cada agente gobernado, cada costo visible, cada flujo en vivo." },
      { number: "04", badge: "Continuo", title: "En vivo y tuyo", body: "Integrado desde el primer día. Muévelo a tu infraestructura cuando quieras, o nunca. Sin tarifas por usuario. Sin lock-in." },
    ],
    ctaTitle: "Empieza con un briefing",
    ctaBody: "45 minutos. Tus datos. Sin diapositivas.",
    briefing: "Agendar una sesión",
    demo: "Acceder a la demo",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path: "/how-we-work" });
}

export default async function HowWeWorkPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];

  return (
    <>
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
          <div className="phases-grid">
            {t.phases.map((phase, index) => (
              <ScrollReveal key={phase.number} delay={index * 100}>
                <div className="phase-card">
                  <div className="phase-number">{phase.number}</div>
                  <span className="phase-badge">{phase.badge}</span>
                  <h3>{phase.title}</h3>
                  <p>{phase.body}</p>
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
              <a href="https://calendar.app.google/jJd5yeSuDStVZm896" className="btn btn-primary" target="_blank" rel="noopener noreferrer">{t.briefing}</a>
              <a href={demoUrlForLocale(locale)} className="btn btn-secondary" target="_blank" rel="noopener noreferrer">{t.demo}</a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
