import type { Metadata } from "next";
import { DemoGateForm } from "../../../components/DemoGateForm";
import { ScrollReveal } from "../../../components/ScrollReveal";
import { localeFromParams, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";
import { getSiteConfig } from "../../../lib/site";

const copy = {
  en: {
    metadata: {
      title: "Live Demo",
      description: "Access the Corgtex live demo instantly with a work email. No sales call required.",
    },
    label: "Live Demo",
    title: "Open the guided Corgtex demo.",
    body: "Enter your work email for instant access to the read-only Johnson & Johnson demo. You can take the guided tour first, then keep exploring.",
    note: "Instant access. No sales call required.",
    briefingPrompt: "Prefer a founder-led walkthrough?",
    briefing: "Schedule a Briefing",
  },
  es: {
    metadata: {
      title: "Demo en vivo",
      description: "Accede al demo en vivo de Corgtex al instante con tu correo de trabajo. No se requiere llamada comercial.",
    },
    label: "Demo en vivo",
    title: "Abre la demo guiada de Corgtex.",
    body: "Ingresa tu correo de trabajo para acceder al instante a la demo de solo lectura de Johnson & Johnson. Puedes hacer primero el recorrido guiado y luego explorar libremente.",
    note: "Acceso instantáneo. No se requiere llamada comercial.",
    briefingPrompt: "¿Prefieres una explicación guiada por el fundador?",
    briefing: "Agendar una sesión",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path: "/demo" });
}

export default async function DemoPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];
  const { bookDemoUrl } = getSiteConfig();

  return (
    <section className="section demo-access-section">
      <div className="container demo-access-shell">
        <ScrollReveal>
          <span className="section-label">{t.label}</span>
          <h1>{t.title}</h1>
          <p>{t.body}</p>
        </ScrollReveal>
        <ScrollReveal delay={100}>
          <div className="demo-access-form">
            <DemoGateForm />
            <p className="demo-access-note">{t.note}</p>
          </div>
        </ScrollReveal>
        <ScrollReveal delay={200}>
          <div className="demo-access-secondary">
            <span>{t.briefingPrompt}</span>
            <a href={bookDemoUrl} target="_blank" rel="noopener noreferrer">
              {t.briefing}
            </a>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
