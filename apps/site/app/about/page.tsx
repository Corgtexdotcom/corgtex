import type { Metadata } from "next";
import Image from "next/image";
import { ScrollReveal } from "../../components/ScrollReveal";

export const metadata: Metadata = {
  title: "About",
  description: "Corgtex was created by Jan 'Puncar' Brezina, Penguin Random House author and decade-long practitioner of decentralized governance, Holacracy, Sociocracy, and governed AI workforce management and self-management technology.",
};

export default function AboutPage() {
  return (
    <>
      <section className="section" style={{ paddingBottom: "48px" }}>
        <div className="container" style={{ maxWidth: "800px", textAlign: "center" }}>
          <ScrollReveal><span className="section-label">About Corgtex</span></ScrollReveal>
          <ScrollReveal delay={100}><h1 style={{ marginTop: "24px" }}>The Story Behind Corgtex</h1></ScrollReveal>
          <ScrollReveal delay={200}><p style={{ fontFamily: "var(--font-serif)", fontSize: "1.2rem", fontStyle: "italic", maxWidth: "620px", margin: "24px auto 0" }}>We believe the next generation of great organizations will not be managed. They will be self-managing, AI-augmented, governed by their own rules, and designed for human autonomy.</p></ScrollReveal>
        </div>
      </section>

      <div className="rule-strong" style={{ maxWidth: "var(--max-width)", margin: "0 auto" }} />

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered" style={{ maxWidth: "800px" }}>
              <h2>Our Mission</h2>
              <p style={{ fontSize: "1.1rem", lineHeight: "1.8" }}>Traditional management can&rsquo;t keep up with how fast organizations move. Corgtex gives every person the information and governance tools they need &mdash; governed, visible, and always current.</p>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header">
              <span className="section-label">Leadership</span>
              <h2>Founder</h2>
            </div>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <div className="founder-section">
              <div className="founder-photo">
                <Image
                  src="/images/puncar-pfp.jpg"
                  alt="Jan Puncar Brezina"
                  fill
                  sizes="(max-width: 1024px) 280px, 280px"
                  className="founder-img"
                />
              </div>
              <div className="founder-bio">
                <h3>Jan &ldquo;Puncar&rdquo; Brezina</h3>
                <p className="founder-role">Founder and CEO</p>
                <p>Jan has spent over a decade at the intersection of organizational design, decentralized governance, and artificial intelligence. His work spans from designing governance frameworks for decentralized autonomous organizations to building enterprise-grade AI systems that understand and facilitate organizational decision-making.</p>
                <p>Before founding Corgtex, Jan led organizational transformation initiatives across multiple industries, observing firsthand how traditional management structures fail to scale with the complexity and speed of modern operations.</p>
                <p>His approach combines deep expertise in self-management methodologies &mdash; Holacracy, Sociocracy, Teal organizations &mdash; with a pragmatic engineering mindset, resulting in Corgtex: a platform that does not just theorize about organizational transformation but delivers it through production-grade AI infrastructure.</p>
                <div className="book-callout">
                  <div className="book-cover-container">
                    <Image
                      src="/images/how-to-dao-cover.png"
                      alt="How to DAO Book Cover"
                      width={858}
                      height={1024}
                      sizes="72px"
                      className="book-cover-thumb"
                    />
                  </div>
                  <div>
                    <p><strong>Author of &ldquo;How to DAO&rdquo;</strong> (Penguin Random House) &mdash; a comprehensive guide to decentralized organizational governance that has become a foundational text for leaders navigating the transition from hierarchical to distributed models.</p>
                  </div>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">Philosophy</span>
              <h2>Why AI Plus Self-Management</h2>
            </div>
          </ScrollReveal>
          <div className="cards-grid">
            <ScrollReveal delay={0}>
              <div className="card">
                <div className="card-number">I</div>
                <h3>AI as Facilitator, Not Authority</h3>
                <p>Corgtex does not make decisions for your team. It facilitates better decisions by routing proposals to domain experts, surfacing relevant knowledge, and ensuring governance processes are followed. The humans remain in charge.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={100}>
              <div className="card">
                <div className="card-number">II</div>
                <h3>Autonomy Over Surveillance</h3>
                <p>Corgtex replaces surveillance metrics with impact footprints &mdash; qualitative, multi-dimensional records of contribution that fuel autonomy and mastery rather than compliance and control.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={200}>
              <div className="card">
                <div className="card-number">III</div>
                <h3>Continuous Evolution</h3>
                <p>Organizations are living systems. Corgtex evolves with yours &mdash; continuously learning from decisions, adapting its understanding, and refining its organizational model as your team grows.</p>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      <section className="section section-dark cta-banner">
        <div className="container"><ScrollReveal>
          <h2>Build the Future of Work With Us</h2>
          <p>See how a governed AI workforce runs in practice.</p>
          <div className="btn-group">
            <a href="https://app.corgtex.com/demo" className="btn btn-primary" target="_blank" rel="noopener noreferrer">Access the Demo</a>
            <a href="https://calendar.app.google/jJd5yeSuDStVZm896" className="btn btn-secondary" target="_blank" rel="noopener noreferrer">Schedule a Briefing</a>
          </div>
        </ScrollReveal></div>
      </section>
    </>
  );
}
