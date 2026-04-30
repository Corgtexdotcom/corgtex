import type { Metadata } from "next";
import { localeFromParams, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";

const copy = {
  en: {
    metadata: { title: "Terms of Service", description: "Corgtex terms of service - governing your use of the platform." },
    title: "Terms of Service",
    updated: "Last updated: April 2026",
    sections: [
      ["1. Acceptance of Terms", "By accessing or using the Corgtex platform, you agree to be bound by these Terms. If you are using the platform on behalf of an organization, you represent that you have the authority to bind that organization."],
      ["2. Description of Service", "Corgtex provides an AI-native workspace operating system for organizational governance, knowledge management, and decision facilitation, including intelligent briefings, organizational memory, and autonomous governance facilitation."],
      ["3. Account Responsibilities", ["Maintaining the confidentiality of your account credentials", "All activities that occur under your account", "Ensuring compliance with applicable laws", "Accuracy and appropriateness of uploaded content"]],
      ["4. Intellectual Property", ["Your Content: You retain all rights to your organizational data. By uploading content, you grant Corgtex a limited license to process it solely for providing services.", "Our Platform: The platform is owned by Corgtex and protected by intellectual property laws."]],
      ["5. AI-Generated Content", "AI-generated content, including organizational briefings and recommendations, is provided for informational purposes. Corgtex does not guarantee its accuracy. Users are responsible for reviewing AI outputs before acting on them."],
      ["6. Enterprise SLA", "Enterprise customers are subject to a separate Service Level Agreement specifying uptime commitments and support response times."],
      ["7. Acceptable Use", ["Do not store or process content that violates applicable laws", "Do not attempt to reverse engineer the platform", "Do not interfere with platform infrastructure", "Do not share credentials with unauthorized users"]],
      ["8. Limitation of Liability", "To the maximum extent permitted by law, Corgtex shall not be liable for indirect, incidental, special, consequential, or punitive damages arising from use of the platform."],
      ["9. Termination", "Either party may terminate upon 30 days' written notice. Corgtex will provide a reasonable period for data export."],
      ["10. Contact", "Questions about these Terms: legal@corgtex.com."],
    ],
  },
  es: {
    metadata: { title: "Términos de servicio", description: "Términos de servicio de Corgtex que gobiernan el uso de la plataforma." },
    title: "Términos de servicio",
    updated: "Última actualización: abril de 2026",
    sections: [
      ["1. Aceptación de términos", "Al acceder o usar la plataforma Corgtex, aceptas quedar sujeto a estos Términos. Si usas la plataforma en nombre de una organización, declaras que tienes autoridad para vincularla."],
      ["2. Descripción del servicio", "Corgtex ofrece un sistema operativo de workspace nativo de IA para gobernanza organizacional, gestión de conocimiento y facilitación de decisiones, incluidos briefings inteligentes, memoria organizacional y facilitación autónoma de gobernanza."],
      ["3. Responsabilidades de cuenta", ["Mantener la confidencialidad de tus credenciales", "Todas las actividades realizadas bajo tu cuenta", "Asegurar cumplimiento con leyes aplicables", "Exactitud y pertinencia del contenido subido"]],
      ["4. Propiedad intelectual", ["Tu contenido: Conservas todos los derechos sobre tus datos organizacionales. Al subir contenido, otorgas a Corgtex una licencia limitada para procesarlo solo con el fin de prestar los servicios.", "Nuestra plataforma: La plataforma pertenece a Corgtex y está protegida por leyes de propiedad intelectual."]],
      ["5. Contenido generado por IA", "El contenido generado por IA, incluidos briefings y recomendaciones, se entrega con fines informativos. Corgtex no garantiza su exactitud. Los usuarios son responsables de revisar salidas de IA antes de actuar."],
      ["6. SLA enterprise", "Clientes enterprise están sujetos a un Acuerdo de Nivel de Servicio separado que especifica compromisos de disponibilidad y tiempos de respuesta de soporte."],
      ["7. Uso aceptable", ["No almacenar ni procesar contenido que viole leyes aplicables", "No intentar ingeniería inversa de la plataforma", "No interferir con la infraestructura de la plataforma", "No compartir credenciales con usuarios no autorizados"]],
      ["8. Limitación de responsabilidad", "En la máxima medida permitida por la ley, Corgtex no será responsable por daños indirectos, incidentales, especiales, consecuentes o punitivos derivados del uso de la plataforma."],
      ["9. Terminación", "Cualquiera de las partes puede terminar con aviso escrito de 30 días. Corgtex dará un periodo razonable para exportar datos."],
      ["10. Contacto", "Preguntas sobre estos Términos: legal@corgtex.com."],
    ],
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path: "/terms" });
}

export default async function TermsPage({ params }: LocaleParams) {
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
            <p>{body.replace("legal@corgtex.com.", "")}<a href="mailto:legal@corgtex.com" style={{ color: "var(--accent-red)" }}>legal@corgtex.com</a>.</p>
          ) : (
            <p>{body}</p>
          )}
        </section>
      ))}
    </div>
  );
}
