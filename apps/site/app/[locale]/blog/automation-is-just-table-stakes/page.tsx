import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ScrollReveal } from "../../../../components/ScrollReveal";
import { StructuredData } from "../../../../components/StructuredData";
import { localeFromParams, hrefFor, type LocaleParams } from "../../../../lib/locale";
import { buildMetadata } from "../../../../lib/metadata";
import { demoUrlForLocale } from "../../../../lib/site";

const path = "/blog/automation-is-just-table-stakes";

const copy = {
  en: {
    metadata: {
      title: "Automation Is Just Table Stakes - Decision-Making Is Where AI Will Excel",
      description: "Workflow automation is a solved problem. The real frontier for enterprise AI is facilitating complex, multi-stakeholder decisions under distributed authority.",
    },
    back: "Back to Resources",
    label: "Thought Leadership",
    title: "Automation Is Just Table Stakes - Decision-Making Is Where AI Will Excel",
    answer: "If you are using AI purely to automate repetitive tasks, you are playing the game from a decade ago. Data entry and workflow automation are solved problems. The actual frontier of enterprise value is using AI to facilitate complex, multi-stakeholder decision-making in decentralized environments, turning static governance rules into active, intelligent workflows.",
    authorLine: "Author of How to DAO - May 2026",
    sections: [
      ["The Automation Trap", ["Walk the floor of any enterprise tech conference today, and the pitch is the same: we use AI to automate your workflows.", "This is a trap. Moving data from an invoice PDF into a CRM is important, but robotic process automation and tools like Zapier largely solved that years ago. Appending an LLM to extract text slightly better is incremental, not transformational.", "The hard problem in growing companies is not that data entry takes too long. The hard problem is that decision-making stalls."]],
      ["The Three Levels of Enterprise AI", ["Level 1: Automation replaces deterministic human actions with software. Valuable, but it does not change how the organization breathes.", "Level 2: Analysis synthesizes information, such as board decks or churn signals. Humans still figure out who needs to see it and what to do.", "Level 3: Facilitation uses AI to run organizational operations. It understands roles, domains of authority, and current tensions, then routes proposals, tracks objections, and provides context without a manager calling a meeting."]],
      ["Why Facilitation is the Holy Grail", ["Distributed authority works better than rigid hierarchy when the rules are explicit and maintained. It fails in practice when humans lack the bandwidth to maintain the rulebook and track shifting domains of authority.", "This is where AI excels. A secure enterprise LLM acting as an organizational operating system never forgets who holds a domain. It parses proposals, identifies edge cases, and routes review to the right circle.", "It does not make the decision. It ensures the decision can be made swiftly, by the right people, with total transparency."]],
    ],
    ctaTitle: "Move beyond automation",
    ctaBody: "Corgtex is the AI-powered centralized intelligence platform that drives decentralized decision-making. Book a scoping session to see how it works.",
    demo: "Try the Live Demo",
    briefing: "Schedule a Briefing",
  },
  es: {
    metadata: {
      title: "La automatización ya es básica: la toma de decisiones es donde la IA destacará",
      description: "La automatización de workflows ya está resuelta. La frontera real para IA enterprise es facilitar decisiones complejas con múltiples partes bajo autoridad distribuida.",
    },
    back: "Volver a recursos",
    label: "Pensamiento estratégico",
    title: "La automatización ya es básica: la toma de decisiones es donde la IA destacará",
    answer: "Si usas IA solo para automatizar tareas repetitivas, estás jugando el juego de hace una década. La entrada de datos y la automatización de workflows ya están resueltas. La frontera real del valor enterprise es usar IA para facilitar decisiones complejas con múltiples stakeholders en entornos descentralizados, convirtiendo reglas de gobernanza estáticas en workflows activos e inteligentes.",
    authorLine: "Autor de How to DAO - mayo de 2026",
    sections: [
      ["La trampa de la automatización", ["Camina por cualquier conferencia de tecnología enterprise y el discurso será el mismo: usamos IA para automatizar tus workflows.", "Es una trampa. Pasar datos de una factura PDF a un CRM es importante, pero RPA y herramientas como Zapier resolvieron gran parte de eso hace años. Agregar un LLM para extraer texto un poco mejor es incremental, no transformacional.", "El problema difícil en compañías en crecimiento no es que ingresar datos tarde demasiado. El problema difícil es que las decisiones se estancan."]],
      ["Los tres niveles de IA enterprise", ["Nivel 1: Automatización reemplaza acciones humanas deterministas con software. Es valioso, pero no cambia cómo respira la organización.", "Nivel 2: Análisis sintetiza información, como decks de consejo o señales de churn. Las personas aún deben decidir quién necesita verlo y qué hacer.", "Nivel 3: Facilitación usa IA para operar la organización. Entiende roles, dominios de autoridad y tensiones actuales; luego enruta propuestas, rastrea objeciones y entrega contexto sin que un manager convoque una reunión."]],
      ["Por qué la facilitación es el santo grial", ["La autoridad distribuida funciona mejor que la jerarquía rígida cuando las reglas son explícitas y se mantienen. Falla en la práctica cuando las personas no tienen capacidad para mantener el reglamento y seguir dominios cambiantes.", "Aquí es donde la IA sobresale. Un LLM enterprise seguro actuando como sistema operativo organizacional nunca olvida quién tiene un dominio. Lee propuestas, identifica casos límite y dirige la revisión al círculo correcto.", "No toma la decisión. Asegura que la decisión pueda tomarse rápido, por las personas correctas y con transparencia total."]],
    ],
    ctaTitle: "Ve más allá de la automatización",
    ctaBody: "Corgtex es la plataforma centralizada de inteligencia con IA que impulsa la toma de decisiones descentralizada. Agenda una sesión de alcance para ver cómo funciona.",
    demo: "Probar la demo en vivo",
    briefing: "Agendar una sesión",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path });
}

export default async function AutomationTableStakesPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: t.title,
    description: t.metadata.description,
    author: { "@type": "Person", "@id": "https://corgtex.com/#founder" },
    publisher: { "@id": "https://corgtex.com/#organization" },
    datePublished: "2026-05-15",
    dateModified: "2026-05-15",
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
                </div>
              </div>
            </ScrollReveal>
          </div>
        </section>
      </article>
    </>
  );
}
