import type { Metadata } from "next";
import { ScrollReveal } from "../../components/ScrollReveal";
import { StructuredData } from "../../components/StructuredData";

export const metadata: Metadata = {
  title: "Pricing — Enterprise Rollout",
  description: "Corgtex operates on custom enterprise pricing tailored to the size of your organization and chosen deployment model (Cloud, On-Premise, Hybrid).",
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  "name": "Pricing",
  "description": "Enterprise pricing for Corgtex",
  "offer": {
    "@type": "Offer",
    "businessFunction": "http://purl.org/goodrelations/v1#ProvideService",
    "description": "Custom enterprise pricing for governed AI workforce platform"
  }
};

export default function PricingPage() {
  return (
    <>
      <StructuredData data={structuredData} />
      
      <section className="section" style={{ paddingBottom: "48px" }}>
        <div className="container" style={{ maxWidth: "800px", textAlign: "center" }}>
          <ScrollReveal><span className="section-label">Pricing</span></ScrollReveal>
          <ScrollReveal delay={100}><h1 style={{ marginTop: "24px" }}>Your AI Workforce, Priced for Scale</h1></ScrollReveal>
          <ScrollReveal delay={200}>
            <p style={{ fontSize: "1.2rem", maxWidth: "620px", margin: "24px auto 0", color: "var(--text-secondary)" }}>
              We partner with organizations serious about governing their AI workforce at scale. Our pricing is custom, based on your scale and compliance needs.
            </p>
          </ScrollReveal>
        </div>
      </section>

      <div className="rule-strong" style={{ maxWidth: "var(--max-width)", margin: "0 auto" }} />

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">Deployment Modes</span>
              <h2>Your Data, Your Infrastructure</h2>
            </div>
          </ScrollReveal>

          <div className="cards-grid deployment-cards">
            <ScrollReveal delay={0}>
              <div className="card">
                <div className="card-number" style={{ fontSize: "2rem" }}>I</div>
                <h3>Cloud SaaS</h3>
                <p>We handle the infrastructure. Automatic updates, zero maintenance overhead, hosted securely on our enterprise cloud.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={100}>
              <div className="card">
                <div className="card-number" style={{ fontSize: "2rem" }}>II</div>
                <h3>Hybrid</h3>
                <p>Sensitive documents stay on your hardware. Governance metadata and processing are handled by our secure cloud.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={200}>
              <div className="card">
                <div className="card-number" style={{ fontSize: "2rem" }}>III</div>
                <h3>On-Premise</h3>
                <p>A completely self-contained deployment. Your data never leaves your building. Ideal for highly regulated environments.</p>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container" style={{ maxWidth: "800px" }}>
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">All Inclusive</span>
              <h2>Everything Included in Every Plan</h2>
              <p>No per-seat fees. No feature gates. Every enterprise partner gets the complete governed AI workforce.</p>
            </div>
          </ScrollReveal>

          <ScrollReveal delay={100}>
            <div className="pricing-features">
              <div className="pricing-feature-list">
                <div className="pricing-feature-item">
                  <strong>Personalized Briefings</strong>
                  <span>Daily AI workforce briefings for every member based on their roles.</span>
                </div>
                <div className="pricing-feature-item">
                  <strong>Workforce Graph</strong>
                  <span>Every AI agent mapped &mdash; what it does, what data it touches, who owns it.</span>
                </div>
                <div className="pricing-feature-item">
                  <strong>Governance &amp; Guardrails</strong>
                  <span>Policies, approvals, human-on-the-loop for high-impact agent actions.</span>
                </div>
                <div className="pricing-feature-item">
                  <strong>Methodology Agnostic</strong>
                  <span>Native support for O2, Holacracy, Sociocracy, or custom models.</span>
                </div>
                <div className="pricing-feature-item">
                  <strong>Spend &amp; ROI</strong>
                  <span>AI costs attributed to real work. Budgets, forecasts, surfaced next to output.</span>
                </div>
                <div className="pricing-feature-item">
                  <strong>MCP Integrations</strong>
                  <span>Bring Corgtex data directly into ChatGPT, Claude, or Gemini natively.</span>
                </div>
                <div className="pricing-feature-item">
                  <strong>Dedicated Success</strong>
                  <span>Direct channel to our engineering team for methodology alignment.</span>
                </div>
              </div>
            </div>
          </ScrollReveal>

          <ScrollReveal delay={200}>
            <div style={{ marginTop: "48px", textAlign: "center" }}>
              <a href="https://calendar.app.google/jJd5yeSuDStVZm896" className="btn btn-primary" style={{ padding: "16px 40px", fontSize: "1.05rem" }} target="_blank" rel="noopener noreferrer">
                Schedule a Scoping Briefing
              </a>
              <p style={{ marginTop: "16px", fontSize: "0.9rem", color: "var(--text-tertiary)" }}>
                30-minute discovery call with our founding team.
              </p>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container" style={{ maxWidth: "800px" }}>
          <ScrollReveal>
            <div className="section-header">
              <h2>Frequently Asked Questions</h2>
            </div>
          </ScrollReveal>

          <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
            <ScrollReveal>
              <div>
                <h3 style={{ fontSize: "1.3rem", marginBottom: "8px" }}>Do you charge per seat?</h3>
                <p style={{ color: "var(--text-secondary)" }}>Decentralization doesn&rsquo;t work if you have to pay a toll for every new contributor. We price based on organizational scale and the computational resources required for your intelligence layer, not an arbitrary per-seat license.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={100}>
              <div>
                <h3 style={{ fontSize: "1.3rem", marginBottom: "8px" }}>Can we start with a pilot?</h3>
                <p style={{ color: "var(--text-secondary)" }}>Yes. For qualifying organizations, we offer a bounded pilot where we connect Corgtex to a subset of your tools (e.g., Slack and Google Drive for one division) to prove the viability of the personalized briefings before a full rollout.</p>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>
    </>
  );
}
