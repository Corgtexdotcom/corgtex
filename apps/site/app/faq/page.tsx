import type { Metadata } from "next";
import { ScrollReveal } from "../../components/ScrollReveal";
import { StructuredData } from "../../components/StructuredData";

export const metadata: Metadata = {
  title: "FAQ — AI Workforce Governance",
  description: "Answers to common questions about governing AI workforces, agent visibility, cost attribution, and Corgtex.",
};

const faqs = [
  {
    question: "What is Corgtex?",
    answer: "Corgtex is a governed AI workforce platform. It gives you total visibility into every AI agent — what it's doing, what data it touches, what it costs — governed by your organizational policies.",
  },
  {
    question: "How does Corgtex work?",
    answer: "Corgtex maps your AI tools and agents into a Workforce Graph, applies governance policies and approvals, attributes costs to real work, and surfaces everything in a personalized daily briefing.",
  },
  {
    question: "What is an organizational operating system?",
    answer: "An organizational operating system unifies the management of your AI workforce. Instead of separate dashboards for each tool, one platform governs agents, tracks costs, and surfaces outcomes.",
  },
  {
    question: "How does Corgtex use AI for governance?",
    answer: "Corgtex uses AI to automatically route proposals to the correct domain experts based on organizational structure. It facilitates consent-based decision-making by tracking objections, ensuring policies are followed, and providing a complete, cited audit trail for every decision made.",
  },
  {
    question: "What is a personalized organizational briefing?",
    answer: "A personalized briefing is the role-specific daily surface for your AI workforce. Instead of generic company-wide updates, Corgtex shows each leader the agent activity, governance decisions, costs, and anomalies they need to know and act on.",
  },
  {
    question: "How does Corgtex compare to GlassFrog or Holacracy tools?",
    answer: "While GlassFrog primarily enforces Holacracy rules and records structure, Corgtex adds AI workforce visibility, governance guardrails, cost attribution, and personalized briefings on top of structural accountability.",
  },
  {
    question: "Can Corgtex replace traditional management software?",
    answer: "Yes. Corgtex is designed to replace passive wikis, governance tools, and fragmented communication platforms. It provides a unified interface for knowledge management, organizational communication, financial tracking, and decentralized decision-making.",
  },
  {
    question: "How long does it take to set up Corgtex?",
    answer: "Corgtex can be live in weeks. Weeks 1-2 involve connecting your existing tools and mapping your organizational structure. Weeks 2-4 involve the AI classifying historical data and running initial governance workflows. By week 4, personalized briefings are fully operational.",
  },
  {
    question: "Does Corgtex integrate with existing tools?",
    answer: "Yes. Corgtex integrates with platforms you already use, such as Slack and Google Workspace. Additionally, via the Model Context Protocol (MCP), Corgtex can surface governed AI workforce context directly inside interfaces like ChatGPT, Claude, and Gemini.",
  },
  {
    question: "Is Corgtex available on-premise?",
    answer: "Yes. Corgtex offers flexible deployment options. We offer a fully managed Cloud version, an On-Premise appliance where data never leaves your building, and a Hybrid option keeping sensitive data local while offloading processing to the cloud.",
  },
  {
    question: "What kind of organizations use Corgtex?",
    answer: "Corgtex is used by enterprise clients scaling decentralized structures. For example, our enterprise launch partner uses Corgtex to transform a portfolio of 1,000 acquired companies across the United States into self-managing, employee-owned entities.",
  },
  {
    question: "How does Corgtex handle data security?",
    answer: "Data security is handled through strict role-based access controls mapped to your organizational structure. For organizations with extreme security requirements, our On-Premise appliance option ensures proprietary data never touches external cloud networks.",
  },
  {
    question: "What is consent-based decision-making?",
    answer: "Consent-based decision-making is a governance process where a proposal advances unless a participant raises a substantiated, paramount objection. It prevents committee bottlenecks by prioritizing 'safe to try' actions over absolute consensus.",
  },
  {
    question: "How does Corgtex eliminate institutional knowledge loss?",
    answer: "Corgtex prevents knowledge loss by indexing every document, meeting transcription, and formal decision. When an employee asks why a decision was made years ago, Corgtex instantly retrieves the records, dissenting opinions, and outcome—with citations.",
  },
  {
    question: "How much does Corgtex cost?",
    answer: "Corgtex operates on custom enterprise pricing. The cost is scaled based on the size of your organization, the deployment model required (Cloud vs On-Premise), and the specific intelligence capabilities implemented. Contact us to schedule a scoping briefing.",
  },
];

const structuredData = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: faq.answer,
    },
  })),
};

export default function FAQPage() {
  return (
    <>
      <StructuredData data={structuredData} />
      
      <section className="section" style={{ paddingBottom: "48px" }}>
        <div className="container" style={{ maxWidth: "800px", textAlign: "center" }}>
          <ScrollReveal><span className="section-label">Knowledge Base</span></ScrollReveal>
          <ScrollReveal delay={100}><h1 style={{ marginTop: "24px" }}>Frequently Asked Questions</h1></ScrollReveal>
          <ScrollReveal delay={200}>
            <p style={{ fontSize: "1.2rem", maxWidth: "620px", margin: "24px auto 0", color: "var(--text-secondary)" }}>
              Everything you need to know about Corgtex, AI workforce governance, and implementing governed AI operations.
            </p>
          </ScrollReveal>
        </div>
      </section>

      <div className="rule-strong" style={{ maxWidth: "var(--max-width)", margin: "0 auto" }} />

      <section className="section">
        <div className="container" style={{ maxWidth: "800px" }}>
          <div className="faq-grid" style={{ display: "flex", flexDirection: "column", gap: "48px" }}>
            {faqs.map((faq, index) => (
              <ScrollReveal key={index} delay={Math.min(index * 50, 300)}>
                <div className="faq-item" id={`faq-${index}`}>
                  <h3 style={{ fontSize: "1.5rem", marginBottom: "16px", fontFamily: "var(--font-serif)" }}>
                    {faq.question}
                  </h3>
                  <p style={{ fontSize: "1.1rem", lineHeight: "1.7", color: "var(--text-secondary)" }}>
                    {faq.answer}
                  </p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: "32px", paddingBottom: "32px" }}>
        <div className="container" style={{ maxWidth: "800px" }}>
          <ScrollReveal>
            <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "24px", flexWrap: "wrap" }}>
              <div>
                <h3 style={{ fontSize: "1.3rem", marginBottom: "8px" }}>Product Updates</h3>
                <p style={{ color: "var(--text-secondary)", margin: 0 }}>See what&apos;s new in Corgtex — latest features, improvements, and fixes.</p>
              </div>
              <a href="/updates" className="btn btn-secondary" style={{ whiteSpace: "nowrap" }}>View Changelog →</a>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-dark cta-banner">
        <div className="container">
          <ScrollReveal>
            <h2>Ready to see it in action?</h2>
            <p>Walk through the Workforce Graph, governance workflows, cost attribution, and your morning briefing in our interactive demo.</p>
            <div className="btn-group">
              <a href="https://app.corgtex.com/demo" className="btn btn-primary" target="_blank" rel="noopener noreferrer">Access the Demo</a>
              <a href="https://calendar.app.google/jJd5yeSuDStVZm896" className="btn btn-secondary" target="_blank" rel="noopener noreferrer">Schedule a Briefing</a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
