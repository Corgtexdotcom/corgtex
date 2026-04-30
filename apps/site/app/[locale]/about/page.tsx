import type { Metadata } from "next";
import Image from "next/image";
import { ScrollReveal } from "../../../components/ScrollReveal";
import { localeFromParams, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";
import { demoGatePathForLocale, getSiteConfig } from "../../../lib/site";

const copy = {
  en: {
    metadata: {
      title: "About",
      description: "Corgtex was created by Jan 'Puncar' Brezina, Penguin Random House author and decade-long practitioner of decentralized governance, Holacracy, Sociocracy, and governed AI workforce management.",
    },
    label: "About Corgtex",
    title: "The Story Behind Corgtex",
    intro: "We believe the next generation of great organizations will not be managed. They will be self-managing, AI-augmented, governed by their own rules, and designed for human autonomy.",
    missionTitle: "Our Mission",
    mission: "Traditional management can't keep up with how fast organizations move. Corgtex gives every person the information and governance tools they need - governed, visible, and always current.",
    leadershipLabel: "Leadership",
    founder: "Founder",
    role: "Founder and CEO",
    bio: [
      "Jan has spent over a decade at the intersection of organizational design, decentralized governance, and artificial intelligence. His work spans from designing governance frameworks for decentralized autonomous organizations to building enterprise-grade AI systems that understand and facilitate organizational decision-making.",
      "Before founding Corgtex, Jan led organizational transformation initiatives across multiple industries, observing firsthand how traditional management structures fail to scale with the complexity and speed of modern operations.",
      "His approach combines deep expertise in self-management methodologies - Holacracy, Sociocracy, Teal organizations - with a pragmatic engineering mindset, resulting in Corgtex: a platform that does not just theorize about organizational transformation but delivers it through production-grade AI infrastructure.",
    ],
    book: "Author of \"How to DAO\" (Penguin Random House) - a comprehensive guide to decentralized organizational governance that has become a foundational text for leaders navigating the transition from hierarchical to distributed models.",
    philosophyLabel: "Philosophy",
    philosophyTitle: "Why AI Plus Self-Management",
    principles: [
      { number: "I", title: "AI as Facilitator, Not Authority", body: "Corgtex does not make decisions for your team. It facilitates better decisions by routing proposals to domain experts, surfacing relevant knowledge, and ensuring governance processes are followed. The humans remain in charge." },
      { number: "II", title: "Autonomy Over Surveillance", body: "Corgtex replaces surveillance metrics with impact footprints - qualitative, multi-dimensional records of contribution that fuel autonomy and mastery rather than compliance and control." },
      { number: "III", title: "Continuous Evolution", body: "Organizations are living systems. Corgtex evolves with yours - continuously learning from decisions, adapting its understanding, and refining its organizational model as your team grows." },
    ],
    ctaTitle: "Build the Future of Work With Us",
    ctaBody: "See how a governed AI workforce runs in practice.",
    demo: "Access the Demo",
    briefing: "Schedule a Briefing",
  },
  es: {
    metadata: {
      title: "Acerca de",
      description: "Corgtex fue creado por Jan 'Puncar' Brezina, autor de Penguin Random House y practicante por más de una década de gobernanza descentralizada, Holacracy, Sociocracy y gestión de fuerzas laborales de IA gobernadas.",
    },
    label: "Acerca de Corgtex",
    title: "La historia detrás de Corgtex",
    intro: "Creemos que la próxima generación de grandes organizaciones no será administrada de forma tradicional. Será autogestionada, aumentada por IA, gobernada por sus propias reglas y diseñada para la autonomía humana.",
    missionTitle: "Nuestra misión",
    mission: "La gestión tradicional no puede seguir el ritmo al que se mueven las organizaciones. Corgtex da a cada persona la información y las herramientas de gobernanza que necesita: gobernadas, visibles y siempre actualizadas.",
    leadershipLabel: "Liderazgo",
    founder: "Fundador",
    role: "Fundador y CEO",
    bio: [
      "Jan lleva más de una década trabajando en la intersección entre diseño organizacional, gobernanza descentralizada e inteligencia artificial. Su trabajo va desde diseñar marcos de gobernanza para organizaciones autónomas descentralizadas hasta construir sistemas de IA enterprise que entienden y facilitan la toma de decisiones organizacional.",
      "Antes de fundar Corgtex, Jan lideró iniciativas de transformación organizacional en múltiples industrias y observó de primera mano cómo las estructuras de gestión tradicionales no escalan con la complejidad y velocidad de las operaciones modernas.",
      "Su enfoque combina experiencia profunda en metodologías de autogestión - Holacracy, Sociocracy y organizaciones Teal - con una mentalidad pragmática de ingeniería. El resultado es Corgtex: una plataforma que no solo teoriza sobre transformación organizacional, sino que la entrega mediante infraestructura de IA de producción.",
    ],
    book: "Autor de \"How to DAO\" (Penguin Random House), una guía integral de gobernanza organizacional descentralizada que se ha convertido en un texto base para líderes que transitan de modelos jerárquicos a modelos distribuidos.",
    philosophyLabel: "Filosofía",
    philosophyTitle: "Por qué IA más autogestión",
    principles: [
      { number: "I", title: "IA como facilitadora, no autoridad", body: "Corgtex no toma decisiones por tu equipo. Facilita mejores decisiones al enviar propuestas a expertos de dominio, mostrar conocimiento relevante y asegurar que se sigan los procesos de gobernanza. Las personas siguen a cargo." },
      { number: "II", title: "Autonomía sobre vigilancia", body: "Corgtex reemplaza métricas de vigilancia por huellas de impacto: registros cualitativos y multidimensionales de contribución que impulsan autonomía y maestría, no cumplimiento y control." },
      { number: "III", title: "Evolución continua", body: "Las organizaciones son sistemas vivos. Corgtex evoluciona con la tuya: aprende continuamente de las decisiones, adapta su comprensión y refina su modelo organizacional a medida que el equipo crece." },
    ],
    ctaTitle: "Construye con nosotros el futuro del trabajo",
    ctaBody: "Ve cómo funciona en la práctica una fuerza laboral de IA gobernada.",
    demo: "Acceder a la demo",
    briefing: "Agendar una sesión",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path: "/about" });
}

