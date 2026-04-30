import type { Metadata } from "next";
import { localeFromParams, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";
import { QualifyForm } from "./QualifyForm";

const metadataCopy = {
  en: {
    title: "Set up your Corgtex trial",
    description: "Tell us about your organization so Corgtex can tailor your trial workspace.",
  },
  es: {
    title: "Configura tu prueba de Corgtex",
    description: "Cuéntanos sobre tu organización para que Corgtex adapte tu workspace de prueba.",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...metadataCopy[locale], locale, path: "/qualify" });
}

export default function QualifyPage() {
  return <QualifyForm />;
}
