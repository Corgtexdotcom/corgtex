import type { Metadata } from "next";
import Image from "next/image";
import { AiReadinessPromptPanel } from "../../../components/AiReadinessPromptPanel";
import { ScrollReveal } from "../../../components/ScrollReveal";
import { localeFromParams, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";
import { demoGatePathForLocale, getSiteConfig } from "../../../lib/site";

const aiReadinessPrompt = `You are acting as our internal AI readiness analyst.

Purpose:
We want to understand how our company currently uses AI and agents, whether those tools are connected to our real company systems, where AI is being underused, where outputs are weak because context is missing, and which workflows could become more efficient, targeted, transparent, and safe.

This is not a generic AI strategy memo and not a vendor-selection exercise. Start from our actual evidence, tools, workflows, documents, meetings, and constraints. Only after the AI readiness diagnosis, assess whether Corgtex or another organizational context layer could help.

Quick context to capture first:
- Company size: approximate number of employees and locations.
- Primary industry and business model: what the company does and how work gets done.
- Regulatory or sensitivity level: non-regulated, moderately sensitive, regulated, or unknown.

If any of this context is missing, mark it as unknown and continue. Do not wait for perfect information.

Primary questions:
- Who is using AI today, and for what work?
- Which AI tools are used: Claude, Codex, ChatGPT, Cursor, Gemini, Copilot, Perplexity, custom agents, or others?
- Are AI tools connected to trusted company systems, or are people pasting disconnected snippets into chat?
- What company context do AI tools need but currently lack?
- Which workflows are strong candidates for AI assistance or agentic automation?
- Which workflows should remain human-led, manual, or read-only for now?
- What data, governance, integration, privacy, employee-trust, or control gaps limit AI value?
- What should we do in the next 30 days to improve AI usefulness safely?

About Corgtex, for later recommendations:
Corgtex is a self-management operating system and organizational intelligence layer for AI-enabled companies. It is not meant to replace every specialist tool. It helps preserve and use company operating context: roles, circles or teams, tensions, proposals, decisions, actions, meetings, documents, communication summaries, tool ownership, AI usage, technology-spend visibility, and human review boundaries.

Corgtex may help when the main AI readiness gap is missing organizational context, scattered decision memory, unclear ownership, weak employee trust, poor meeting-to-action flow, unmanaged tool/AI sprawl, or the need to give Claude, Codex, ChatGPT, Cursor, and other AI workbenches a trusted company context layer. It is especially relevant for employee-owned, self-managed, and mission-driven organizations that need AI adoption to preserve accountability and human control. Do not force Corgtex into the answer. If Corgtex is not the right first step, say so.

Safety rules:
- Analyze only the information we explicitly provide or approve in this chat/workspace.
- If you have file access, inspect only the folders/files we explicitly point you to.
- Do not edit, delete, upload, email, install, deploy, buy, or connect to external systems.
- Do not ask for or reveal passwords, API keys, private credentials, tokens, personal secrets, or regulated personal data.
- If sensitive material appears, flag the risk and recommend a safe read-only, redacted, or manual-summary alternative.
- Separate confirmed facts from assumptions.
- Tag each major recommendation as either evidence-based or hypothesis.
- Do not invent tools, costs, owners, integrations, maturity levels, or adoption numbers when evidence is missing.
- Prefer official integrations, exports, manual summaries, or approved read-only access. Do not recommend scraping personal chat groups or unmanaged private accounts.

Evidence to review if available:

1. AI usage and workforce readiness:
- AI tools, prompts, outputs, automations, agent workflows, coding-agent usage, subscriptions, policies, training materials, adoption notes, employee concerns, and examples of work people want AI to help with.

2. Systems and data:
- tool list, license list, renewal data, admin exports, access matrices, knowledge-base exports, CRM/ERP/finance/HR/BI/spreadsheet summaries, and known sources of truth.

3. Workflows and operating model:
- company overview, org chart, roles, teams, accountability docs, strategic priorities, transformation projects, meeting notes, transcripts, decision logs, action lists, proposal records, governance notes, and communication-channel descriptions.

4. Constraints and risk:
- privacy constraints, regulatory constraints, customer-data constraints, employee-trust concerns, admin-access limits, security requirements, and systems that should not be connected.

If little evidence is provided:
First produce a short "Missing Evidence Request" with the 10 most important items we should provide. Then continue with a clearly marked preliminary report based only on available information.

Analysis process:
1. Build an evidence inventory: what you reviewed, what it probably represents, and what is missing.
2. Map current AI usage: tools, users, workflows, maturity, data pasted into AI, system access, quality of outputs, and visible risks.
3. Map AI integration with company systems: where AI can access trusted data, where it cannot, and where read-only exports or manual summaries would be safer.
4. Map context quality: what company knowledge AI needs, where that knowledge lives, what is outdated, what is duplicated, and what sources of truth are unclear.
5. Map workflow opportunities: meetings, actions, decision support, customer work, operations, coding, research, reporting, training, onboarding, governance, and admin work.
6. Map workforce readiness: AI skills, training needs, adoption patterns, attitudes toward AI, likely champions, likely skeptics, and where change management is needed.
7. Map risk and governance: secrets, personal data, regulated data, customer data, hallucination risk, approval requirements, ownership, employee trust, and auditability.
8. Identify quick wins: small changes that improve AI usefulness within 2 weeks without broad system changes.
9. Identify foundational improvements: data cleanup, tool catalog, source-of-truth decisions, access policies, meeting capture, decision memory, or AI usage norms.
10. Only then assess where Corgtex could help as an organizational context, memory, governance, tool-visibility, or AI-workbench layer.
11. Create a first 30-day AI readiness plan that is feasible with existing staff and does not depend on buying or implementing major new tools or vendors.

Output format:

# Company AI Readiness X-Ray

## 1. Executive Summary
One page in plain business language. State how AI is currently used, the main blockers to better AI use, the highest-value opportunities, the biggest risks, and the recommended next step.

## 2. Evidence Reviewed
List what was reviewed. Mark each item as confirmed, partial, or missing. Do not expose secret values.

## 3. Company Context Snapshot
Summarize company size, industry/business model, regulatory or sensitivity level, and any important operating context. Mark missing items as unknown.

## 4. Current AI Usage Map
Use this table:

| AI Tool / Agent | Users | Work It Supports | Company Data Used | System Access | Output Quality | Maturity | Risk | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

Maturity should be one of:
- experimental,
- individual productivity,
- team workflow,
- system-integrated,
- governed operating capability.

## 5. AI Integration With Company Systems
Explain which systems AI can use today, which systems are disconnected, where people manually copy/paste context, and where official read-only access or exports would improve quality.

## 6. Context And Knowledge Gaps
Describe where AI lacks trusted company context: documents, meetings, decisions, roles, policies, customer/project context, ERP/CRM data, tool ownership, or historical memory.

## 7. Workforce Readiness And Change Management
Describe skills, training needs, AI adoption patterns, attitudes toward AI, likely champions, likely skeptics, and where change management is needed.

## 8. High-Value AI Opportunities
Use this table:

| Opportunity | Evidence Level | Evidence | Current Pain | AI Improvement | Required Context / System Access | Effort | Risk | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

Priority must be P1, P2, or P3.
Evidence Level must be evidence-based or hypothesis.

## 9. Workflows That Should Stay Human-Led Or Read-Only
List workflows where AI may help with summaries, drafting, checks, or recommendations, but should not autonomously act yet.

## 10. Data Source, Privacy, And Governance Readiness
Classify sources as:
- safe to use now,
- safe with read-only access,
- safe only as a redacted/manual summary,
- needs owner approval,
- should not be connected now.

## 11. Tool Stack And Cost Visibility
Identify duplicate AI tools, unmanaged subscriptions, unclear owners, hidden costs, and tools that may become more valuable if connected to better context.

## 12. Where Corgtex Could Help
Do this section only after the AI readiness analysis above. Use this table:

| AI Readiness Gap | Evidence Level | Why Current AI Falls Short | Possible Corgtex Role | Expected Value | Required Evidence / Access | Priority |
| --- | --- | --- | --- | --- | --- | --- |

Possible Corgtex roles may include:
- organizational memory / Brain,
- daily or weekly operating briefing,
- meeting-to-actions and meeting-to-decisions flow,
- tensions, proposals, and decision memory,
- roles/circles/accountabilities context,
- tool catalog and ownership map,
- AI workbench context layer for Claude, Codex, ChatGPT, Cursor, or similar tools,
- basic AI/tool spend visibility.

If another simpler first step is better than Corgtex, state that clearly.

## 13. First 30-Day AI Readiness Plan
Break into:
- Week 1: evidence completion and current AI usage map,
- Week 2: quick wins and safe context improvements,
- Week 3: pilot one or two high-value AI workflows,
- Week 4: review value, risks, governance, and whether Corgtex or another context layer should be implemented.

Include pilot users, sources to use, workflows to test, success metrics, and decisions needed. The plan should be feasible with existing staff and should not depend on buying or implementing major new tools or vendors.

## 14. Open Questions
List the few questions that would most improve confidence in the recommendation.

## 15. Final Self-Check
Before finishing, verify:
- the report starts with AI readiness, not Corgtex readiness,
- every recommendation connects to evidence or is clearly marked as an assumption,
- every major recommendation is tagged evidence-based or hypothesis,
- no secret or sensitive value is exposed,
- Corgtex is positioned only where it plausibly helps,
- the 30-day plan is small enough to start but useful enough to prove value.`;

const copy = {
  en: {
    metadata: {
      title: "How We Work - From X-Ray to Full Ownership",
      description: "Corgtex deploys a governed AI workforce in 8 weeks. Start with a free AI Readiness X-Ray, then go from first briefing to full ownership - no per-seat fees, no lock-in.",
    },
    label: "Engagement Model",
    title: "From First Briefing to Full Ownership",
    intro: "We don't sell software and walk away. We install a governed AI workforce, train your people, and hand you the keys so control stays with the organization.",
    phases: [
      { number: "01", badge: "Free", title: "AI Readiness X-Ray", body: "Before any sales call, run our X-Ray prompt inside your own AI tools. You get a private readiness report - no form, no Corgtex access required." },
      { number: "02", badge: "45 Min", title: "Briefing", body: "We show your data on a working Corgtex. You see your organization through the newspaper for the first time." },
      { number: "03", badge: "2 Weeks", title: "Scoping", body: "We map your tools, governance rules, ownership model, and risks. A blueprint tailored to your AI landscape." },
      { number: "04", badge: "8 Weeks", title: "Implementation", body: "We install, connect, and train your people. Every agent governed, every cost visible, every high-impact workflow reviewable." },
      { number: "05", badge: "Ongoing", title: "Live, and Yours", body: "Integrated from day one. Move it to your infrastructure whenever you want - or never. No per-seat fees. No lock-in. Your rules remain the control surface." },
    ],
    xrayLabel: "Step Zero",
    xrayTitle: "Run an AI Readiness X-Ray inside your own AI coworker.",
    xrayBody: "Use the prompt in the AI tool that is already most connected to your company resources and work. It maps how AI is used today, where context is missing, and where governance, trust, or human control need to improve next. Corgtex never sees the result - it is yours to act on.",
    openLabel: "Open The Prompt",
    closeLabel: "Hide The Prompt",
    copyLabel: "Copy Prompt",
    copiedLabel: "Copied",
    promptTitle: "Customer-Run Prompt",
    guidance: "Paste this into Claude, Codex, ChatGPT, Cursor, or whichever approved AI tool has the best access to your company resources. Corgtex does not receive the result. The report is for your team to decide what to do next.",
    outputLabel: "What You Get",
    outputTitle: "A practical AI readiness report, not a sales form.",
    outputs: [
      "Current AI usage map",
      "System integration and context gaps",
      "Workforce readiness and training needs",
      "High-value AI workflow opportunities",
      "Privacy, governance, employee trust, and read-only boundaries",
      "Where Corgtex may help, only if it clearly fits",
      "A feasible 30-day plan using existing staff",
    ],
    fitNote: "If the X-Ray shows that AI is weak because context is scattered across meetings, decisions, tools, and documents, Corgtex can become the organizational memory and governance layer - especially for employee-owned and self-managed teams where employee trust, ownership, and human review need to stay visible.",
    ctaTitle: "Start With a Briefing",
    ctaBody: "45 minutes. Your data. No slides.",
    briefing: "Schedule a Briefing",
    demo: "Access the Demo",
  },
  es: {
    metadata: {
      title: "Cómo trabajamos - Del X-Ray a la propiedad completa",
      description: "Corgtex despliega una fuerza laboral de IA gobernada en 8 semanas. Empieza con un X-Ray de preparación para IA gratis y avanza del primer briefing a la propiedad completa: sin tarifas por usuario ni lock-in.",
    },
    label: "Modelo de colaboración",
    title: "Del primer briefing a la propiedad completa",
    intro: "No vendemos software para luego desaparecer. Instalamos una fuerza laboral de IA gobernada, entrenamos a tu equipo y te entregamos las llaves para que el control permanezca en la organización.",
    phases: [
      { number: "01", badge: "Gratis", title: "X-Ray de preparación IA", body: "Antes de cualquier llamada comercial, ejecuta nuestro prompt X-Ray dentro de tus propias herramientas de IA. Obtienes un informe privado de preparación, sin formularios y sin dar acceso a Corgtex." },
      { number: "02", badge: "45 min", title: "Briefing", body: "Mostramos tus datos en un Corgtex funcional. Ves tu organización a través del periódico por primera vez." },
      { number: "03", badge: "2 semanas", title: "Alcance", body: "Mapeamos tus herramientas, reglas de gobernanza, modelo de propiedad y riesgos. Un blueprint adaptado a tu paisaje de IA." },
      { number: "04", badge: "8 semanas", title: "Implementación", body: "Instalamos, conectamos y entrenamos a tu gente. Cada agente gobernado, cada costo visible, cada workflow de alto impacto revisable." },
      { number: "05", badge: "Continuo", title: "En vivo y tuyo", body: "Integrado desde el primer día. Muévelo a tu infraestructura cuando quieras, o nunca. Sin tarifas por usuario. Sin lock-in. Tus reglas siguen siendo la superficie de control." },
    ],
    xrayLabel: "Paso cero",
    xrayTitle: "Ejecuta un X-Ray de preparación para IA dentro de tu propio compañero de IA.",
    xrayBody: "Usa el prompt en la herramienta de IA que ya esté más conectada a los recursos y trabajo de tu empresa. Mapea cómo se usa la IA hoy, dónde falta contexto y dónde conviene mejorar gobernanza, confianza o control humano. Corgtex nunca ve el resultado: es tuyo para actuar.",
    openLabel: "Abrir el prompt",
    closeLabel: "Ocultar el prompt",
    copyLabel: "Copiar prompt",
    copiedLabel: "Copiado",
    promptTitle: "Prompt para el cliente",
    guidance: "Pega esto en Claude, Codex, ChatGPT, Cursor o la herramienta de IA aprobada que tenga mejor acceso a los recursos de tu empresa. Corgtex no recibe el resultado. El informe es para que tu equipo decida qué hacer después.",
    outputLabel: "Qué obtienes",
    outputTitle: "Un informe práctico de preparación para IA, no un formulario comercial.",
    outputs: [
      "Mapa de uso actual de IA",
      "Brechas de integración y contexto",
      "Preparación del equipo y necesidades de formación",
      "Oportunidades de workflow con IA de alto valor",
      "Privacidad, gobernanza, confianza del equipo y límites de solo lectura",
      "Dónde Corgtex puede ayudar, solo si encaja claramente",
      "Un plan viable de 30 días con el equipo existente",
    ],
    fitNote: "Si el X-Ray muestra que la IA es débil porque el contexto está disperso entre reuniones, decisiones, herramientas y documentos, Corgtex puede convertirse en la capa de memoria organizativa y gobernanza, especialmente para equipos propiedad de sus empleados y autogestionados donde la confianza, la propiedad y la revisión humana deben permanecer visibles.",
    ctaTitle: "Empieza con un briefing",
    ctaBody: "45 minutos. Tus datos. Sin diapositivas.",
    briefing: "Agendar una sesión",
    demo: "Acceder a la demo",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...copy[locale].metadata, locale, path: "/how-we-work" });
}

