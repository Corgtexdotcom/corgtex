import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ScrollReveal } from "../../../../components/ScrollReveal";
import { StructuredData } from "../../../../components/StructuredData";
import { localeFromParams, hrefFor, type LocaleParams } from "../../../../lib/locale";
import { buildMetadata } from "../../../../lib/metadata";
import { demoUrlForLocale } from "../../../../lib/site";

const path = "/blog/corgtex-vs-glassfrog-vs-peerdom";

const rows = {
  en: [
    ["Primary Focus", "AI-powered organizational operating system", "Holacracy governance software", "Org chart visualization for self-management"],
    ["AI / LLM Integration", "Native - briefings, knowledge Q&A, automated routing", "None", "None"],
    ["Governance Models", "Holacracy, Sociocracy, O2, custom", "Holacracy only", "Visual role mapping"],
    ["Knowledge Base", "Full RAG pipeline with cited answers", "Policy and role documentation only", "None"],
    ["Personalized Briefings", "Daily AI-generated digest", "None", "None"],
    ["Deployment", "Cloud, on-premise, or hybrid", "Cloud SaaS only", "Cloud SaaS only"],
  ],
  es: [
    ["Foco principal", "Sistema operativo organizacional con IA", "Software de gobernanza Holacracy", "Visualización de organigrama para autogestión"],
    ["Integración IA / LLM", "Nativa: briefings, Q&A de conocimiento y ruteo automático", "Ninguna", "Ninguna"],
    ["Modelos de gobernanza", "Holacracy, Sociocracy, O2 y personalizado", "Solo Holacracy", "Mapeo visual de roles"],
    ["Base de conocimiento", "Pipeline RAG completo con respuestas citadas", "Solo documentación de políticas y roles", "Ninguna"],
    ["Briefings personalizados", "Digest diario generado por IA", "Ninguno", "Ninguno"],
    ["Despliegue", "Cloud, on-premise o híbrido", "Solo Cloud SaaS", "Solo Cloud SaaS"],
  ],
} as const;

const copy = {
  en: {
    metadata: {
      title: "Corgtex vs GlassFrog vs Peerdom: 2026 Comparison",
      description: "An objective comparison of software platforms for self-managing organizations in 2026: Corgtex, GlassFrog, and Peerdom.",
    },
    back: "Back to Resources",
    label: "Comparison",
    title: "Corgtex vs GlassFrog vs Peerdom: 2026 Comparison",
    answer: "Corgtex, GlassFrog, and Peerdom are prominent tools for self-managing organizations in 2026. GlassFrog digitizes Holacracy rules, Peerdom visualizes role structures, and Corgtex is a full AI-powered organizational operating system that adds intelligent briefings, a searchable knowledge base, and automated governance workflows on top of structural accountability.",
    authorLine: "Author of How to DAO - April 15, 2026",
    sections: [
      ["Why This Comparison Matters", ["If you're searching for software to support self-management, decentralized governance, or Holacracy, you have likely encountered GlassFrog, Peerdom, and Corgtex. Each takes a fundamentally different approach to running an organization without traditional command-and-control hierarchy."]],
      ["GlassFrog: The Holacracy Companion", ["GlassFrog is the official software companion for Holacracy. It is purpose-built to digitize the Holacracy constitution: roles, circles, accountabilities, policies, and tactical or governance meeting outputs.", "Its strength is faithful implementation of Holacracy. Its limitation is that it is passive, Holacracy-specific, and does not provide AI, broad organizational memory, or automated routing."]],
      ["Peerdom: The Visual Role Map", ["Peerdom focuses on making organizational structures visible. It excels at interactive visualizations of roles and circles, making it easy for people to see who does what.", "Its strength is clarity and onboarding. Its limitation is that visualization is not execution; teams still need separate tools for proposals, decisions, knowledge, and workflows."]],
      ["Corgtex: The AI-Powered Organizational OS", ["Corgtex is a different category. Rather than digitizing one governance rulebook or visualizing a structure, it acts as a unified intelligence layer that reads your organization and makes it actionable.", "It combines AI-native architecture, personalized daily briefings, searchable organizational memory, automated governance workflows, financial governance, and cloud, on-premise, or hybrid deployment."]],
      ["The AI Dividing Line", ["GlassFrog and Peerdom are governance documentation tools. They record what humans have already structured. Corgtex actively reads, classifies, routes, summarizes, and surfaces information. That is the dividing line in 2026."]],
    ],
    tableTitle: "Feature-by-Feature Comparison",
    headers: ["Feature", "Corgtex", "GlassFrog", "Peerdom"],
    ctaTitle: "See the difference for yourself",
    ctaBody: "The Corgtex demo runs on real governance data. Walk through circles, proposals, the knowledge base, and an intelligent briefing in 5 minutes.",
    demo: "Try the Live Demo",
    briefing: "Schedule a Briefing",
  },
  es: {
    metadata: {
      title: "Corgtex vs GlassFrog vs Peerdom: comparación 2026",
      description: "Comparación objetiva de plataformas para organizaciones autogestionadas en 2026: Corgtex, GlassFrog y Peerdom.",
    },
    back: "Volver a recursos",
    label: "Comparación",
    title: "Corgtex vs GlassFrog vs Peerdom: comparación 2026",
    answer: "Corgtex, GlassFrog y Peerdom son herramientas relevantes para organizaciones autogestionadas en 2026. GlassFrog digitaliza reglas de Holacracy, Peerdom visualiza estructuras de roles y Corgtex es un sistema operativo organizacional completo con IA que agrega briefings inteligentes, base de conocimiento consultable y workflows de gobernanza automatizados sobre la responsabilidad estructural.",
    authorLine: "Autor de How to DAO - 15 de abril de 2026",
    sections: [
      ["Por qué importa esta comparación", ["Si buscas software para autogestión, gobernanza descentralizada u Holacracy, probablemente encontraste GlassFrog, Peerdom y Corgtex. Cada uno aborda de forma distinta el reto de operar sin jerarquía tradicional de mando y control."]],
      ["GlassFrog: el compañero de Holacracy", ["GlassFrog es el software oficial para Holacracy. Está diseñado para digitalizar la constitución de Holacracy: roles, círculos, responsabilidades, políticas y resultados de reuniones tácticas o de gobernanza.", "Su fortaleza es la fidelidad al marco Holacracy. Su limitación es que es pasivo, específico de Holacracy y no ofrece IA, memoria organizacional amplia ni ruteo automatizado."]],
      ["Peerdom: el mapa visual de roles", ["Peerdom se enfoca en hacer visible la estructura organizacional. Destaca con visualizaciones interactivas de roles y círculos, ayudando a que todos vean quién hace qué.", "Su fortaleza es claridad y onboarding. Su limitación es que visualizar no es ejecutar; los equipos aún necesitan herramientas separadas para propuestas, decisiones, conocimiento y workflows."]],
      ["Corgtex: el OS organizacional con IA", ["Corgtex pertenece a otra categoría. En lugar de digitalizar un solo reglamento o visualizar una estructura, actúa como una capa de inteligencia unificada que lee tu organización y la vuelve accionable.", "Combina arquitectura nativa de IA, briefings diarios personalizados, memoria organizacional consultable, workflows de gobernanza automatizados, gobernanza financiera y despliegue cloud, on-premise o híbrido."]],
      ["La línea divisoria de la IA", ["GlassFrog y Peerdom son herramientas de documentación de gobernanza. Registran lo que las personas ya estructuraron. Corgtex lee, clasifica, enruta, resume y muestra información activamente. Esa es la línea divisoria en 2026."]],
    ],
    tableTitle: "Comparación función por función",
    headers: ["Función", "Corgtex", "GlassFrog", "Peerdom"],
    ctaTitle: "Ve la diferencia por ti mismo",
    ctaBody: "La demo de Corgtex usa datos reales de gobernanza. Explora círculos, propuestas, la base de conocimiento y un briefing inteligente en 5 minutos.",
    demo: "Probar la demo en vivo",
    briefing: "Agendar una sesión",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path });
}

