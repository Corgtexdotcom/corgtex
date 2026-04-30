import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ScrollReveal } from "../../../../components/ScrollReveal";
import { StructuredData } from "../../../../components/StructuredData";
import { localeFromParams, hrefFor, type LocaleParams } from "../../../../lib/locale";
import { buildMetadata } from "../../../../lib/metadata";
import { demoUrlForLocale } from "../../../../lib/site";

const path = "/blog/self-management-with-ai";

const copy = {
  en: {
    metadata: {
      title: "Self-Management with AI: From Hierarchy to Intelligence",
      description: "How autonomous AI agents and structural accountability enable organizations to replace hierarchy with intelligence.",
    },
    back: "Back to Resources",
    label: "Thought Leadership",
    title: "Self-Management with AI: From Hierarchy to Intelligence",
    answer: "Self-management with AI means using autonomous agents and large language models to replace the coordination functions traditionally performed by middle management: routing decisions to domain experts, surfacing relevant context, generating personalized briefings, and maintaining organizational memory while preserving human authority over substantive decisions.",
    authorLine: "Author of How to DAO - May 2026",
    sections: [
      ["The Hierarchy Was an Information Solution", ["Hierarchies exist because of an information problem, not a talent problem. When organizations grew beyond a few dozen people, no single person could hold the full picture. The solution was management layers whose primary job was to aggregate information upward and distribute decisions downward.", "This worked for a century, but every layer adds latency, filters nuance, and creates political dynamics unrelated to the work. Self-management frameworks distributed authority through explicit roles and consent-based governance, but the coordination overhead often shifted from managers to everyone."]],
      ["Why Previous Self-Management Tools Fell Short", ["The first generation of self-management software, including tools like GlassFrog and Peerdom, were digital filing cabinets. They documented roles, policies, and meeting outcomes, but they were passive.", "This created a paradox: tools designed to reduce bureaucracy created governance administration. The frameworks were directionally right; they lacked technology that could execute the vision without overwhelming humans."]],
      ["AI as the Missing Infrastructure", ["Large language models changed the equation. Software can now read and classify unstructured information, route decisions to the right people, generate personalized context, maintain institutional memory, and track governance health.", "Crucially, AI does not make decisions. It facilitates them. It ensures the right people have the right context at the right time, while authority remains distributed among humans."]],
      ["What It Looks Like in Practice", ["Morning briefings replace status meetings. Each person receives a daily newspaper synthesized from activity across the organization and tailored to their roles.", "Consent decisions close in days, not weeks. A proposal is routed to domain experts, objections are tracked, integrations are documented, and the audit trail is automatic.", "Cross-organization visibility improves without surveillance. The system surfaces patterns, such as duplicated vendor evaluations, to domain leads rather than monitoring individuals."]],
      ["The Next Decade", ["Organizations are moving from hierarchy through self-management to intelligent self-management: AI handles coordination, humans handle judgment.", "This is not about replacing humans. It is about replacing the coordination overhead that has always taxed organizational performance. Every day the system runs, it learns more; every decision strengthens the knowledge base."]],
    ],
    ctaTitle: "Ready to move from hierarchy to intelligence?",
    ctaBody: "Corgtex is the AI-powered organizational operating system designed by the team behind How to DAO. See what a personalized organizational briefing looks like with real governance data.",
    demo: "Try the Live Demo",
    briefing: "Schedule a Briefing",
    book: "Read \"How to DAO\"",
  },
  es: {
    metadata: {
      title: "Autogestión con IA: de jerarquía a inteligencia",
      description: "Cómo agentes autónomos de IA y responsabilidad estructural permiten reemplazar jerarquía por inteligencia.",
    },
    back: "Volver a recursos",
    label: "Pensamiento estratégico",
    title: "Autogestión con IA: de jerarquía a inteligencia",
    answer: "Autogestión con IA significa usar agentes autónomos y grandes modelos de lenguaje para reemplazar funciones de coordinación que antes realizaban mandos medios: enrutar decisiones a expertos de dominio, mostrar contexto relevante, generar briefings personalizados y mantener memoria organizacional, mientras la autoridad sobre decisiones sustantivas permanece en personas.",
    authorLine: "Autor de How to DAO - mayo de 2026",
    sections: [
      ["La jerarquía fue una solución de información", ["Las jerarquías existen por un problema de información, no de talento. Cuando una organización supera unas pocas docenas de personas, nadie puede sostener todo el contexto. La solución fue crear capas de management cuyo trabajo era agregar información hacia arriba y distribuir decisiones hacia abajo.", "Funcionó durante un siglo, pero cada capa agrega latencia, filtra matices y crea dinámicas políticas ajenas al trabajo. Los marcos de autogestión distribuyeron autoridad mediante roles explícitos y gobernanza por consentimiento, pero el costo de coordinación muchas veces pasó de managers a todos."]],
      ["Por qué las herramientas anteriores se quedaron cortas", ["La primera generación de software de autogestión, incluyendo GlassFrog y Peerdom, fueron archivadores digitales. Documentaban roles, políticas y resultados de reuniones, pero eran pasivos.", "Esto creó una paradoja: herramientas diseñadas para reducir burocracia generaron administración de gobernanza. Los marcos tenían buen diagnóstico; faltaba tecnología capaz de ejecutar la visión sin sobrecargar a las personas."]],
      ["La IA como infraestructura faltante", ["Los grandes modelos de lenguaje cambiaron la ecuación. El software ahora puede leer y clasificar información no estructurada, enrutar decisiones a las personas correctas, generar contexto personalizado, mantener memoria institucional y monitorear la salud de la gobernanza.", "La IA no toma decisiones. Las facilita. Asegura que las personas correctas tengan el contexto correcto en el momento correcto, mientras la autoridad permanece distribuida entre humanos."]],
      ["Cómo se ve en la práctica", ["Los briefings matutinos reemplazan reuniones de estado. Cada persona recibe un periódico diario sintetizado desde la actividad de la organización y adaptado a sus roles.", "Las decisiones por consentimiento se cierran en días, no semanas. Una propuesta se dirige a expertos de dominio, se rastrean objeciones, se documentan integraciones y la auditoría queda automática.", "La visibilidad transversal mejora sin vigilancia. El sistema muestra patrones, como evaluaciones duplicadas de proveedores, a líderes de dominio en vez de monitorear individuos."]],
      ["La próxima década", ["Las organizaciones se mueven de jerarquía a autogestión y luego a autogestión inteligente: la IA coordina, las personas juzgan.", "No se trata de reemplazar humanos. Se trata de reemplazar el costo de coordinación que siempre ha gravado el rendimiento organizacional. Cada día que el sistema corre, aprende más; cada decisión fortalece la base de conocimiento."]],
    ],
    ctaTitle: "¿Listo para pasar de jerarquía a inteligencia?",
    ctaBody: "Corgtex es el sistema operativo organizacional con IA diseñado por el equipo detrás de How to DAO. Ve cómo luce un briefing organizacional personalizado con datos reales de gobernanza.",
    demo: "Probar la demo en vivo",
    briefing: "Agendar una sesión",
    book: "Leer \"How to DAO\"",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path });
}

