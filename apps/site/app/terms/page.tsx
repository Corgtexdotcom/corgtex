import type { Metadata } from "next";
export const metadata: Metadata = { title: "Terms of Service", description: "Corgtex terms of service — governing your use of the platform." };

export default function TermsPage() {
  return (
    <div className="legal-page">
      <h1>Terms of Service</h1>
      <p className="last-updated">Last updated: April 2026</p>
      <h2>1. Acceptance of Terms</h2><p>By accessing or using the Corgtex platform, you agree to be bound by these Terms. If you are using the platform on behalf of an organization, you represent that you have the authority to bind that organization.</p>
      <h2>2. Description of Service</h2><p>Corgtex provides an AI-native workspace operating system for organizational governance, knowledge management, and decision facilitation, including intelligent briefings, organizational memory, and autonomous governance facilitation.</p>
      <h2>3. Account Responsibilities</h2><ul><li>Maintaining the confidentiality of your account credentials</li><li>All activities that occur under your account</li><li>Ensuring compliance with applicable laws</li><li>Accuracy and appropriateness of uploaded content</li></ul>
      <h2>4. Intellectual Property</h2><p><strong>Your Content:</strong> You retain all rights to your organizational data. By uploading content, you grant Corgtex a limited license to process it solely for providing services.</p><p><strong>Our Platform:</strong> The platform is owned by Corgtex and protected by intellectual property laws.</p>
      <h2>5. AI-Generated Content</h2><p>AI-generated content, including organizational briefings and recommendations, is provided for informational purposes. Corgtex does not guarantee its accuracy. Users are responsible for reviewing AI outputs before acting on them.</p>
      <h2>6. Enterprise SLA</h2><p>Enterprise customers are subject to a separate Service Level Agreement specifying uptime commitments and support response times.</p>
      <h2>7. Acceptable Use</h2><ul><li>Do not store or process content that violates applicable laws</li><li>Do not attempt to reverse engineer the platform</li><li>Do not interfere with platform infrastructure</li><li>Do not share credentials with unauthorized users</li></ul>
      <h2>8. Limitation of Liability</h2><p>To the maximum extent permitted by law, Corgtex shall not be liable for indirect, incidental, special, consequential, or punitive damages arising from use of the platform.</p>
      <h2>9. Termination</h2><p>Either party may terminate upon 30 days&apos; written notice. Corgtex will provide a reasonable period for data export.</p>
      <h2>10. Contact</h2><p>Questions about these Terms: <a href="mailto:legal@corgtex.com" style={{ color: "var(--accent-red)" }}>legal@corgtex.com</a>.</p>
    </div>
  );
}
