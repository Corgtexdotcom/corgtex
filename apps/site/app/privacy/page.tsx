import type { Metadata } from "next";
export const metadata: Metadata = { title: "Privacy Policy", description: "Corgtex privacy policy — how we collect, use, and protect your data." };

export default function PrivacyPage() {
  return (
    <div className="legal-page">
      <h1>Privacy Policy</h1>
      <p className="last-updated">Last updated: April 2026</p>
      <h2>1. Introduction</h2><p>Corgtex (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) is committed to protecting the privacy and security of your personal information. This Privacy Policy describes how we collect, use, disclose, and safeguard your information when you use our AI-native workspace operating system.</p>
      <h2>2. Information We Collect</h2><ul><li><strong>Account Information:</strong> Email address, name, organization name, and authentication credentials.</li><li><strong>Organizational Data:</strong> Documents, governance structures, policies, proposals, and other content you upload.</li><li><strong>Usage Data:</strong> Information about how you interact with the platform.</li><li><strong>AI Interaction Data:</strong> Conversations with AI agents and intelligent briefings.</li></ul>
      <h2>3. How We Use Your Information</h2><ul><li>Provide, maintain, and improve the platform</li><li>Process organizational governance workflows</li><li>Train and improve AI agent performance within your workspace</li><li>Generate knowledge embeddings for semantic search</li><li>Communicate about service updates and security notices</li><li>Ensure platform security</li></ul>
      <h2>4. AI Processing</h2><p>Corgtex uses AI to process organizational data for knowledge retrieval, governance facilitation, and decision support. AI processing occurs within the context of your workspace.</p><ul><li>Data is processed only within authorized workspace scope</li><li>AI models are not trained on your proprietary data without consent</li><li>AI outputs include source citations for verification</li><li>All agent actions are fully auditable</li></ul>
      <h2>5. Data Sharing</h2><p>We do not sell your personal information. We may share information with your consent, with service providers under confidentiality agreements, to comply with legal obligations, or to protect our rights.</p>
      <h2>6. Data Security</h2><p>We implement industry-standard security measures including encryption at rest and in transit, role-based access controls, regular security audits, and secure session management.</p>
      <h2>7. Data Retention</h2><p>We retain your information for as long as your account is active. Upon termination, we will delete or anonymize your data within 90 days unless retention is required by law.</p>
      <h2>8. Your Rights</h2><ul><li>Access and receive a copy of your personal data</li><li>Correct inaccurate or incomplete data</li><li>Request deletion of your personal data</li><li>Object to or restrict processing</li><li>Data portability</li></ul>
      <h2>9. Contact Us</h2><p>For privacy inquiries, contact <a href="mailto:privacy@corgtex.com" style={{ color: "var(--accent-red)" }}>privacy@corgtex.com</a>.</p>
      <h2>10. Third-Party AI Integrations</h2><p>When you use third-party AI integrations, such as ChatGPT Custom GPT Actions, certain data from your organization may be shared with the AI provider (e.g., OpenAI) to execute your requests. Corgtex acts as the data processor handling the integration. The AI provider processes the data in accordance with their own <a href="https://openai.com/privacy-policy" target="_blank" style={{ color: "var(--accent-red)" }}>Privacy Policy</a> and usage terms.</p><ul><li>Data access is scoped strictly via OAuth to specific workspaces and permissions you grant.</li><li>You can revoke integration access at any time from your workspace settings.</li></ul>
    </div>
  );
}
