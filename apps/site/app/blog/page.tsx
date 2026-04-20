import type { Metadata } from "next";
import { ScrollReveal } from "../../components/ScrollReveal";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Insights & Resources",
  description: "Articles, case studies, and thought leadership on AI-powered organizational transformation, self-management, and decentralized governance.",
};

const PILLAR_PAGES = [
  {
    title: "What is an Organizational Operating System?",
    description: "Discover why fragmented knowledge, communication, and governance tools are slowing you down, and how a unified OS fixes it.",
    href: "/blog/what-is-organizational-operating-system",
    date: "April 2026",
  },
  {
    title: "Corgtex vs GlassFrog vs Peerdom: 2026 Comparison",
    description: "An objective look at the top software for self-managing organizations, and why AI is the dividing line in modern tools.",
    href: "/blog/corgtex-vs-glassfrog-vs-peerdom",
    date: "April 2026",
  },
  {
    title: "Self-Management with AI: From Hierarchy to Intelligence",
    description: "How to use autonomous agents and structural accountability to run an organization that relies on information instead of hierarchy.",
    href: "/blog/self-management-with-ai",
    date: "May 2026",
  },
  {
    title: "AI Used to Be Your Intern. Now It's Becoming Your CEO.",
    description: "The era of AI as a 'smart intern' is over. The true value of large language models lies in replacing the coordination functions of middle management.",
    href: "/blog/ai-used-to-be-your-intern",
    date: "May 2026",
  },
  {
    title: "Automation Is Just Table Stakes — Decision-Making Is Where AI Will Excel",
    description: "Workflow automation is a solved problem. The real frontier is using AI to facilitate complex decisions under distributed authority.",
    href: "/blog/automation-is-just-table-stakes",
    date: "May 2026",
  }
];

export default function BlogIndexPage() {
  return (
    <>
      <section className="section" style={{ paddingBottom: "48px" }}>
        <div className="container" style={{ maxWidth: "800px", textAlign: "center" }}>
          <ScrollReveal><span className="section-label">Resources</span></ScrollReveal>
          <ScrollReveal delay={100}><h1 style={{ marginTop: "24px" }}>Organizational Intelligence</h1></ScrollReveal>
          <ScrollReveal delay={200}>
            <p style={{ fontSize: "1.2rem", maxWidth: "620px", margin: "24px auto 0", color: "var(--text-secondary)" }}>
              The playbook for AI-powered decentralized governance, direct from the pioneers of self-management.
            </p>
          </ScrollReveal>
        </div>
      </section>

      <div className="rule-strong" style={{ maxWidth: "var(--max-width)", margin: "0 auto" }} />

      <section className="section">
        <div className="container" style={{ maxWidth: "1000px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "32px" }}>
            {PILLAR_PAGES.map((post, index) => (
              <ScrollReveal key={post.href} delay={Math.min(index * 100, 300)}>
                <Link href={post.href} style={{ textDecoration: "none", color: "inherit", display: "block", height: "100%" }}>
                  <div className="card" style={{ height: "100%", cursor: "pointer", display: "flex", flexDirection: "column" }}>
                    <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "12px", borderBottom: "1px solid var(--border)", paddingBottom: "12px" }}>
                      {post.date}
                    </div>
                    <h3 style={{ fontSize: "1.4rem", marginBottom: "16px", lineHeight: "1.3" }}>
                      {post.title}
                    </h3>
                    <p style={{ color: "var(--text-secondary)", fontSize: "1.05rem", flex: 1 }}>
                      {post.description}
                    </p>
                    <div style={{ marginTop: "24px", color: "var(--text)", fontWeight: 600, display: "flex", alignItems: "center" }}>
                      Read article <span style={{ marginLeft: "8px" }}>→</span>
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
            <h2>Prefer to read the book?</h2>
            <p>Get the foundational theory behind Corgtex in &ldquo;How to DAO&rdquo; by Puncar.</p>
            <div className="btn-group">
              <a href="https://www.amazon.com/dp/059371377X" className="btn btn-primary" target="_blank" rel="noopener noreferrer">Get the Book</a>
              <a href="https://howtodao.xyz" className="btn btn-secondary" target="_blank" rel="noopener noreferrer">Explore the Theory</a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