export default async function SelfManagementWithAIPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: t.title,
    description: t.metadata.description,
    author: { "@type": "Person", "@id": "https://corgtex.com/#founder" },
    publisher: { "@id": "https://corgtex.com/#organization" },
    datePublished: "2026-05-01",
    dateModified: "2026-05-01",
  };

  return (
    <>
      <StructuredData data={structuredData} />
      <article>
        <section className="section" style={{ paddingBottom: "48px" }}>
          <div className="container article-shell">
            <ScrollReveal>
              <Link href={hrefFor(locale, "/blog")} style={{ color: "var(--text-secondary)", textDecoration: "none", fontSize: "0.9rem", display: "inline-flex", alignItems: "center", marginBottom: "24px" }}>
                <span style={{ marginRight: "8px" }}>←</span> {t.back}
              </Link>
            </ScrollReveal>
            <ScrollReveal delay={100}><span className="section-label">{t.label}</span></ScrollReveal>
            <ScrollReveal delay={200}><h1 className="article-title">{t.title}</h1></ScrollReveal>
            <ScrollReveal delay={300}>
              <p className="article-answer">{t.answer}</p>
            </ScrollReveal>
            <div className="article-meta">
              <Image src="/images/puncar-pfp.jpg" alt="Jan Brezina" width={48} height={48} style={{ borderRadius: "50%" }} />
              <div>
                <div style={{ fontWeight: 600 }}>Jan &ldquo;Puncar&rdquo; Brezina</div>
                <div style={{ fontSize: "0.9rem", color: "var(--text-secondary)" }}>{t.authorLine}</div>
              </div>
            </div>
          </div>
        </section>
        <div className="rule-strong" style={{ maxWidth: "800px", margin: "0 auto" }} />
        <section className="section article-content">
          <div className="container article-content-inner">
            {t.sections.map(([title, paragraphs]) => (
              <ScrollReveal key={title}>
                <h2 className="article-section-title">{title}</h2>
                {paragraphs.map((paragraph) => <p key={paragraph} style={{ marginBottom: "24px", color: "var(--text-secondary)" }}>{paragraph}</p>)}
              </ScrollReveal>
            ))}
            <ScrollReveal>
              <div className="article-cta">
                <h3>{t.ctaTitle}</h3>
                <p>{t.ctaBody}</p>
                <div className="action-row">
                  <a href={demoUrlForLocale(locale)} className="btn btn-primary" target="_blank" rel="noopener noreferrer">{t.demo}</a>
                  <a href="https://calendar.app.google/jJd5yeSuDStVZm896" className="btn btn-secondary" target="_blank" rel="noopener noreferrer">{t.briefing}</a>
                  <a href="https://www.amazon.com/dp/059371377X" className="btn btn-secondary" target="_blank" rel="noopener noreferrer">{t.book}</a>
                </div>
              </div>
            </ScrollReveal>
          </div>
        </section>
      </article>
    </>
  );
}
