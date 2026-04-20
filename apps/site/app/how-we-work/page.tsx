import type { Metadata } from "next";
import { ScrollReveal } from "../../components/ScrollReveal";

export const metadata: Metadata = {
  title: "How We Work — From Briefing to Full Ownership",
  description: "Corgtex deploys a governed AI workforce in 8 weeks. From first briefing to full ownership — no per-seat fees, no lock-in.",
};

export default function HowWeWorkPage() {
  return (
    <>
      <section className="section" style={{ paddingBottom: "48px" }}>
        <div className="container" style={{ maxWidth: "800px", textAlign: "center" }}>
          <ScrollReveal><span className="section-label">Engagement Model</span></ScrollReveal>
          <ScrollReveal delay={100}><h1 style={{ marginTop: "24px" }}>From First Briefing to Full Ownership</h1></ScrollReveal>
          <ScrollReveal delay={200}>
            <p style={{ fontSize: "1.2rem", maxWidth: "620px", margin: "24px auto 0", color: "var(--text-secondary)" }}>
              We don&rsquo;t sell software and walk away. We install a governed AI workforce, train your people, and hand you the keys.
            </p>
          </ScrollReveal>
        </div>
      </section>

      <div className="rule-strong" style={{ maxWidth: "var(--max-width)", margin: "0 auto" }} />

      <section className="section section-ruled">
        <div className="container">
          <div className="phases-grid">
            <ScrollReveal delay={0}>
              <div className="phase-card">
                <div className="phase-number">01</div>
                <span className="phase-badge">45 Min</span>
                <h3>Briefing</h3>
                <p>We show your data on a working Corgtex. You see your organization through the newspaper for the first time.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={100}>
              <div className="phase-card">
                <div className="phase-number">02</div>
                <span className="phase-badge">2 Weeks</span>
                <h3>Scoping</h3>
                <p>We map your tools, your governance rules, your risks. A blueprint tailored to your AI landscape.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={200}>
              <div className="phase-card">
                <div className="phase-number">03</div>
                <span className="phase-badge">8 Weeks</span>
                <h3>Implementation</h3>
                <p>We install, connect, and train your people. Every agent governed, every cost visible, every workflow live.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={300}>
              <div className="phase-card">
                <div className="phase-number">04</div>
                <span className="phase-badge">Ongoing</span>
                <h3>Live, and Yours</h3>
                <p>Integrated from day one. Move it to your infrastructure whenever you want &mdash; or never. No per-seat fees. No lock-in.</p>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      <section className="section section-dark cta-banner">
        <div className="container">
          <ScrollReveal>
            <h2>Start With a Briefing</h2>
            <p>45 minutes. Your data. No slides.</p>
            <div className="btn-group">
              <a href="https://calendar.app.google/jJd5yeSuDStVZm896" className="btn btn-primary" target="_blank" rel="noopener noreferrer">Schedule a Briefing</a>
              <a href="https://app.corgtex.com/demo" className="btn btn-secondary" target="_blank" rel="noopener noreferrer">Access the Demo</a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
