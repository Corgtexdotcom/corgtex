import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ScrollReveal } from "../../../../components/ScrollReveal";
import { StructuredData } from "../../../../components/StructuredData";
import { localeFromParams, hrefFor, type LocaleParams } from "../../../../lib/locale";
import { buildMetadata } from "../../../../lib/metadata";
import { demoUrlForLocale } from "../../../../lib/site";

const path = "/blog/ai-used-to-be-your-intern";

const copy = {
  en: {
    metadata: {
      title: "AI Used to Be Your Intern. Now It's Becoming Your CEO.",
      description: "The era of AI as a smart intern is over. The true value of large language models lies in replacing the coordination functions of middle management.",
    },
    back: "Back to Resources",
    label: "Thought Leadership",
    title: "AI Used to Be Your Intern. Now It's Becoming Your CEO.",
    answer: "For the last few years, AI has been treated as a highly capable intern: drafting emails, summarizing meetings, and writing code snippets. But the next frontier of organizational AI is not about doing individual tasks faster. It is about organizational coordination: replacing the connective tissue of middle management by routing decisions to domain experts, surfacing historical context instantly, and creating self-managing entities.",
    authorLine: "Author of How to DAO - May 2026",
    sections: [
      ["The Intern Phase", ["When ChatGPT first went mainstream, the corporate world collectively realized it had access to an infinitely patient, highly educated intern. The use cases immediately gravitated toward task acceleration: write a polite email, summarize a PDF, draft a script.", "This generated massive productivity gains for individuals. But it did not change the shape of organizations. A company of 5,000 people using AI to draft emails faster is still a company operating at the speed of human committee meetings."]],
      ["The Management Problem", ["The real bottleneck in modern enterprises is not that creating documents takes too long. It is that coordinating decisions takes too long.", "In a traditional hierarchy, middle management exists primarily to solve an information routing problem. Information flows up, across, and down. This coordination overhead consumes massive time and capital.", "Self-management frameworks like Holacracy tried to solve this by making rules explicit, but they lacked the computational layer to enforce them without overwhelming humans."]],
      ["The Shift to Organizational Intelligence", ["We are now entering the phase where AI moves from individual contributor to organizational orchestrator.", "When large language models are securely connected to every document, Slack message, and governance rule in your company, they stop acting like interns and start acting like the ultimate Chief of Staff.", "Instead of relying on a human manager to route a budget proposal, an AI orchestrator reads it, checks domains of authority, and surfaces it to the people who can decide."]],
      ["The Humans Keep the Authority", ["The title is intentionally provocative. AI is not becoming the CEO in the sense of making final strategic calls. But it is taking over the coordination layer that previously defined much of the executive suite.", "In this model, AI facilitates, routes, summarizes, and audits. Humans exercise judgment. The organization becomes flatter, faster, and more scalable."]],
    ],
    ctaTitle: "Run your organization on intelligence",
    ctaBody: "Corgtex is the AI-powered organizational operating system designed to replace the coordination overhead of traditional management.",
    demo: "Try the Live Demo",
    briefing: "Schedule a Briefing",
  },
  es: {
    metadata: {
      title: "La IA era tu pasante. Ahora se acerca a tu CEO.",
      description: "La era de la IA como pasante inteligente terminó. El valor real de los grandes modelos de lenguaje está en reemplazar funciones de coordinación de mandos medios.",
    },
    back: "Volver a recursos",
    label: "Pensamiento estratégico",
    title: "La IA era tu pasante. Ahora se acerca a tu CEO.",
    answer: "Durante los últimos años, la IA se trató como una pasante altamente capaz: redactaba correos, resumía reuniones y escribía fragmentos de código. Pero la próxima frontera de la IA organizacional no consiste en hacer tareas individuales más rápido. Consiste en coordinación organizacional: reemplazar el tejido conectivo de los mandos medios al enrutar decisiones a expertos de dominio, mostrar contexto histórico al instante y crear entidades autogestionadas.",
    authorLine: "Autor de How to DAO - mayo de 2026",
    sections: [
      ["La fase de pasante", ["Cuando ChatGPT se volvió masivo, el mundo corporativo entendió que tenía acceso a una pasante infinitamente paciente y muy educada. Los casos de uso se concentraron en acelerar tareas: escribir un correo amable, resumir un PDF, redactar un script.", "Esto generó enormes ganancias de productividad individual. Pero no cambió la forma de las organizaciones. Una empresa de 5,000 personas usando IA para redactar correos más rápido sigue operando a la velocidad de reuniones de comité humanas."]],
      ["El problema de gestión", ["El cuello de botella real en empresas modernas no es que crear documentos tarde demasiado. Es que coordinar decisiones tarda demasiado.", "En una jerarquía tradicional, los mandos medios existen principalmente para resolver un problema de ruteo de información. La información sube, cruza y baja. Ese costo de coordinación consume enormes cantidades de tiempo y capital.", "Marcos de autogestión como Holacracy intentaron resolverlo haciendo explícitas las reglas, pero no tenían la capa computacional para aplicarlas sin sobrecargar a las personas."]],
      ["El cambio hacia inteligencia organizacional", ["Estamos entrando en la fase donde la IA pasa de contribuidora individual a orquestadora organizacional.", "Cuando los grandes modelos de lenguaje se conectan de forma segura a cada documento, mensaje de Slack y regla de gobernanza de la empresa, dejan de actuar como pasantes y empiezan a funcionar como el Chief of Staff definitivo.", "En vez de depender de un manager humano para enrutar una propuesta presupuestaria, un orquestador de IA la lee, verifica dominios de autoridad y la muestra a las personas que pueden decidir."]],
      ["Las personas conservan la autoridad", ["El título es intencionalmente provocador. La IA no se convierte en CEO en el sentido de tomar decisiones estratégicas finales. Pero sí asume la capa de coordinación que antes definía gran parte de la dirección ejecutiva.", "En este modelo, la IA facilita, enruta, resume y audita. Las personas ejercen juicio. La organización se vuelve más plana, rápida y escalable."]],
    ],
    ctaTitle: "Opera tu organización con inteligencia",
    ctaBody: "Corgtex es el sistema operativo organizacional con IA diseñado para reemplazar el costo de coordinación de la gestión tradicional.",
    demo: "Probar la demo en vivo",
    briefing: "Agendar una sesión",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path });
}

export default async function AIInternPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: t.title,
    description: t.metadata.description,
    author: { "@type": "Person", "@id": "https://corgtex.com/#founder" },
    publisher: { "@id": "https://corgtex.com/#organization" },
    datePublished: "2026-05-10",
    dateModified: "2026-05-10",
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
