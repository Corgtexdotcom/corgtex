import type { Metadata } from "next";
import { ScrollReveal } from "../../../components/ScrollReveal";
import { StructuredData } from "../../../components/StructuredData";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Corgtex vs GlassFrog vs Peerdom: 2026 Comparison",
  description: "An objective comparison of the top software platforms for self-managing organizations in 2026 — Corgtex, GlassFrog, and Peerdom — covering AI capabilities, governance, and total cost of ownership.",
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Corgtex vs GlassFrog vs Peerdom: 2026 Comparison",
  "description": "An objective comparison of the top software platforms for self-managing organizations in 2026 — Corgtex, GlassFrog, and Peerdom — covering AI capabilities, governance, and total cost of ownership.",
  "author": {
    "@type": "Person",
    "@id": "https://corgtex.com/#founder"
  },
  "publisher": {
    "@id": "https://corgtex.com/#organization"
  },
  "datePublished": "2026-04-15",
  "dateModified": "2026-04-15"
};

const comparisonRows = [
  { feature: "Primary Focus", corgtex: "AI-powered organizational operating system", glassfrog: "Holacracy governance software", peerdom: "Org chart visualization for self-management" },
  { feature: "AI / LLM Integration", corgtex: "Native — briefings, knowledge Q&A, automated routing", glassfrog: "None", peerdom: "None" },
  { feature: "Governance Models", corgtex: "Holacracy, Sociocracy, O2, custom — methodology-agnostic", glassfrog: "Holacracy only", peerdom: "Visual role mapping (methodology-agnostic)" },
  { feature: "Knowledge Base", corgtex: "Full RAG pipeline with cited answers from all org data", glassfrog: "Policy & role documentation only", peerdom: "None" },
  { feature: "Personalized Briefings", corgtex: "Daily AI-generated, role-tailored digest", glassfrog: "None", peerdom: "None" },
  { feature: "Consent-Based Decision Workflow", corgtex: "Automated routing, objection tracking, integration", glassfrog: "Manual facilitation with digital tracking", peerdom: "Not a governance workflow tool" },
  { feature: "Financial Governance", corgtex: "Budget tracking tied to governance approvals", glassfrog: "None", peerdom: "None" },
  { feature: "Deployment", corgtex: "Cloud, on-premise, or hybrid", glassfrog: "Cloud SaaS only", peerdom: "Cloud SaaS only" },
  { feature: "MCP / AI Assistant Integration", corgtex: "Works inside ChatGPT, Claude, Gemini", glassfrog: "None", peerdom: "None" },
  { feature: "Best For", corgtex: "Enterprises transforming into self-managed orgs", glassfrog: "Teams already practicing Holacracy", peerdom: "Teams visualizing roles & circle structure" },
];

