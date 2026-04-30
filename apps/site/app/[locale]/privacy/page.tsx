import type { Metadata } from "next";
import { localeFromParams, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";

const copy = {
  en: {
    metadata: { title: "Privacy Policy", description: "Corgtex privacy policy - how we collect, use, and protect your data." },
    title: "Privacy Policy",
    updated: "Last updated: April 2026",
    sections: [
      ["1. Introduction", "Corgtex (\"we,\" \"our,\" or \"us\") is committed to protecting the privacy and security of your personal information. This Privacy Policy describes how we collect, use, disclose, and safeguard your information when you use our AI-native workspace operating system."],
      ["2. Information We Collect", ["Account Information: Email address, name, organization name, and authentication credentials.", "Organizational Data: Documents, governance structures, policies, proposals, and other content you upload.", "Usage Data: Information about how you interact with the platform.", "AI Interaction Data: Conversations with AI agents and intelligent briefings."]],
      ["3. How We Use Your Information", ["Provide, maintain, and improve the platform", "Process organizational governance workflows", "Train and improve AI agent performance within your workspace", "Generate knowledge embeddings for semantic search", "Communicate about service updates and security notices", "Ensure platform security"]],
      ["4. AI Processing", "Corgtex uses AI to process organizational data for knowledge retrieval, governance facilitation, and decision support. AI processing occurs within the context of your workspace."],
      ["5. Data Sharing", "We do not sell your personal information. We may share information with your consent, with service providers under confidentiality agreements, to comply with legal obligations, or to protect our rights."],
      ["6. Data Security", "We implement industry-standard security measures including encryption at rest and in transit, role-based access controls, regular security audits, and secure session management."],
      ["7. Data Retention", "We retain your information for as long as your account is active. Upon termination, we will delete or anonymize your data within 90 days unless retention is required by law."],
      ["8. Your Rights", ["Access and receive a copy of your personal data", "Correct inaccurate or incomplete data", "Request deletion of your personal data", "Object to or restrict processing", "Data portability"]],
      ["9. Contact Us", "For privacy inquiries, contact privacy@corgtex.com."],
      ["10. Third-Party AI Integrations", ["When you connect Corgtex to third-party AI tools through MCP connectors, custom apps, or similar integrations, certain workspace data may be shared with the AI provider you choose, such as OpenAI, Anthropic, Cursor, or another MCP client, to execute your requests.", "Data access is scoped strictly via OAuth to specific workspaces and permissions you grant.", "Connector tokens are scoped to the selected workspace, user, permissions, and audience.", "You can revoke integration access at any time from your workspace settings or from the connected AI tool."]],
    ],
  },
  es: {
    metadata: { title: "Política de privacidad", description: "Política de privacidad de Corgtex: cómo recopilamos, usamos y protegemos tus datos." },
    title: "Política de privacidad",
    updated: "Última actualización: abril de 2026",
    sections: [
      ["1. Introducción", "Corgtex (\"nosotros\") se compromete a proteger la privacidad y seguridad de tu información personal. Esta Política de privacidad describe cómo recopilamos, usamos, divulgamos y protegemos tu información cuando utilizas nuestro sistema operativo de workspace nativo de IA."],
      ["2. Información que recopilamos", ["Información de cuenta: correo electrónico, nombre, organización y credenciales de autenticación.", "Datos organizacionales: documentos, estructuras de gobernanza, políticas, propuestas y otros contenidos que subes.", "Datos de uso: información sobre cómo interactúas con la plataforma.", "Datos de interacción con IA: conversaciones con agentes de IA y briefings inteligentes."]],
      ["3. Cómo usamos tu información", ["Proveer, mantener y mejorar la plataforma", "Procesar flujos de gobernanza organizacional", "Entrenar y mejorar el rendimiento de agentes de IA dentro de tu workspace", "Generar embeddings de conocimiento para búsqueda semántica", "Comunicar actualizaciones de servicio y avisos de seguridad", "Asegurar la plataforma"]],
      ["4. Procesamiento de IA", "Corgtex usa IA para procesar datos organizacionales con fines de recuperación de conocimiento, facilitación de gobernanza y soporte de decisiones. El procesamiento ocurre dentro del contexto de tu workspace."],
      ["5. Compartición de datos", "No vendemos tu información personal. Podemos compartir información con tu consentimiento, con proveedores bajo acuerdos de confidencialidad, para cumplir obligaciones legales o para proteger nuestros derechos."],
      ["6. Seguridad de datos", "Implementamos medidas estándar de la industria, incluidas cifrado en reposo y tránsito, controles de acceso por rol, auditorías de seguridad y gestión segura de sesiones."],
      ["7. Retención de datos", "Retenemos tu información mientras tu cuenta esté activa. Al terminar la relación, eliminaremos o anonimizaremos tus datos dentro de 90 días salvo que la ley exija conservarlos."],
      ["8. Tus derechos", ["Acceder y recibir una copia de tus datos personales", "Corregir datos inexactos o incompletos", "Solicitar eliminación de tus datos personales", "Oponerte o restringir el procesamiento", "Portabilidad de datos"]],
      ["9. Contacto", "Para consultas de privacidad, contacta a privacy@corgtex.com."],
      ["10. Integraciones de IA de terceros", ["Cuando conectas Corgtex a herramientas de IA de terceros mediante conectores MCP, apps personalizadas o integraciones similares, ciertos datos del workspace pueden compartirse con el proveedor que elijas, como OpenAI, Anthropic, Cursor u otro cliente MCP, para ejecutar tus solicitudes.", "El acceso a datos se limita estrictamente mediante OAuth a workspaces y permisos específicos que otorgas.", "Los tokens de conector se limitan al workspace, usuario, permisos y audiencia seleccionados.", "Puedes revocar el acceso de integración en cualquier momento desde la configuración del workspace o desde la herramienta de IA conectada."]],
    ],
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path: "/privacy" });
}

export default async function PrivacyPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];

  return (
    <div className="legal-page">
      <h1>{t.title}</h1>
      <p className="last-updated">{t.updated}</p>
      {t.sections.map(([title, body]) => (
        <section key={title}>
          <h2>{title}</h2>
          {Array.isArray(body) ? (
            <ul>{body.map((item) => <li key={item}>{item}</li>)}</ul>
          ) : typeof body === "string" && (title.includes("Contact") || title.includes("Contacto")) ? (
            <p>{body.replace("privacy@corgtex.com.", "")}<a href="mailto:privacy@corgtex.com" style={{ color: "var(--accent-red)" }}>privacy@corgtex.com</a>.</p>
          ) : (
            <p>{body}</p>
          )}
        </section>
      ))}
    </div>
  );
}
