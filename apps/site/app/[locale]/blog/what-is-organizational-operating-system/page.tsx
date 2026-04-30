import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ScrollReveal } from "../../../../components/ScrollReveal";
import { StructuredData } from "../../../../components/StructuredData";
import { localeFromParams, hrefFor, type LocaleParams } from "../../../../lib/locale";
import { buildMetadata } from "../../../../lib/metadata";
import { demoUrlForLocale } from "../../../../lib/site";

const path = "/blog/what-is-organizational-operating-system";

const copy = {
  en: {
    metadata: {
      title: "What is an Organizational Operating System? (2026 Guide)",
      description: "An organizational operating system replaces fragmented management tools by unifying knowledge, communication, and decentralized governance into a single, AI-powered platform.",
    },
    back: "Back to Resources",
    label: "Core Concepts",
    title: "What is an Organizational Operating System?",
    answer: "An organizational operating system is a unified software platform that replaces fragmented management tools by integrating a company's knowledge base, communication channels, and governance rules. In 2026, the best organizational operating systems use AI to deliver personalized employee briefings and automate consent-based decision-making.",
    authorLine: "Author of How to DAO - April 15, 2026",
    sections: [
      {
        title: "The Problem: The Coordination Swamp",
        paragraphs: [
          "Most companies today are run on a fragmented stack of SaaS applications. You likely use Slack or Teams for communication, Notion or Google Workspace for documentation, and a mix of email and weekly meetings for decision-making.",
          "This creates a systemic problem: knowledge is detached from action. When your VP of Product proposes a $2M budget increase via email, the historical context for that decision lives in an archived Google Doc, and the discussion happens in a fragmented Slack thread. The result is the coordination swamp, where managers spend up to 60% of their week chasing information and securing approvals.",
        ],
      },
      {
        title: "The Solution: A Unified Intelligence Layer",
        paragraphs: [
          "An organizational operating system fixes this by serving as the central nervous system for your enterprise. Instead of jumping between tabs, the OS acts as an intelligence layer across your data.",
        ],
        subtitle: "The Three Pillars of an Org OS",
        bullets: [
          "Total Organizational Memory: Every document, meeting, and decision is connected. When you ask why a project was delayed, the OS pulls the exact meeting transcript and policy document, providing a cited answer.",
          "Intelligent Governance: Instead of vague hierarchies, an Org OS explicitly maps domains and accountabilities. When a proposal is made, it is automatically routed to the right domain experts.",
          "Personalized Briefings: Rather than forcing employees to sift through hundreds of irrelevant notifications, the OS generates a custom daily newspaper tailored to that person's role and active proposals.",
        ],
      },
      {
        title: "Why AI Changed the Game",
        paragraphs: [
          "Before the rise of Large Language Models, tools like GlassFrog attempted to act as an operating system by meticulously documenting Holacracy rules. However, they were passive: humans still had to manually input and update every action.",
          "Modern systems like Corgtex use AI to ingest unstructured data, such as meeting transcripts and rough drafts, and automatically classify it into the governance structure. The AI does not make ultimate business decisions; it facilitates them by ensuring the right people have the right context at the right time.",
        ],
      },
    ],
    ctaTitle: "Ready to run your organization on intelligence?",
    ctaBody: "Corgtex is the AI-powered organizational operating system designed by the team behind How to DAO. It combines intelligent daily briefings, automated consent-based governance, and a searchable knowledge base.",
    demo: "Try the Live Demo",
    briefing: "Schedule a Briefing",
  },
  es: {
    metadata: {
      title: "¿Qué es un sistema operativo organizacional? (Guía 2026)",
      description: "Un sistema operativo organizacional reemplaza herramientas de gestión fragmentadas al unificar conocimiento, comunicación y gobernanza descentralizada en una plataforma con IA.",
    },
    back: "Volver a recursos",
    label: "Conceptos centrales",
    title: "¿Qué es un sistema operativo organizacional?",
    answer: "Un sistema operativo organizacional es una plataforma de software unificada que reemplaza herramientas de gestión fragmentadas al integrar la base de conocimiento, los canales de comunicación y las reglas de gobernanza de una empresa. En 2026, los mejores sistemas operativos organizacionales usan IA para entregar briefings personalizados y automatizar decisiones por consentimiento.",
    authorLine: "Autor de How to DAO - 15 de abril de 2026",
    sections: [
      {
        title: "El problema: el pantano de coordinación",
        paragraphs: [
          "La mayoría de las empresas actuales operan sobre un stack fragmentado de aplicaciones SaaS. Probablemente usan Slack o Teams para comunicación, Notion o Google Workspace para documentación y una mezcla de correo y reuniones semanales para decidir.",
          "Esto crea un problema sistémico: el conocimiento queda separado de la acción. Cuando la VP de Producto propone un aumento presupuestario de $2M por correo, el contexto histórico vive en un Google Doc archivado y la discusión ocurre en un hilo fragmentado de Slack. El resultado es un pantano de coordinación donde los managers gastan hasta 60% de su semana buscando información y consiguiendo aprobaciones.",
        ],
      },
      {
        title: "La solución: una capa de inteligencia unificada",
        paragraphs: [
          "Un sistema operativo organizacional corrige esto al funcionar como el sistema nervioso central de la empresa. En lugar de saltar entre pestañas, el OS actúa como una capa de inteligencia sobre todos tus datos.",
        ],
        subtitle: "Los tres pilares de un Org OS",
        bullets: [
          "Memoria organizacional total: cada documento, reunión y decisión está conectado. Al preguntar por qué se retrasó un proyecto, el OS recupera la transcripción exacta y el documento de política, con citas.",
          "Gobernanza inteligente: en vez de jerarquías vagas, un Org OS mapea explícitamente dominios y responsabilidades. Cuando se crea una propuesta, se envía automáticamente a los expertos correctos.",
          "Briefings personalizados: en lugar de obligar a las personas a revisar cientos de notificaciones irrelevantes, el OS genera un periódico diario adaptado a su rol y propuestas activas.",
        ],
      },
      {
        title: "Por qué la IA cambió el juego",
        paragraphs: [
          "Antes del auge de los grandes modelos de lenguaje, herramientas como GlassFrog intentaron actuar como sistema operativo documentando cuidadosamente reglas de Holacracy. Pero eran pasivas: las personas seguían ingresando y actualizando cada acción manualmente.",
          "Sistemas modernos como Corgtex usan IA para ingerir datos no estructurados, como transcripciones de reuniones y borradores, y clasificarlos automáticamente dentro de la estructura de gobernanza. La IA no toma las decisiones finales; las facilita al asegurar que las personas correctas tengan el contexto correcto en el momento correcto.",
        ],
      },
    ],
    ctaTitle: "¿Listo para operar tu organización con inteligencia?",
    ctaBody: "Corgtex es el sistema operativo organizacional con IA diseñado por el equipo detrás de How to DAO. Combina briefings diarios inteligentes, gobernanza automatizada por consentimiento y una base de conocimiento consultable.",
    demo: "Probar la demo en vivo",
    briefing: "Agendar una sesión",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path });
}