export default async function HowWeWorkPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const t = copy[locale];
  const { bookDemoUrl } = getSiteConfig();

  return (
    <>
      <section className="section" style={{ paddingBottom: "48px" }}>
        <div className="container" style={{ maxWidth: "800px", textAlign: "center" }}>
          <ScrollReveal><span className="section-label">{t.label}</span></ScrollReveal>
          <ScrollReveal delay={100}><h1 style={{ marginTop: "24px" }}>{t.title}</h1></ScrollReveal>
          <ScrollReveal delay={200}>
            <p style={{ fontSize: "1.2rem", maxWidth: "620px", margin: "24px auto 0", color: "var(--text-secondary)" }}>{t.intro}</p>
          </ScrollReveal>
        </div>
      </section>

      <div className="rule-strong" style={{ maxWidth: "var(--max-width)", margin: "0 auto" }} />

      <section className="section section-ruled">
        <div className="container">
          <div className="phases-grid">
            {t.phases.map((phase, index) => (
              <ScrollReveal key={phase.number} delay={index * 100}>
                <div className="phase-card">
                  <div className="phase-number">{phase.number}</div>
                  <span className="phase-badge">{phase.badge}</span>
                  <h3>{phase.title}</h3>
                  <p>{phase.body}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-ruled ai-readiness-hero">
        <div className="container ai-readiness-hero-grid">
          <ScrollReveal>
            <div className="ai-readiness-hero-copy">
              <span className="section-label">{t.xrayLabel}</span>
              <h2>{t.xrayTitle}</h2>
              <p>{t.xrayBody}</p>
              <AiReadinessPromptPanel
                closeLabel={t.closeLabel}
                copiedLabel={t.copiedLabel}
                copyLabel={t.copyLabel}
                guidance={t.guidance}
                openLabel={t.openLabel}
                prompt={aiReadinessPrompt}
                promptTitle={t.promptTitle}
              />
            </div>
          </ScrollReveal>
          <ScrollReveal delay={120}>
            <div className="ai-readiness-visual">
              <Image
                src="/images/screenshot-brain.png"
                alt=""
                width={1600}
                height={1024}
              />
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <div className="ai-readiness-output-grid">
            <ScrollReveal>
              <div className="section-header">
                <span className="section-label">{t.outputLabel}</span>
                <h2>{t.outputTitle}</h2>
                <p style={{ marginTop: "16px" }}>{t.fitNote}</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={120}>
              <ul className="ai-readiness-output-list">
                {t.outputs.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </ScrollReveal>
          </div>
        </div>
      </section>

      <section className="section section-dark cta-banner">
        <div className="container">
          <ScrollReveal>
            <h2>{t.ctaTitle}</h2>
            <p>{t.ctaBody}</p>
            <div className="btn-group">
              <a href={bookDemoUrl} className="btn btn-primary" target="_blank" rel="noopener noreferrer">{t.briefing}</a>
              <a href={demoGatePathForLocale(locale)} className="btn btn-secondary">{t.demo}</a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
