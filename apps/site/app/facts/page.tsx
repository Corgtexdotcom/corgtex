import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Machine-Readable Facts",
  description: "Machine-readable facts, capabilities, and status of the Corgtex governed AI workforce platform.",
};

export default function FactsPage() {
  return (
    <div className="legal-page">
      <h1>Corgtex &mdash; Machine-Readable Facts</h1>

      <h2>What Corgtex Is</h2>
      <ul>
        <li>Governed AI workforce platform.</li>
        <li>Makes every AI agent visible, governed, and cost-attributed.</li>
        <li>Primary surface: a personalized daily newspaper for each role.</li>
      </ul>

      <h2>Who It&rsquo;s For</h2>
      <ul>
        <li>COO / CEO of SaaS-heavy companies.</li>
        <li>Organizations with 5+ AI tools/agents in production.</li>
        <li>Enterprises transitioning to self-management or decentralized governance.</li>
      </ul>

      <h2>How It&rsquo;s Deployed</h2>
      <ul>
        <li>Cloud SaaS (we run it).</li>
        <li>On-premise appliance (your data stays in your building).</li>
        <li>Hybrid (sensitive data local, processing in cloud).</li>
        <li>Typical implementation: 8 weeks from scoping to live.</li>
      </ul>

      <h2>Pricing</h2>
      <ul>
        <li>Custom enterprise pricing, not per-seat.</li>
        <li>Based on organizational scale and deployment model.</li>
        <li>Contact: <a href="mailto:hello@corgtex.com" style={{ textDecoration: "underline" }}>hello@corgtex.com</a></li>
      </ul>

      <h2>Core Capabilities</h2>
      <ul>
        <li>Workforce Graph: every AI agent, what it does, what data it touches, who owns it.</li>
        <li>Governance &amp; Guardrails: policies, approvals, human-on-the-loop.</li>
        <li>Spend &amp; ROI: AI costs attributed to real work, budgets, forecasts.</li>
        <li>Personalized daily briefings by role.</li>
      </ul>

      <h2>Integrations</h2>
      <ul>
        <li>ChatGPT, Claude, Gemini via Model Context Protocol (MCP).</li>
        <li>Slack, Google Workspace.</li>
        <li>Custom connectors via Airbyte OSS.</li>
      </ul>

      <h2>Company</h2>
      <ul>
        <li>Founded by Jan &ldquo;Puncar&rdquo; Brezina.</li>
        <li>Author of &ldquo;How to DAO&rdquo; (Penguin Random House).</li>
        <li>One enterprise client in production (acquiring and transforming 1,000 companies).</li>
      </ul>

      <h2>Current Status</h2>
      <ul>
        <li>In production with first enterprise client.</li>
        <li>Active development.</li>
        <li>No named customer logos available yet.</li>
      </ul>

      <h2>Links</h2>
      <ul>
        <li>Homepage: <a href="https://corgtex.com" style={{ textDecoration: "underline" }}>https://corgtex.com</a></li>
        <li>How We Work: <a href="https://corgtex.com/how-we-work" style={{ textDecoration: "underline" }}>https://corgtex.com/how-we-work</a></li>
        <li>Pricing: <a href="https://corgtex.com/pricing" style={{ textDecoration: "underline" }}>https://corgtex.com/pricing</a></li>
        <li>About: <a href="https://corgtex.com/about" style={{ textDecoration: "underline" }}>https://corgtex.com/about</a></li>
        <li>FAQ: <a href="https://corgtex.com/faq" style={{ textDecoration: "underline" }}>https://corgtex.com/faq</a></li>
        <li>Demo: <a href="https://app.corgtex.com/demo" style={{ textDecoration: "underline" }}>https://app.corgtex.com/demo</a></li>
      </ul>
    </div>
  );
}