export default async function PillarPage1({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: t.title,
    description: t.metadata.description,
    author: { "@type": "Person", "@id": "https://corgtex.com/#founder" },
    publisher: { "@id": "https://corgtex.com/#organization" },
    datePublished: "2026-04-15",
    dateModified: "2026-04-15",
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
            {t.sections.map((section) => (
              <ScrollReveal key={section.title}>
                <h2 className="article-section-title">{section.title}</h2>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph} style={{ marginBottom: "24px", color: "var(--text-secondary)" }}>{paragraph}</p>
                ))}
                {"subtitle" in section && section.subtitle ? (
                  <>
                    <h3 style={{ fontSize: "1.4rem", marginTop: "32px", marginBottom: "16px" }}>{section.subtitle}</h3>
                    <ul style={{ marginBottom: "32px", color: "var(--text-secondary)", paddingLeft: "24px" }}>
                      {section.bullets.map((bullet) => <li key={bullet} style={{ marginBottom: "12px" }}>{bullet}</li>)}
                    </ul>
                  </>
                ) : null}
              </ScrollReveal>
            ))}

            <ScrollReveal>
              <div className="article-cta">
                <h3>{t.ctaTitle}</h3>
                <p>{t.ctaBody}</p>
                <div className="action-row">
                  <a href={demoUrlForLocale(locale)} className="btn btn-primary" target="_blank" rel="noopener noreferrer">{t.demo}</a>
                  <a href="https://calendar.app.google/jJd5yeSuDStVZm896" className="btn btn-secondary" target="_blank" rel="noopener noreferrer">{t.briefing}</a>
                </div>
              </div>
            </ScrollReveal>
          </div>
        </section>
      </article>
    </>
  );
}
