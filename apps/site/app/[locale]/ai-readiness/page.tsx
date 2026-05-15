import type { Metadata } from "next";
import Image from "next/image";
import { ScrollReveal } from "../../../components/ScrollReveal";
import { localeFromParams, type LocaleParams } from "../../../lib/locale";
import { buildMetadata } from "../../../lib/metadata";
import { getSiteConfig } from "../../../lib/site";
import { AiReadinessPromptPanel } from "./AiReadinessPromptPanel";

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
- What data, governance, integration, privacy, or trust gaps limit AI value?
- What should we do in the next 30 days to improve AI usefulness safely?

About Corgtex, for later recommendations:
Corgtex is a self-management operating system and organizational intelligence layer for AI-enabled companies. It is not meant to replace every specialist tool. It helps preserve and use company operating context: roles, circles or teams, tensions, proposals, decisions, actions, meetings, documents, communication summaries, tool ownership, AI usage, and technology-spend visibility.

Corgtex may help when the main AI readiness gap is missing organizational context, scattered decision memory, unclear ownership, poor meeting-to-action flow, unmanaged tool/AI sprawl, or the need to give Claude, Codex, ChatGPT, Cursor, and other AI workbenches a trusted company context layer. Do not force Corgtex into the answer. If Corgtex is not the right first step, say so.

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

