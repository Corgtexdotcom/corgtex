import type { Metadata } from "next";
import { localeFromParams, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";
import { absoluteSiteUrl, demoGatePathForLocale } from "../../../lib/site";

const copy = {
  en: {
    metadata: {
      title: "Machine-Readable Facts",
      description: "Machine-readable facts, capabilities, and status of the Corgtex governed AI workforce platform.",
    },
    title: "Corgtex - Machine-Readable Facts",
    sections: [
      ["What Corgtex Is", ["Governed AI workforce platform.", "Makes every AI agent visible, governed, and cost-attributed.", "Primary surface: a personalized daily newspaper for each role."]],
      ["Who It's For", ["COO / CEO of SaaS-heavy companies.", "Organizations with 5+ AI tools/agents in production.", "Employee-owned, self-managed, or mission-driven teams that need AI adoption to preserve trust and accountability.", "Enterprises transitioning to self-management or decentralized governance."]],
      ["How It's Deployed", ["Cloud SaaS (we run it under your governance rules).", "On-premise appliance (your data and operating context stay under your control).", "Hybrid (sensitive data local, governed processing in cloud).", "Typical implementation: 8 weeks from scoping to live."]],
      ["Pricing", ["Custom enterprise pricing, not per-seat.", "Based on organizational scale and deployment model."]],
      ["Core Capabilities", ["Workforce Graph: every AI agent, what it does, what data it touches, who owns it.", "Governance & Guardrails: policies, approvals, and human review.", "Shared operating memory for decisions, roles, meetings, handoffs, and accountability.", "Spend & ROI: AI costs attributed to real work, budgets, forecasts.", "Personalized daily briefings by role."]],
      ["Integrations", ["ChatGPT, Claude, Gemini via Model Context Protocol (MCP).", "Slack, Google Workspace.", "Custom connectors via Airbyte OSS."]],
      ["Company", ["Founded by Jan \"Puncar\" Brezina.", "Author of \"How to DAO\" (Penguin Random House).", "One enterprise client in production (acquiring and transforming 1,000 companies)."]],
      ["Current Status", ["In production with first enterprise client.", "Active development.", "No named customer logos available yet."]],
    ],
    linksTitle: "Links",
    contact: "Contact",
    links: {
      homepage: "Homepage",
      howWeWork: "How We Work",
      pricing: "Pricing",
      about: "About",
      faq: "FAQ",
      demo: "Demo",
    },
  },
  es: {
    metadata: {
      title: "Datos legibles por máquina",
      description: "Datos, capacidades y estado de la plataforma Corgtex de fuerza laboral de IA gobernada.",
    },
    title: "Corgtex - Datos legibles por máquina",
    sections: [
      ["Qué es Corgtex", ["Plataforma de fuerza laboral de IA gobernada.", "Hace visible, gobernado y atribuible en costos a cada agente de IA.", "Superficie principal: un periódico diario personalizado para cada rol."]],
      ["Para quién es", ["COO / CEO de compañías intensivas en SaaS.", "Organizaciones con 5+ herramientas o agentes de IA en producción.", "Equipos propiedad de empleados, autogestionados u orientados por misión que necesitan adoptar IA preservando confianza y responsabilidad.", "Empresas en transición hacia autogestión o gobernanza descentralizada."]],
      ["Cómo se despliega", ["Cloud SaaS (lo operamos bajo tus reglas de gobernanza).", "Appliance on-premise (tus datos y contexto operativo permanecen bajo tu control).", "Híbrido (datos sensibles locales, procesamiento gobernado en la nube).", "Implementación típica: 8 semanas desde alcance hasta producción."]],
      ["Precios", ["Precios enterprise personalizados, no por usuario.", "Basados en escala organizacional y modelo de despliegue."]],
      ["Capacidades centrales", ["Workforce Graph: cada agente de IA, qué hace, qué datos toca y quién lo posee.", "Gobernanza y guardrails: políticas, aprobaciones y revisión humana.", "Memoria operativa compartida para decisiones, roles, reuniones, traspasos y responsabilidad.", "Gasto y ROI: costos de IA atribuidos al trabajo real, presupuestos y proyecciones.", "Briefings diarios personalizados por rol."]],
      ["Integraciones", ["ChatGPT, Claude y Gemini vía Model Context Protocol (MCP).", "Slack, Google Workspace.", "Conectores personalizados vía Airbyte OSS."]],
      ["Empresa", ["Fundada por Jan \"Puncar\" Brezina.", "Autor de \"How to DAO\" (Penguin Random House).", "Un cliente enterprise en producción (adquiriendo y transformando 1,000 compañías)."]],
      ["Estado actual", ["En producción con el primer cliente enterprise.", "Desarrollo activo.", "Aún no hay logos de clientes nombrados disponibles."]],
    ],
    linksTitle: "Enlaces",
    contact: "Contacto",
    links: {
      homepage: "Inicio",
      howWeWork: "Cómo trabajamos",
      pricing: "Precios",
      about: "Acerca de",
      faq: "FAQ",
      demo: "Demo",
    },
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path: "/facts" });
}

export default async function FactsPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];
  const sitePrefix = locale === "es" ? "/es" : "";
  const links = [
    [t.links.homepage, absoluteSiteUrl(sitePrefix || "/")],
    [t.links.howWeWork, absoluteSiteUrl(`${sitePrefix}/how-we-work`)],
    [t.links.pricing, absoluteSiteUrl(`${sitePrefix}/pricing`)],
    [t.links.about, absoluteSiteUrl(`${sitePrefix}/about`)],
    [t.links.faq, absoluteSiteUrl(`${sitePrefix}/faq`)],
    [t.links.demo, absoluteSiteUrl(demoGatePathForLocale(locale))],
  ];

  return (
    <div className="legal-page">
      <h1>{t.title}</h1>

      {t.sections.map(([title, items]) => (
        <section key={title}>
          <h2>{title}</h2>
          <ul>
            {items.map((item) => <li key={item}>{item}</li>)}
            {title === "Pricing" || title === "Precios" ? (
              <li>{t.contact}: <a href="mailto:hello@corgtex.com" style={{ textDecoration: "underline" }}>hello@corgtex.com</a></li>
            ) : null}
          </ul>
        </section>
      ))}

      <h2>{t.linksTitle}</h2>
      <ul>
        {links.map(([label, href]) => (
          <li key={label}>{label}: <a href={href} style={{ textDecoration: "underline" }}>{href}</a></li>
        ))}
      </ul>
    </div>
  );
}
