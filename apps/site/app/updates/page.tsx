import type { Metadata } from "next";
import { ScrollReveal } from "../../components/ScrollReveal";
import { StructuredData } from "../../components/StructuredData";

export const metadata: Metadata = {
  title: "Product Updates",
  description: "Changelog and product updates for Corgtex, the intelligence layer for self-managing organizations.",
};

const updates = [
  {
    version: "v0.10",
    name: "Intelligence Layer",
    date: "Apr 14–15, 2026",
    prs: "#97–#99",
    features: [
      "Integrated O2 organizational methodology alongside Holacracy and Sociocracy.",
      "Upgraded finance agent UX with seamless inline approval workflows.",
      "Added native subtitles and improved audio playback for landing page videos."
    ]
  },
  {
    version: "v0.9",
    name: "Production Hardening",
    date: "Apr 12–13, 2026",
    prs: "#74–#89",
    features: [
      "Separated build-time execution from database mutation for safer deployments.",
      "Visual upgrade to the Corgtex marketing interface with an editorial newspaper aesthetic.",
      "Resolved autonomous deployment stability issues.",
      "Refactored site copy for sharper thought leadership positioning."
    ]
  },
  {
    version: "v0.8",
    name: "Chat & Governance",
    date: "Apr 9, 2026",
    prs: "#58–#62",
    features: [
      "Introduced the Chat Newsroom interface for conversational briefings.",
      "Added the ability for agents to autonomously review run results.",
      "Seeded the first 10 points of the governance constitution automatically for new workspaces."
    ]
  },
  {
    version: "v0.7",
    name: "Newsroom & Chat",
    date: "Apr 9, 2026",
    prs: "#51–#56",
    features: [
      "Implemented chat streaming for faster conversational responses.",
      "Refactored the newsroom architecture for better scale and performance.",
      "Added guided MCP (Model Context Protocol) connection flows.",
      "Resolved markdown rendering issues in production."
    ]
  },
  {
    version: "v0.6",
    name: "Knowledge & Finance",
    date: "Apr 9, 2026",
    prs: "#45–#49",
    features: [
      "Launched the Wiki Dashboard for centralized organizational knowledge.",
      "Introduced full-screen file uploads in the chat interface.",
      "Released v1 of the Finance and Accounting UI.",
      "Added automatic brain data seeding for new workspaces.",
      "Cleaned up legacy knowledge retrieval code."
    ]
  },
  {
    version: "v0.5",
    name: "Event System",
    date: "Apr 8, 2026",
    prs: "#32–#33",
    features: [
      "Implemented global event ingestion across all organizational tools.",
      "Fixed issues related to organizational brain backups and restoration."
    ]
  },
  {
    version: "v0.4",
    name: "Organizational Brain",
    date: "Apr 7, 2026",
    prs: "#24–#28",
    features: [
      "Rewrote the brain data layer for highly accurate RAG search.",
      "Introduced dedicated brain API routes for agent execution.",
      "Created the absorb agent workflow for ingesting unstructured data.",
      "Built out the Brain UI and maintenance tools."
    ]
  },
  {
    version: "v0.3",
    name: "Agent Runtime",
    date: "Apr 3, 2026",
    prs: "#11–#14",
    features: [
      "Launched Agent Runtime v1 to execute autonomous operations.",
      "Released the Operator Console for administrative oversight.",
      "Enhanced security and hardening across the agent boundary.",
      "Fixed agent testing and documentation scripts."
    ]
  },
  {
    version: "v0.2",
    name: "Business Logic",
    date: "Apr 2–3, 2026",
    prs: "#8–#10",
    features: [
      "Established business workflow parity with manual processes.",
      "Completed the event runtime completion state engine.",
      "Introduced the model gateway for switching between LLM providers."
    ]
  },
  {
    version: "v0.1",
    name: "Foundation",
    date: "Apr 2, 2026",
    prs: "#1–#5",
    features: [
      "Initial CRUD operations for circles, proposals, and members.",
      "Foundational UI enhancements and layout framework.",
      "Comprehensive test coverage integration.",
      "Established continuous deployment (DevOps) pipelines.",
      "Implemented server-side pagination."
    ]
  }
];

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  "name": "Product Updates",
  "description": "Changelog and product updates for Corgtex",
  "publisher": {
    "@id": "https://corgtex.com/#organization"
  }
};

export default function UpdatesPage() {
  return (
    <>
      <StructuredData data={structuredData} />
      
      <section className="section" style={{ paddingBottom: "48px" }}>
        <div className="container" style={{ maxWidth: "800px", textAlign: "center" }}>
          <ScrollReveal><span className="section-label">Changelog</span></ScrollReveal>
          <ScrollReveal delay={100}><h1 style={{ marginTop: "24px" }}>Product Updates</h1></ScrollReveal>
          <ScrollReveal delay={200}>
            <p style={{ fontSize: "1.2rem", maxWidth: "620px", margin: "24px auto 0", color: "var(--text-secondary)" }}>
              The continuous evolution of the Corgtex intelligent operating system, built transparently.
            </p>
          </ScrollReveal>
        </div>
      </section>

      <div className="rule-strong" style={{ maxWidth: "var(--max-width)", margin: "0 auto" }} />

      <section className="section">
        <div className="container" style={{ maxWidth: "800px" }}>
          <div className="changelog-timeline">
            {updates.map((update, index) => (
              <ScrollReveal key={update.version} delay={Math.min(index * 50, 300)}>
                <div className="changelog-entry">
                  <div className="changelog-header">
                    <div className="changelog-version">
                      <span className="version-badge">{update.version}</span>
                      <span className="version-name">{update.name}</span>
                    </div>
                    <div className="changelog-meta">
                      <span className="changelog-date">{update.date}</span>
                      <span className="changelog-prs">{update.prs}</span>
                    </div>
                  </div>
                  <ul className="changelog-features">
                    {update.features.map((feature, i) => (
                      <li key={i}>{feature}</li>
                    ))}
                  </ul>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-dark cta-banner">
        <div className="container">
          <ScrollReveal>
            <h2>Want to see the latest version?</h2>
            <p>Walk through circles, proposals, the knowledge base, and an intelligent briefing in our interactive demo.</p>
            <div className="btn-group">
              <a href="https://app.corgtex.com/demo" className="btn btn-primary" target="_blank" rel="noopener noreferrer">Try the Live Demo</a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