export default async function AboutPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];
  const { bookDemoUrl } = getSiteConfig();

  return (
    <>
      <section className="section" style={{ paddingBottom: "48px" }}>
        <div className="container" style={{ maxWidth: "800px", textAlign: "center" }}>
          <ScrollReveal><span className="section-label">{t.label}</span></ScrollReveal>
          <ScrollReveal delay={100}><h1 style={{ marginTop: "24px" }}>{t.title}</h1></ScrollReveal>
          <ScrollReveal delay={200}><p style={{ fontFamily: "var(--font-serif)", fontSize: "1.2rem", fontStyle: "italic", maxWidth: "620px", margin: "24px auto 0" }}>{t.intro}</p></ScrollReveal>
        </div>
      </section>

      <div className="rule-strong" style={{ maxWidth: "var(--max-width)", margin: "0 auto" }} />

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered" style={{ maxWidth: "800px" }}>
              <h2>{t.missionTitle}</h2>
              <p style={{ fontSize: "1.1rem", lineHeight: "1.8" }}>{t.mission}</p>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header">
              <span className="section-label">{t.leadershipLabel}</span>
              <h2>{t.founder}</h2>
            </div>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <div className="founder-section">
              <div className="founder-photo">
                <Image src="/images/puncar-pfp.jpg" alt="Jan Puncar Brezina" fill sizes="(max-width: 1024px) 280px, 280px" className="founder-img" />
              </div>
              <div className="founder-bio">
                <h3>Jan &ldquo;Puncar&rdquo; Brezina</h3>
                <p className="founder-role">{t.role}</p>
                {t.bio.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                <div className="book-callout">
                  <div className="book-cover-container">
                    <Image src="/images/how-to-dao-cover.png" alt="How to DAO Book Cover" width={858} height={1024} sizes="72px" className="book-cover-thumb" />
                  </div>
                  <div>
                    <p><strong>{t.book.split(" - ")[0]}</strong>{t.book.includes(" - ") ? ` - ${t.book.split(" - ").slice(1).join(" - ")}` : ""}</p>
                  </div>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">{t.philosophyLabel}</span>
              <h2>{t.philosophyTitle}</h2>
            </div>
          </ScrollReveal>
          <div className="cards-grid">
            {t.principles.map((principle, index) => (
              <ScrollReveal key={principle.title} delay={index * 100}>
                <div className="card">
                  <div className="card-number">{principle.number}</div>
                  <h3>{principle.title}</h3>
                  <p>{principle.body}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-dark cta-banner">
        <div className="container"><ScrollReveal>
          <h2>{t.ctaTitle}</h2>
          <p>{t.ctaBody}</p>
          <div className="btn-group">
            <a href={demoGatePathForLocale(locale)} className="btn btn-primary">{t.demo}</a>
            <a href={bookDemoUrl} className="btn btn-secondary" target="_blank" rel="noopener noreferrer">{t.briefing}</a>
          </div>
        </ScrollReveal></div>
      </section>
    </>
  );
}