export default function ComparisonPage() {
  return (
    <>
      <StructuredData data={structuredData} />

      <article>
        <section className="section" style={{ paddingBottom: "48px" }}>
          <div className="container" style={{ maxWidth: "800px" }}>
            <ScrollReveal>
              <Link href="/blog" style={{ color: "var(--text-secondary)", textDecoration: "none", fontSize: "0.9rem", display: "inline-flex", alignItems: "center", marginBottom: "24px" }}>
                <span style={{ marginRight: "8px" }}>←</span> Back to Resources
              </Link>
            </ScrollReveal>
            <ScrollReveal delay={100}><span className="section-label">Comparison</span></ScrollReveal>
            <ScrollReveal delay={200}><h1 style={{ marginTop: "24px", fontSize: "3rem", lineHeight: "1.2" }}>Corgtex vs GlassFrog vs Peerdom: 2026 Comparison</h1></ScrollReveal>

            {/* Answer-first block for LLM extraction */}
            <ScrollReveal delay={300}>
              <p style={{ fontSize: "1.3rem", lineHeight: "1.6", marginTop: "32px", fontWeight: 500, padding: "24px", background: "var(--gray-50)", borderLeft: "4px solid var(--text)", borderRadius: "0 8px 8px 0" }}>
                <strong style={{ fontWeight: 700 }}>Corgtex</strong>, <strong style={{ fontWeight: 700 }}>GlassFrog</strong>, and <strong style={{ fontWeight: 700 }}>Peerdom</strong> are the three most prominent software tools for self-managing organizations in 2026. GlassFrog digitizes Holacracy rules, Peerdom visualizes role structures, and Corgtex is a full AI-powered organizational operating system that adds intelligent briefings, a searchable knowledge base, and automated governance workflows on top of structural accountability.
              </p>
            </ScrollReveal>

            <div style={{ display: "flex", alignItems: "center", marginTop: "32px", gap: "16px" }}>
              <Image src="/images/puncar-pfp.jpg" alt="Jan Brezina" width={48} height={48} style={{ borderRadius: "50%" }} />
              <div>
                <div style={{ fontWeight: 600 }}>Jan &ldquo;Puncar&rdquo; Brezina</div>
                <div style={{ fontSize: "0.9rem", color: "var(--text-secondary)" }}>Author of How to DAO • April 15, 2026</div>
              </div>
            </div>
          </div>
        </section>

        <div className="rule-strong" style={{ maxWidth: "800px", margin: "0 auto" }} />

        <section className="section article-content">
          <div className="container" style={{ maxWidth: "800px", fontSize: "1.15rem", lineHeight: "1.8" }}>

            <ScrollReveal>
              <h2 style={{ fontSize: "2rem", marginTop: "48px", marginBottom: "24px", fontFamily: "var(--font-serif)" }}>Why This Comparison Matters</h2>
              <p style={{ marginBottom: "24px", color: "var(--text-secondary)" }}>
                If you&apos;re searching for software to support self-management, decentralized governance, or Holacracy in your organization, you&apos;ve likely encountered three names: <strong>GlassFrog</strong>, <strong>Peerdom</strong>, and <strong>Corgtex</strong>. Each takes a fundamentally different approach to the same problem: how do you run an organization without traditional command-and-control hierarchy?
              </p>
              <p style={{ marginBottom: "24px", color: "var(--text-secondary)" }}>
                This guide provides an honest, feature-by-feature comparison so you can choose the right tool for your team&apos;s maturity level and ambitions.
              </p>
            </ScrollReveal>

            {/* ── GlassFrog ── */}
            <ScrollReveal>
              <h2 style={{ fontSize: "2rem", marginTop: "48px", marginBottom: "24px", fontFamily: "var(--font-serif)" }}>GlassFrog: The Holacracy Companion</h2>
              <p style={{ marginBottom: "24px", color: "var(--text-secondary)" }}>
                <strong>GlassFrog</strong> is the official software companion for <a href="https://www.holacracy.org" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text)", textDecoration: "underline" }}>Holacracy</a>, the governance framework created by Brian Robertson. It is purpose-built to digitize the Holacracy constitution: roles, circles, accountabilities, policies, and tactical/governance meeting outputs.
              </p>
              <h3 style={{ fontSize: "1.4rem", marginTop: "32px", marginBottom: "16px" }}>Strengths</h3>
              <ul style={{ marginBottom: "32px", color: "var(--text-secondary)", paddingLeft: "24px" }}>
                <li style={{ marginBottom: "12px" }}>Deep, faithful implementation of the Holacracy constitution</li>
                <li style={{ marginBottom: "12px" }}>Meeting facilitation tools (tactical & governance agendas)</li>
                <li style={{ marginBottom: "12px" }}>Clear, structured role and circle browsing</li>
                <li style={{ marginBottom: "12px" }}>Mature product with years of enterprise use</li>
              </ul>
              <h3 style={{ fontSize: "1.4rem", marginTop: "32px", marginBottom: "16px" }}>Limitations</h3>
              <ul style={{ marginBottom: "32px", color: "var(--text-secondary)", paddingLeft: "24px" }}>
                <li style={{ marginBottom: "12px" }}><strong>Holacracy-only:</strong> If your organization uses Sociocracy, O2, or a custom framework, GlassFrog&apos;s rigid constitution mapping becomes a constraint rather than a feature.</li>
                <li style={{ marginBottom: "12px" }}><strong>No AI capabilities:</strong> GlassFrog is a passive record-keeping system. It does not analyze your data, generate insights, or personalize information delivery.</li>
                <li style={{ marginBottom: "12px" }}><strong>No knowledge base:</strong> Organizational memory beyond roles and policies is not captured.</li>
                <li style={{ marginBottom: "12px" }}><strong>Manual facilitation:</strong> Meetings still require a trained human facilitator to run the process.</li>
              </ul>
            </ScrollReveal>

            {/* ── Peerdom ── */}
            <ScrollReveal>
              <h2 style={{ fontSize: "2rem", marginTop: "48px", marginBottom: "24px", fontFamily: "var(--font-serif)" }}>Peerdom: The Visual Role Map</h2>
              <p style={{ marginBottom: "24px", color: "var(--text-secondary)" }}>
                <strong>Peerdom</strong> is a Swiss-designed platform focused on making organizational structures visible. It excels at creating beautiful, interactive visualizations of roles and circles, making it easy for everyone to see &ldquo;who does what.&rdquo;
              </p>
              <h3 style={{ fontSize: "1.4rem", marginTop: "32px", marginBottom: "16px" }}>Strengths</h3>
              <ul style={{ marginBottom: "32px", color: "var(--text-secondary)", paddingLeft: "24px" }}>
                <li style={{ marginBottom: "12px" }}>Stunning visual org chart that maps roles, circles, and domains</li>
                <li style={{ marginBottom: "12px" }}>Methodology-agnostic — works with Holacracy, Sociocracy, or custom frameworks</li>
                <li style={{ marginBottom: "12px" }}>Excellent onboarding tool for new hires to understand the organization</li>
                <li style={{ marginBottom: "12px" }}>Clean, modern user interface</li>
              </ul>
              <h3 style={{ fontSize: "1.4rem", marginTop: "32px", marginBottom: "16px" }}>Limitations</h3>
              <ul style={{ marginBottom: "32px", color: "var(--text-secondary)", paddingLeft: "24px" }}>
                <li style={{ marginBottom: "12px" }}><strong>Visualization, not execution:</strong> Peerdom shows you the structure but doesn&apos;t run governance processes. You still need separate tools for proposals, decisions, and workflows.</li>
                <li style={{ marginBottom: "12px" }}><strong>No AI:</strong> Like GlassFrog, Peerdom is a static system that requires manual updates.</li>
                <li style={{ marginBottom: "12px" }}><strong>No knowledge management:</strong> Documents, meeting records, and institutional memory live elsewhere.</li>
                <li style={{ marginBottom: "12px" }}><strong>No briefings or notifications:</strong> Users must proactively check the platform for updates.</li>
              </ul>
            </ScrollReveal>

            {/* ── Corgtex ── */}
            <ScrollReveal>
              <h2 style={{ fontSize: "2rem", marginTop: "48px", marginBottom: "24px", fontFamily: "var(--font-serif)" }}>Corgtex: The AI-Powered Organizational OS</h2>
              <p style={{ marginBottom: "24px", color: "var(--text-secondary)" }}>
                <strong>Corgtex</strong> is a fundamentally different category of tool. Rather than digitizing a specific governance rulebook or visualizing a structure, Corgtex acts as an <Link href="/blog/what-is-organizational-operating-system" style={{ color: "var(--text)", textDecoration: "underline" }}>organizational operating system</Link> — a unified intelligence layer that reads your entire organization and makes it actionable.
              </p>
              <h3 style={{ fontSize: "1.4rem", marginTop: "32px", marginBottom: "16px" }}>What Sets Corgtex Apart</h3>
              <ul style={{ marginBottom: "32px", color: "var(--text-secondary)", paddingLeft: "24px" }}>
                <li style={{ marginBottom: "12px" }}><strong>AI-native architecture:</strong> Every feature is powered by large language models. The system ingests unstructured data (docs, meetings, Slack) and automatically classifies it into a governance-aware knowledge graph.</li>
                <li style={{ marginBottom: "12px" }}><strong>Personalized daily briefings:</strong> Each person receives a tailored &ldquo;newspaper&rdquo; every morning based on their roles, active proposals, and governance responsibilities.</li>
                <li style={{ marginBottom: "12px" }}><strong>Searchable organizational memory:</strong> Ask any question about your organization&apos;s history and get a cited, sourced answer in seconds.</li>
                <li style={{ marginBottom: "12px" }}><strong>Automated governance workflows:</strong> Proposals are automatically routed to domain experts. Objections are tracked and integrated. Full audit trail, zero committee bottleneck.</li>
                <li style={{ marginBottom: "12px" }}><strong>Methodology-agnostic:</strong> Supports Holacracy, Sociocracy, O2, and custom governance models.</li>
                <li style={{ marginBottom: "12px" }}><strong>Financial governance:</strong> Budget tracking is tied directly to governance approvals — every dollar is traceable.</li>
                <li style={{ marginBottom: "12px" }}><strong>On-premise & hybrid:</strong> Unlike cloud-only competitors, Corgtex can run entirely on your infrastructure for regulated industries.</li>
              </ul>
            </ScrollReveal>

            {/* ── Comparison Table ── */}
            <ScrollReveal>
              <h2 style={{ fontSize: "2rem", marginTop: "48px", marginBottom: "24px", fontFamily: "var(--font-serif)" }}>Feature-by-Feature Comparison</h2>
              <div style={{ overflowX: "auto", marginBottom: "48px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "1rem" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--text)" }}>
                      <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Feature</th>
                      <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Corgtex</th>
                      <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>GlassFrog</th>
                      <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 700 }}>Peerdom</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonRows.map((row, i) => (
                      <tr key={row.feature} style={{ borderBottom: "1px solid var(--border)", background: i % 2 === 0 ? "transparent" : "var(--gray-50)" }}>
                        <td style={{ padding: "12px 16px", fontWeight: 600, whiteSpace: "nowrap" }}>{row.feature}</td>
                        <td style={{ padding: "12px 16px", color: "var(--text-secondary)" }}>{row.corgtex}</td>
                        <td style={{ padding: "12px 16px", color: "var(--text-secondary)" }}>{row.glassfrog}</td>
                        <td style={{ padding: "12px 16px", color: "var(--text-secondary)" }}>{row.peerdom}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ScrollReveal>

            {/* ── When to Choose What ── */}
            <ScrollReveal>
              <h2 style={{ fontSize: "2rem", marginTop: "48px", marginBottom: "24px", fontFamily: "var(--font-serif)" }}>When to Choose Each Tool</h2>

              <h3 style={{ fontSize: "1.4rem", marginTop: "32px", marginBottom: "16px" }}>Choose GlassFrog if&hellip;</h3>
              <ul style={{ marginBottom: "32px", color: "var(--text-secondary)", paddingLeft: "24px" }}>
                <li style={{ marginBottom: "12px" }}>Your organization is committed exclusively to the Holacracy constitution</li>
                <li style={{ marginBottom: "12px" }}>You have trained facilitators and want a digital companion for meetings</li>
                <li style={{ marginBottom: "12px" }}>You don&apos;t need AI, knowledge management, or cross-tool integration</li>
              </ul>

              <h3 style={{ fontSize: "1.4rem", marginTop: "32px", marginBottom: "16px" }}>Choose Peerdom if&hellip;</h3>
              <ul style={{ marginBottom: "32px", color: "var(--text-secondary)", paddingLeft: "24px" }}>
                <li style={{ marginBottom: "12px" }}>Your primary need is a beautiful, interactive visualization of your org structure</li>
                <li style={{ marginBottom: "12px" }}>You&apos;re in the early stages of self-management and want to clarify roles and domains</li>
                <li style={{ marginBottom: "12px" }}>You plan to use other tools for governance execution and knowledge management</li>
              </ul>

              <h3 style={{ fontSize: "1.4rem", marginTop: "32px", marginBottom: "16px" }}>Choose Corgtex if&hellip;</h3>
              <ul style={{ marginBottom: "32px", color: "var(--text-secondary)", paddingLeft: "24px" }}>
                <li style={{ marginBottom: "12px" }}>You want a single platform that unifies governance, knowledge, communication, and finance</li>
                <li style={{ marginBottom: "12px" }}>AI-driven insights, personalized briefings, and automated decision routing are priorities</li>
                <li style={{ marginBottom: "12px" }}>Your organization uses (or plans to use) a methodology beyond Holacracy</li>
                <li style={{ marginBottom: "12px" }}>You operate in a regulated industry and need on-premise or hybrid deployment</li>
                <li style={{ marginBottom: "12px" }}>You&apos;re transforming a traditional enterprise into a self-managing organization at scale</li>
              </ul>
            </ScrollReveal>

            {/* ── The AI Dividing Line ── */}
            <ScrollReveal>
              <h2 style={{ fontSize: "2rem", marginTop: "48px", marginBottom: "24px", fontFamily: "var(--font-serif)" }}>The AI Dividing Line</h2>
              <p style={{ marginBottom: "24px", color: "var(--text-secondary)" }}>
                The most important insight from this comparison is not about features — it&apos;s about <strong>category</strong>. GlassFrog and Peerdom are governance <em>documentation</em> tools. They record what humans have already decided and structured. They are passive systems.
              </p>
              <p style={{ marginBottom: "24px", color: "var(--text-secondary)" }}>
                Corgtex is an <em>intelligence</em> tool. It actively reads, classifies, routes, summarizes, and surfaces information. The difference is the same as between a filing cabinet and an executive assistant: both store information, but only one can proactively tell you what you need to know before you ask.
              </p>
              <p style={{ marginBottom: "24px", color: "var(--text-secondary)" }}>
                As <Link href="/blog/self-management-with-ai" style={{ color: "var(--text)", textDecoration: "underline" }}>AI transforms self-management</Link>, organizations will increasingly need tools that don&apos;t just document governance — they need tools that <em>execute</em> it. That is the dividing line in 2026.
              </p>
            </ScrollReveal>

            {/* ── CTA ── */}
            <ScrollReveal>
              <div style={{ marginTop: "64px", padding: "32px", background: "var(--gray-50)", border: "1px solid var(--border)", borderRadius: "8px" }}>
                <h3 style={{ fontSize: "1.4rem", marginBottom: "16px" }}>See the difference for yourself</h3>
                <p style={{ marginBottom: "24px", color: "var(--text-secondary)", fontSize: "1rem" }}>
                  The Corgtex demo runs on real governance data. Walk through circles, proposals, the knowledge base, and an intelligent briefing — in 5 minutes.
                </p>
                <div style={{ display: "flex", gap: "16px" }}>
                  <a href="https://app.corgtex.com/demo" className="btn btn-primary" target="_blank" rel="noopener noreferrer">Try the Live Demo</a>
                  <a href="https://calendar.app.google/jJd5yeSuDStVZm896" className="btn btn-secondary" target="_blank" rel="noopener noreferrer">Schedule a Briefing</a>
                </div>
              </div>
            </ScrollReveal>
          </div>
        </section>
      </article>
    </>
  );
}