const pageCopy = {
  en: {
    metadata: {
      title: "AI Readiness X-Ray",
      description: "Copy a practical AI readiness prompt for the AI tool that already has the most access to your company resources and work.",
    },
    label: "AI Readiness",
    title: "Run an AI readiness X-Ray inside your own AI coworker.",
    body: "Use the prompt in the AI tool that is already most connected to your company resources and work. It maps how AI is used today, where context is missing, and what to improve next.",
    openLabel: "Open The Prompt",
    closeLabel: "Hide The Prompt",
    copyLabel: "Copy Prompt",
    copiedLabel: "Copied",
    promptTitle: "Customer-Run Prompt",
    guidance: "Paste this into Claude, Codex, ChatGPT, Cursor, or whichever approved AI tool has the best access to your company resources. Corgtex does not receive the result. The report is for your team to decide what to do next.",
    consultationPrompt: "Prefer to do this with help?",
    consultation: "Schedule A Consultation",
    stepsLabel: "How To Use It",
    stepsTitle: "Keep the analysis inside your environment.",
    steps: [
      {
        title: "Choose the right AI tool",
        body: "Use the assistant or coding agent that can inspect the most relevant approved documents, folders, notes, exports, or workflow examples.",
      },
      {
        title: "Share only approved context",
        body: "Do not paste secrets, credentials, private personal data, or sources your company has not approved for AI analysis.",
      },
      {
        title: "Use the report internally",
        body: "You decide what to do with the result. Share it with Corgtex only if you want help turning it into a plan.",
      },
    ],
    outputLabel: "What You Get",
    outputTitle: "A practical AI readiness report, not a sales form.",
    outputs: [
      "Current AI usage map",
      "System integration and context gaps",
      "Workforce readiness and training needs",
      "High-value AI workflow opportunities",
      "Privacy, governance, and read-only boundaries",
      "Where Corgtex may help, only if it clearly fits",
      "A feasible 30-day plan using existing staff",
    ],
    fitLabel: "Where Corgtex Fits",
    fitTitle: "Corgtex comes after the diagnosis.",
    fitBody: "If the X-Ray shows that AI is weak because context is scattered across meetings, decisions, tools, and documents, Corgtex can become the organizational memory and governance layer. If the first step is simpler, the prompt tells the analyst to say that clearly.",
  },
  es: {
    metadata: {
      title: "X-Ray de preparación para IA",
      description: "Copia un prompt práctico de preparación para IA para la herramienta que ya tenga más acceso al trabajo y recursos de tu empresa.",
    },
    label: "Preparación para IA",
    title: "Ejecuta un X-Ray de preparación para IA dentro de tu propio compañero de IA.",
    body: "Usa el prompt en la herramienta de IA que ya esté más conectada a los recursos y trabajo de tu empresa. Mapea cómo se usa la IA hoy, dónde falta contexto y qué conviene mejorar después.",
    openLabel: "Abrir el prompt",
    closeLabel: "Ocultar el prompt",
    copyLabel: "Copiar prompt",
    copiedLabel: "Copiado",
    promptTitle: "Prompt para el cliente",
    guidance: "Pega esto en Claude, Codex, ChatGPT, Cursor o la herramienta de IA aprobada que tenga mejor acceso a los recursos de tu empresa. Corgtex no recibe el resultado. El informe es para que tu equipo decida qué hacer después.",
    consultationPrompt: "¿Prefieres hacerlo con ayuda?",
    consultation: "Agendar una consulta",
    stepsLabel: "Cómo usarlo",
    stepsTitle: "Mantén el análisis dentro de tu entorno.",
    steps: [
      {
        title: "Elige la herramienta correcta",
        body: "Usa el asistente o agente de código que pueda inspeccionar los documentos, carpetas, notas, exports o ejemplos de trabajo aprobados más relevantes.",
      },
      {
        title: "Comparte solo contexto aprobado",
        body: "No pegues secretos, credenciales, datos personales privados ni fuentes que tu empresa no haya aprobado para análisis con IA.",
      },
      {
        title: "Usa el informe internamente",
        body: "Tú decides qué hacer con el resultado. Compártelo con Corgtex solo si quieres ayuda para convertirlo en un plan.",
      },
    ],
    outputLabel: "Qué obtienes",
    outputTitle: "Un informe práctico de preparación para IA, no un formulario comercial.",
    outputs: [
      "Mapa de uso actual de IA",
      "Brechas de integración y contexto",
      "Preparación del equipo y necesidades de formación",
      "Oportunidades de workflow con IA de alto valor",
      "Privacidad, gobernanza y límites de solo lectura",
      "Dónde Corgtex puede ayudar, solo si encaja claramente",
      "Un plan viable de 30 días con el equipo existente",
    ],
    fitLabel: "Dónde encaja Corgtex",
    fitTitle: "Corgtex viene después del diagnóstico.",
    fitBody: "Si el X-Ray muestra que la IA es débil porque el contexto está disperso entre reuniones, decisiones, herramientas y documentos, Corgtex puede convertirse en la capa de memoria organizativa y gobernanza. Si el primer paso debe ser más simple, el prompt indica al analista que lo diga con claridad.",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({ ...pageCopy[locale].metadata, locale, path: "/ai-readiness" });
}

export default async function AiReadinessPage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const copy = pageCopy[locale];
  const { bookDemoUrl } = getSiteConfig();

  return (
    <>
      <section className="section ai-readiness-hero">
        <div className="container ai-readiness-hero-grid">
          <ScrollReveal>
            <div className="ai-readiness-hero-copy">
              <span className="section-label">{copy.label}</span>
              <h1>{copy.title}</h1>
              <p>{copy.body}</p>
              <AiReadinessPromptPanel
                closeLabel={copy.closeLabel}
                copiedLabel={copy.copiedLabel}
                copyLabel={copy.copyLabel}
                guidance={copy.guidance}
                openLabel={copy.openLabel}
                prompt={aiReadinessPrompt}
                promptTitle={copy.promptTitle}
              />
              <div className="ai-readiness-consultation">
                <span>{copy.consultationPrompt}</span>
                <a href={bookDemoUrl} target="_blank" rel="noopener noreferrer">
                  {copy.consultation}
                </a>
              </div>
            </div>
          </ScrollReveal>
          <ScrollReveal delay={120}>
            <div className="ai-readiness-visual">
              <Image
                src="/images/screenshot-brain.png"
                alt=""
                width={1600}
                height={1024}
                priority
              />
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">{copy.stepsLabel}</span>
              <h2>{copy.stepsTitle}</h2>
            </div>
          </ScrollReveal>
          <div className="cards-grid">
            {copy.steps.map((step, index) => (
              <ScrollReveal key={step.title} delay={index * 100}>
                <div className="card">
                  <div className="card-number">{index + 1}</div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <div className="ai-readiness-output-grid">
            <ScrollReveal>
              <div className="section-header">
                <span className="section-label">{copy.outputLabel}</span>
                <h2>{copy.outputTitle}</h2>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={120}>
              <ul className="ai-readiness-output-list">
                {copy.outputs.map((item) => (
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
            <span className="section-label">{copy.fitLabel}</span>
            <h2>{copy.fitTitle}</h2>
            <p>{copy.fitBody}</p>
            <div className="btn-group">
              <a href={bookDemoUrl} className="btn btn-primary" target="_blank" rel="noopener noreferrer">
                {copy.consultation}
              </a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
