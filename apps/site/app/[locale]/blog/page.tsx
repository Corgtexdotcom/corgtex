import type { Metadata } from "next";
import Link from "next/link";
import { ScrollReveal } from "../../../components/ScrollReveal";
import { localeFromParams, hrefFor, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";

const posts = {
  en: [
    { title: "What is an Organizational Operating System?", description: "Discover why fragmented knowledge, communication, and governance tools are slowing you down, and how a unified OS fixes it.", href: "/blog/what-is-organizational-operating-system", date: "April 2026" },
    { title: "Corgtex vs GlassFrog vs Peerdom: 2026 Comparison", description: "An objective look at the top software for self-managing organizations, and why AI is the dividing line in modern tools.", href: "/blog/corgtex-vs-glassfrog-vs-peerdom", date: "April 2026" },
    { title: "Self-Management with AI: From Hierarchy to Intelligence", description: "How to use autonomous agents and structural accountability to run an organization that relies on information instead of hierarchy.", href: "/blog/self-management-with-ai", date: "May 2026" },
    { title: "AI Used to Be Your Intern. Now It's Becoming Your CEO.", description: "The era of AI as a 'smart intern' is over. The true value of large language models lies in replacing the coordination functions of middle management.", href: "/blog/ai-used-to-be-your-intern", date: "May 2026" },
    { title: "Automation Is Just Table Stakes - Decision-Making Is Where AI Will Excel", description: "Workflow automation is a solved problem. The real frontier is using AI to facilitate complex decisions under distributed authority.", href: "/blog/automation-is-just-table-stakes", date: "May 2026" },
  ],
  es: [
    { title: "¿Qué es un sistema operativo organizacional?", description: "Descubre por qué el conocimiento, la comunicación y la gobernanza fragmentados frenan a tu organización, y cómo un OS unificado lo corrige.", href: "/blog/what-is-organizational-operating-system", date: "Abril 2026" },
    { title: "Corgtex vs GlassFrog vs Peerdom: comparación 2026", description: "Una mirada objetiva al software líder para organizaciones autogestionadas y por qué la IA marca la diferencia.", href: "/blog/corgtex-vs-glassfrog-vs-peerdom", date: "Abril 2026" },
    { title: "Autogestión con IA: de jerarquía a inteligencia", description: "Cómo usar agentes autónomos y responsabilidad estructural para operar una organización basada en información, no jerarquía.", href: "/blog/self-management-with-ai", date: "Mayo 2026" },
    { title: "La IA era tu pasante. Ahora se acerca a tu CEO.", description: "La era de la IA como 'pasante inteligente' terminó. El valor real de los LLM está en reemplazar funciones de coordinación de mandos medios.", href: "/blog/ai-used-to-be-your-intern", date: "Mayo 2026" },
    { title: "La automatización ya es básica: la toma de decisiones es donde la IA destacará", description: "La automatización de workflows ya está resuelta. La frontera real es usar IA para facilitar decisiones complejas bajo autoridad distribuida.", href: "/blog/automation-is-just-table-stakes", date: "Mayo 2026" },
  ],
} as const;

const copy = {
  en: {
    metadata: {
      title: "Insights & Resources",
      description: "Articles, case studies, and thought leadership on AI-powered organizational transformation, self-management, and decentralized governance.",
    },
    label: "Resources",
    title: "Organizational Intelligence",
    intro: "The playbook for AI-powered decentralized governance, direct from the pioneers of self-management.",
    read: "Read article",
    ctaTitle: "Prefer to read the book?",
    ctaBody: "Get the foundational theory behind Corgtex in \"How to DAO\" by Puncar.",
    getBook: "Get the Book",
    theory: "Explore the Theory",
  },
  es: {
    metadata: {
      title: "Ideas y recursos",
      description: "Artículos, casos y pensamiento estratégico sobre transformación organizacional con IA, autogestión y gobernanza descentralizada.",
    },
    label: "Recursos",
    title: "Inteligencia organizacional",
    intro: "El playbook para gobernanza descentralizada impulsada por IA, desde los pioneros de la autogestión.",
    read: "Leer artículo",
    ctaTitle: "¿Prefieres leer el libro?",
    ctaBody: "Conoce la teoría base detrás de Corgtex en \"How to DAO\" de Puncar.",
    getBook: "Comprar el libro",
    theory: "Explorar la teoría",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path: "/blog" });
}

export default async function BlogIndexPage({ params }: LocaleParams) {
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

      <section className="section">
        <div className="container" style={{ maxWidth: "1000px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "32px" }}>
            {posts[locale].map((post, index) => (
              <ScrollReveal key={post.href} delay={Math.min(index * 100, 300)}>
                <Link href={hrefFor(locale, post.href)} style={{ textDecoration: "none", color: "inherit", display: "block", height: "100%" }}>
                  <div className="card" style={{ height: "100%", cursor: "pointer", display: "flex", flexDirection: "column" }}>
                    <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "12px", borderBottom: "1px solid var(--border)", paddingBottom: "12px" }}>{post.date}</div>
                    <h3 style={{ fontSize: "1.4rem", marginBottom: "16px", lineHeight: "1.3" }}>{post.title}</h3>
                    <p style={{ color: "var(--text-secondary)", fontSize: "1.05rem", flex: 1 }}>{post.description}</p>
                    <div style={{ marginTop: "24px", color: "var(--text)", fontWeight: 600, display: "flex", alignItems: "center" }}>
                      {t.read} <span style={{ marginLeft: "8px" }}>-&gt;</span>
                    </div>
                  </div>
                </Link>
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
              <a href="https://www.amazon.com/dp/059371377X" className="btn btn-primary" target="_blank" rel="noopener noreferrer">{t.getBook}</a>
              <a href="https://howtodao.xyz" className="btn btn-secondary" target="_blank" rel="noopener noreferrer">{t.theory}</a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
