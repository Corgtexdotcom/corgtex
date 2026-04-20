import Image from "next/image";
import { ScrollReveal } from "../components/ScrollReveal";
import { DemoGateForm } from "../components/DemoGateForm";

export default function HomePage() {
  return (
    <>
      {/* ── Masthead ── */}
      <section className="masthead">
        <div className="container">
          <div className="masthead-content">
            <ScrollReveal delay={100}>
              <h1>Run your AI workforce like an accountable team.</h1>
            </ScrollReveal>
            <ScrollReveal delay={200}>
              <p className="masthead-subtitle">
                See what every agent is doing. Govern it with your rules. Know what it costs. Live in weeks, yours to own.
              </p>
            </ScrollReveal>
            <ScrollReveal delay={300}>
              <div className="btn-group">
                <DemoGateForm />
                <a href="https://calendar.app.google/jJd5yeSuDStVZm896" className="btn btn-primary" target="_blank" rel="noopener noreferrer">
                  Schedule a Briefing
                </a>
              </div>
            </ScrollReveal>
          </div>
          
          <ScrollReveal delay={400}>
            <div className="masthead-video">
              <video
                src="/videos/landing_page.mp4"
                autoPlay
                loop
                muted
                playsInline
              >
                <track kind="subtitles" src="/videos/landing_page.vtt" srcLang="en" label="English" default />
              </video>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── Personalization Story: 3 Editions ── */}
      <section className="section section-ruled">
        <div className="container" style={{ textAlign: "center" }}>
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">The Daily Surface</span>
              <h2>Every morning, one page. Everything your AI workforce produced overnight.</h2>
              <p>The newspaper is how you experience the workforce. Briefings, anomalies, costs, governance decisions &mdash; all three pillars, surfaced for your role.</p>
            </div>
          </ScrollReveal>

          <ScrollReveal delay={200}>
            <Image
              src="/images/personalization-editions.png"
              alt="CEO Edition vs VP Engineering Edition vs New Hire Edition"
              width={1600}
              height={800}
              style={{ width: "100%", height: "auto", maxWidth: "1000px", margin: "0 auto", mixBlendMode: "multiply" }}
            />
          </ScrollReveal>
        </div>
      </section>

      {/* ── Three Grounded Outcomes ── */}
      <section className="section section-ruled section-dark">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label" style={{ color: "rgba(250,249,246,0.6)", borderColor: "rgba(250,249,246,0.3)" }}>What Changes</span>
              <h2>When You See Your Entire AI Workforce</h2>
            </div>
          </ScrollReveal>

          <div className="cards-grid" style={{ background: "rgba(250,249,246,0.1)", border: "1px solid rgba(250,249,246,0.15)" }}>
            <ScrollReveal delay={0}>
              <div className="card" style={{ background: "rgba(250,249,246,0.04)" }}>
                <div className="card-number" style={{ color: "rgba(250,249,246,0.2)" }}>I</div>
                <h3>Know</h3>
                <p style={{ fontStyle: "italic", marginBottom: "16px", color: "rgba(250,249,246,0.8)" }}>Your new SVP asks &ldquo;Why did we exit the APAC market?&rdquo;</p>
                <p>They type the question into Corgtex. It pulls the board decision from 2024, the risk analysis, and the three dissenting opinions &mdash; with citations.</p>
                <div className="rule" style={{ background: "transparent", borderBottom: "1px solid rgba(250,249,246,0.1)", height: "1px", margin: "24px 0" }} />
                <p style={{ fontWeight: 600, color: "var(--text-inverse)" }}>No more institutional knowledge walking out the door. Every answer grounded in your actual records.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={100}>
              <div className="card" style={{ background: "rgba(250,249,246,0.04)" }}>
                <div className="card-number" style={{ color: "rgba(250,249,246,0.2)" }}>II</div>
                <h3>Decide</h3>
                <p style={{ fontStyle: "italic", marginBottom: "16px", color: "rgba(250,249,246,0.8)" }}>Product circle submits a $2M budget proposal.</p>
                <p>Corgtex routes it to 4 domain experts based on expertise. They review, raise one objection, it gets integrated. Resolved in 48 hours.</p>
                <div className="rule" style={{ background: "transparent", borderBottom: "1px solid rgba(250,249,246,0.1)", height: "1px", margin: "24px 0" }} />
                <p style={{ fontWeight: 600, color: "var(--text-inverse)" }}>Decisions that used to take weeks of meetings close in days. Full audit trail provided automatically.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={200}>
              <div className="card" style={{ background: "rgba(250,249,246,0.04)" }}>
                <div className="card-number" style={{ color: "rgba(250,249,246,0.2)" }}>III</div>
                <h3>See</h3>
                <p style={{ fontStyle: "italic", marginBottom: "16px", color: "rgba(250,249,246,0.8)" }}>Two departments are unknowingly duplicating a vendor evaluation.</p>
                <p>Corgtex flags the overlap in your morning briefing directly to the domain leads. You connect the teams in one message and save the effort.</p>
                <div className="rule" style={{ background: "transparent", borderBottom: "1px solid rgba(250,249,246,0.1)", height: "1px", margin: "24px 0" }} />
                <p style={{ fontWeight: 600, color: "var(--text-inverse)" }}>Cross-organization visibility without surveillance. Tensions surfaced before they cost money.</p>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* ── Demo Terminal ── */}
      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="demo-panel">
              <div className="demo-panel-text">
                <span className="section-label">Command Your Workforce</span>
                <h2>Direct Your Organization</h2>
                <p>Don&rsquo;t just monitor. Act. Query agent performance, trigger governance workflows, or redirect AI resources from a single interface.</p>
                <div className="btn-group">
                  <DemoGateForm />
                </div>
              </div>
              <div className="demo-panel-visual">
                <div className="demo-terminal">
                  <div className="demo-terminal-bar">
                    <div className="demo-terminal-dot" />
                    <div className="demo-terminal-dot" />
                    <div className="demo-terminal-dot" />
                  </div>
                  <div className="demo-terminal-body">
                    <p><span className="prompt">you:</span> <span className="cmd">What needs my attention this week?</span></p>
                    <p><span className="output">Corgtex: Three items requiring attention:</span></p>
                    <p><span className="output">1. Product circle has 2 proposals pending &gt;5 days</span></p>
                    <p><span className="output">2. Q3 budget variance flagged in Finance</span></p>
                    <p><span className="output">3. New role request in Engineering lacks domain clarity</span></p>
                    <p>&nbsp;</p>
                    <p><span className="prompt">you:</span> <span className="cmd">Route the proposals to the right reviewers.</span></p>
                    <p><span className="output">Done. Routed to 4 domain experts based on expertise match.</span></p>
                  </div>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── Capabilities: Three Pillars ── */}
      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header">
              <span className="section-label">Capabilities</span>
              <h2>The Complete Platform</h2>
              <p>Everything you need to see, govern, and afford your AI workforce in a single operating surface.</p>
            </div>
          </ScrollReveal>

          <div className="cards-grid">
            <ScrollReveal delay={0}>
              <div className="card">
                <span className="section-label">Visibility</span>
                <h3>Workforce Graph</h3>
                <p>Every AI agent and embedded AI feature, what they&rsquo;re doing, what data they touch, who owns them.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={100}>
              <div className="card">
                <span className="section-label">Control</span>
                <h3>Governance &amp; Guardrails</h3>
                <p>Policies, approvals, human-on-the-loop for high-impact actions.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={200}>
              <div className="card">
                <span className="section-label">Economics</span>
                <h3>Spend &amp; ROI</h3>
                <p>AI costs attributed to work, budgets, forecasts, surfaced next to output.</p>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* ── Social Proof ── */}
      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="pull-quote" style={{ borderColor: "var(--text)", margin: "0 auto" }}>
              <span className="section-label">In Production</span>
              <h2 style={{ fontSize: "2rem", marginBottom: "16px" }}>Already Powering Real Transformation</h2>
              <p style={{ fontFamily: "var(--font-sans)", fontSize: "1.1rem", fontStyle: "normal", color: "var(--text-secondary)" }}>
                Our first enterprise client uses Corgtex&rsquo;s governed AI workforce to acquire and transform 1,000 companies across the United States into self-management and employee ownership.
              </p>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── How It Works (Compact) ── */}
      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">Implementation</span>
              <h2>Live in Weeks, Yours to Own</h2>
              <p style={{ marginBottom: "24px" }}>A simple path from fragmented tooling to an intelligent, governed AI workforce.</p>
              <a href="/how-we-work" className="btn btn-secondary">See How We Work &rarr;</a>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── Deployment Options ── */}
      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">Deployment</span>
              <h2>Your Infrastructure, Your Rules</h2>
            </div>
          </ScrollReveal>
          <div className="cards-grid">
            <ScrollReveal delay={0}>
              <div className="card">
                <div className="card-number">I</div>
                <h3>Cloud</h3>
                <p>We run it. Zero infrastructure overhead and automatic updates.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={100}>
              <div className="card">
                <div className="card-number">II</div>
                <h3>On-Premise</h3>
                <p>A self-contained appliance. Your data never leaves your building.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={200}>
              <div className="card">
                <div className="card-number">III</div>
                <h3>Hybrid</h3>
                <p>Sensitive data on your hardware, everything else in the cloud.</p>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* ── Founder Mention ── */}
      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="founder-banner">
              <div className="founder-banner-content">
                <span className="section-label">Built by Experts</span>
                <h2>From the Author of &ldquo;How to DAO&rdquo;</h2>
                <p>Corgtex was built by Jan &ldquo;Puncar&rdquo; Brezina &mdash; author of &ldquo;How to DAO&rdquo; (Penguin Random House) and a decade-long practitioner of decentralized governance and self-management.</p>
                <div className="btn-group" style={{ marginTop: "24px" }}>
                  <a href="/about" className="btn btn-secondary">Read the Full Story</a>
                </div>
              </div>
              <div className="founder-banner-visual">
                <Image
                  src="/images/how-to-dao-cover.png"
                  alt="How to DAO Book Cover"
                  width={858}
                  height={1024}
                  sizes="(max-width: 1024px) min(100vw - 96px, 240px), 240px"
                  className="book-cover-large"
                />
                <div className="founder-avatar-wrapper">
                  <Image
                    src="/images/puncar-pfp.jpg"
                    alt="Jan Puncar Brezina"
                    width={48}
                    height={48}
                    className="founder-avatar"
                  />
                  <span className="founder-name">Jan &ldquo;Puncar&rdquo; Brezina</span>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="section section-dark cta-banner">
        <div className="container">
          <ScrollReveal>
            <h2>See Your AI Workforce In Action</h2>
            <p>Walk through the Workforce Graph, governance workflows, cost attribution, and your morning briefing &mdash; in 5 minutes.</p>
            <div className="btn-group">
              <DemoGateForm />
              <a href="https://calendar.app.google/jJd5yeSuDStVZm896" className="btn btn-primary" target="_blank" rel="noopener noreferrer">
                Schedule a Briefing
              </a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