export default async function ComparisonPage({ params }: LocaleParams) {
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
          <div className="container" style={{ maxWidth: "800px" }}>
            <ScrollReveal>
              <Link href={hrefFor(locale, "/blog")} style={{ color: "var(--text-secondary)", textDecoration: "none", fontSize: "0.9rem", display: "inline-flex", alignItems: "center", marginBottom: "24px" }}>
                <span style={{ marginRight: "8px" }}>←</span> {t.back}
              </Link>
            </ScrollReveal>
            <ScrollReveal delay={100}><span className="section-label">{t.label}</span></ScrollReveal>
            <ScrollReveal delay={200}><h1 style={{ marginTop: "24px", fontSize: "3rem", lineHeight: "1.2" }}>{t.title}</h1></ScrollReveal>
            <ScrollReveal delay={300}>
              <p style={{ fontSize: "1.3rem", lineHeight: "1.6", marginTop: "32px", fontWeight: 500, padding: "24px", background: "var(--gray-50)", borderLeft: "4px solid var(--text)", borderRadius: "0 8px 8px 0" }}>{t.answer}</p>
            </ScrollReveal>
            <div style={{ display: "flex", alignItems: "center", marginTop: "32px", gap: "16px" }}>
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
          <div className="container" style={{ maxWidth: "800px", fontSize: "1.15rem", lineHeight: "1.8" }}>
            {t.sections.map(([title, paragraphs]) => (
              <ScrollReveal key={title}>
                <h2 style={{ fontSize: "2rem", marginTop: "48px", marginBottom: "24px", fontFamily: "var(--font-serif)" }}>{title}</h2>
                {paragraphs.map((paragraph) => <p key={paragraph} style={{ marginBottom: "24px", color: "var(--text-secondary)" }}>{paragraph}</p>)}
              </ScrollReveal>
            ))}
            <ScrollReveal>
              <h2 style={{ fontSize: "2rem", marginTop: "48px", marginBottom: "24px", fontFamily: "var(--font-serif)" }}>{t.tableTitle}</h2>
              <div style={{ overflowX: "auto", marginBottom: "48px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "1rem" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--text)" }}>
                      {t.headers.map((header) => <th key={header} style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>{header}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows[locale].map((row, index) => (
                      <tr key={row[0]} style={{ borderBottom: "1px solid var(--border)", background: index % 2 === 0 ? "transparent" : "var(--gray-50)" }}>
                        {row.map((cell, cellIndex) => <td key={cell} style={{ padding: "12px 16px", fontWeight: cellIndex === 0 ? 600 : 400, color: cellIndex === 0 ? "var(--text)" : "var(--text-secondary)" }}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ScrollReveal>
            <ScrollReveal>
              <div style={{ marginTop: "64px", padding: "32px", background: "var(--gray-50)", border: "1px solid var(--border)", borderRadius: "8px" }}>
                <h3 style={{ fontSize: "1.4rem", marginBottom: "16px" }}>{t.ctaTitle}</h3>
                <p style={{ marginBottom: "24px", color: "var(--text-secondary)", fontSize: "1rem" }}>{t.ctaBody}</p>
                <div style={{ display: "flex", gap: "16px" }}>
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
