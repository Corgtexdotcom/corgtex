import type { Metadata } from "next";
import Image from "next/image";
import { DemoGateForm } from "../../components/DemoGateForm";
import { ScrollReveal } from "../../components/ScrollReveal";
import { localeFromParams, hrefFor, type LocaleParams } from "../../lib/locale";
import { buildMetadata } from "../../lib/metadata";
import { getSiteConfig } from "../../lib/site";

const homeCopy = {
  en: {
    metadata: {
      title: "Corgtex",
      description: "Run your AI workforce like an accountable team. See every agent, govern it with your rules, and know what it costs.",
    },
    heroTitle: "Run your AI workforce like an accountable team.",
    heroSubtitle: "See what every agent is doing. Govern it with your rules. Know what it costs. Live in weeks, yours to own.",
    aiReadinessCta: "Run AI Readiness X-Ray",
    briefing: "Schedule a Briefing",
    dailyLabel: "The Daily Surface",
    dailyTitle: "Every morning, one page. Everything your AI workforce produced overnight.",
    dailyBody: "The newspaper is how you experience the workforce. Briefings, anomalies, costs, governance decisions - all three pillars, surfaced for your role.",
    changesLabel: "What Changes",
    changesTitle: "When You See Your Entire AI Workforce",
    outcomes: [
      {
        number: "I",
        title: "Know",
        scenario: "Your new SVP asks \"Why did we exit the APAC market?\"",
        body: "They type the question into Corgtex. It pulls the board decision from 2024, the risk analysis, and the three dissenting opinions - with citations.",
        result: "No more institutional knowledge walking out the door. Every answer grounded in your actual records.",
      },
      {
        number: "II",
        title: "Decide",
        scenario: "Product circle submits a $2M budget proposal.",
        body: "Corgtex routes it to 4 domain experts based on expertise. They review, raise one objection, it gets integrated. Resolved in 48 hours.",
        result: "Decisions that used to take weeks of meetings close in days. Full audit trail provided automatically.",
      },
      {
        number: "III",
        title: "See",
        scenario: "Two departments are unknowingly duplicating a vendor evaluation.",
        body: "Corgtex flags the overlap in your morning briefing directly to the domain leads. You connect the teams in one message and save the effort.",
        result: "Cross-organization visibility without surveillance. Tensions surfaced before they cost money.",
      },
    ],
    commandLabel: "Command Your Workforce",
    commandTitle: "Direct Your Organization",
    commandBody: "Don't just monitor. Act. Query agent performance, trigger governance workflows, or redirect AI resources from a single interface.",
    terminal: {
      q1: "What needs my attention this week?",
      a1: "Corgtex: Three items requiring attention:",
      i1: "1. Product circle has 2 proposals pending >5 days",
      i2: "2. Q3 budget variance flagged in Finance",
      i3: "3. New role request in Engineering lacks domain clarity",
      q2: "Route the proposals to the right reviewers.",
      a2: "Done. Routed to 4 domain experts based on expertise match.",
    },
    capabilitiesLabel: "Capabilities",
    capabilitiesTitle: "The Complete Platform",
    capabilitiesBody: "Everything you need to see, govern, and afford your AI workforce in a single operating surface.",
    capabilities: [
      { label: "Visibility", title: "Workforce Graph", body: "Every AI agent and embedded AI feature, what they're doing, what data they touch, who owns them." },
      { label: "Control", title: "Governance & Guardrails", body: "Policies, approvals, human-on-the-loop for high-impact actions." },
      { label: "Economics", title: "Spend & ROI", body: "AI costs attributed to work, budgets, forecasts, surfaced next to output." },
    ],
    productionLabel: "In Production",
    productionTitle: "Already Powering Real Transformation",
    productionBody: "Our first enterprise client uses Corgtex's governed AI workforce to acquire and transform 1,000 companies across the United States into self-management and employee ownership.",
    implementationLabel: "Implementation",
    implementationTitle: "Live in Weeks, Yours to Own",
    implementationBody: "A simple path from fragmented tooling to an intelligent, governed AI workforce.",
    implementationCta: "See How We Work ->",
    deploymentLabel: "Deployment",
    deploymentTitle: "Your Infrastructure, Your Rules",
    deployments: [
      { number: "I", title: "Cloud", body: "We run it. Zero infrastructure overhead and automatic updates." },
      { number: "II", title: "On-Premise", body: "A self-contained appliance. Your data never leaves your building." },
      { number: "III", title: "Hybrid", body: "Sensitive data on your hardware, everything else in the cloud." },
    ],
    founderLabel: "Built by Experts",
    founderTitle: "From the Author of \"How to DAO\"",
    founderBody: "Corgtex was built by Jan \"Puncar\" Brezina - author of \"How to DAO\" (Penguin Random House) and a decade-long practitioner of decentralized governance and self-management.",
    founderCta: "Read the Full Story",
    finalTitle: "See Your AI Workforce In Action",
    finalBody: "Walk through the Workforce Graph, governance workflows, cost attribution, and your morning briefing - in 5 minutes.",
  },
  es: {
    metadata: {
      title: "Corgtex",
      description: "Dirige tu fuerza laboral de IA como un equipo responsable. Ve cada agente, gobierna con tus reglas y conoce el costo.",
    },
    heroTitle: "Dirige tu fuerza laboral de IA como un equipo responsable.",
    heroSubtitle: "Ve qué hace cada agente. Gobierna con tus reglas. Conoce el costo. En vivo en semanas, bajo tu control.",
    aiReadinessCta: "X-Ray de preparación IA",
    briefing: "Agendar una sesión",
    dailyLabel: "La superficie diaria",
    dailyTitle: "Cada mañana, una sola página. Todo lo que tu fuerza laboral de IA produjo durante la noche.",
    dailyBody: "El periódico es la forma de experimentar la fuerza laboral. Briefings, anomalías, costos y decisiones de gobernanza: los tres pilares, filtrados para tu rol.",
    changesLabel: "Qué cambia",
    changesTitle: "Cuando ves toda tu fuerza laboral de IA",
    outcomes: [
      {
        number: "I",
        title: "Saber",
        scenario: "Tu nuevo SVP pregunta: \"¿Por qué salimos del mercado APAC?\"",
        body: "Escribe la pregunta en Corgtex. La plataforma encuentra la decisión del consejo de 2024, el análisis de riesgos y las tres opiniones disidentes, con citas.",
        result: "El conocimiento institucional deja de irse por la puerta. Cada respuesta se basa en tus registros reales.",
      },
      {
        number: "II",
        title: "Decidir",
        scenario: "El círculo de producto presenta una propuesta presupuestaria de $2M.",
        body: "Corgtex la envía a 4 expertos de dominio según su experiencia. Revisan, plantean una objeción, se integra y queda resuelta en 48 horas.",
        result: "Decisiones que antes tomaban semanas de reuniones se cierran en días, con auditoría completa incluida.",
      },
      {
        number: "III",
        title: "Ver",
        scenario: "Dos departamentos están duplicando sin saberlo una evaluación de proveedores.",
        body: "Corgtex marca el solapamiento en tu briefing matutino directamente para los líderes de dominio. Conectas a los equipos en un mensaje y ahorras el esfuerzo.",
        result: "Visibilidad transversal sin vigilancia. Las tensiones aparecen antes de costar dinero.",
      },
    ],
    commandLabel: "Dirige tu fuerza laboral",
    commandTitle: "Coordina tu organización",
    commandBody: "No solo monitorees. Actúa. Consulta el rendimiento de agentes, activa flujos de gobernanza o redirige recursos de IA desde una sola interfaz.",
    terminal: {
      q1: "¿Qué requiere mi atención esta semana?",
      a1: "Corgtex: Tres elementos requieren atención:",
      i1: "1. El círculo de producto tiene 2 propuestas pendientes por más de 5 días",
      i2: "2. Variación de presupuesto Q3 marcada en Finanzas",
      i3: "3. Nueva solicitud de rol en Ingeniería sin claridad de dominio",
      q2: "Envía las propuestas a los revisores correctos.",
      a2: "Listo. Enviadas a 4 expertos de dominio según coincidencia de experiencia.",
    },
    capabilitiesLabel: "Capacidades",
    capabilitiesTitle: "La plataforma completa",
    capabilitiesBody: "Todo lo que necesitas para ver, gobernar y costear tu fuerza laboral de IA en una sola superficie operativa.",
    capabilities: [
      { label: "Visibilidad", title: "Workforce Graph", body: "Cada agente de IA y función embebida, qué hace, qué datos toca y quién lo posee." },
      { label: "Control", title: "Gobernanza y guardrails", body: "Políticas, aprobaciones y supervisión humana para acciones de alto impacto." },
      { label: "Economía", title: "Gasto y ROI", body: "Costos de IA atribuidos al trabajo, presupuestos y proyecciones junto a los resultados." },
    ],
    productionLabel: "En producción",
    productionTitle: "Ya impulsa transformación real",
    productionBody: "Nuestro primer cliente enterprise usa la fuerza laboral de IA gobernada de Corgtex para adquirir y transformar 1,000 empresas en Estados Unidos hacia autogestión y propiedad de empleados.",
    implementationLabel: "Implementación",
    implementationTitle: "En vivo en semanas, bajo tu control",
    implementationBody: "Un camino simple desde herramientas fragmentadas hacia una fuerza laboral de IA inteligente y gobernada.",
    implementationCta: "Ver cómo trabajamos ->",
    deploymentLabel: "Despliegue",
    deploymentTitle: "Tu infraestructura, tus reglas",
    deployments: [
      { number: "I", title: "Cloud", body: "Nosotros lo operamos. Cero carga de infraestructura y actualizaciones automáticas." },
      { number: "II", title: "On-Premise", body: "Un appliance autónomo. Tus datos nunca salen de tu edificio." },
      { number: "III", title: "Híbrido", body: "Datos sensibles en tu hardware, el resto en la nube." },
    ],
    founderLabel: "Creado por expertos",
    founderTitle: "Del autor de \"How to DAO\"",
    founderBody: "Corgtex fue creado por Jan \"Puncar\" Brezina, autor de \"How to DAO\" (Penguin Random House) y practicante por más de una década de gobernanza descentralizada y autogestión.",
    founderCta: "Leer la historia completa",
    finalTitle: "Ve tu fuerza laboral de IA en acción",
    finalBody: "Explora el Workforce Graph, los flujos de gobernanza, la atribución de costos y tu briefing matutino en 5 minutos.",
  },
} as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await localeFromParams(params);
  return buildMetadata({
    ...homeCopy[locale].metadata,
    locale,
    path: "/",
  });
}

export default async function HomePage({ params }: LocaleParams) {
  const locale = await localeFromParams(params);
  const copy = homeCopy[locale];
  const { bookDemoUrl } = getSiteConfig();

  return (
    <>
      <section className="masthead">
        <div className="container">
          <div className="masthead-content">
            <ScrollReveal delay={100}>
              <h1>{copy.heroTitle}</h1>
            </ScrollReveal>
            <ScrollReveal delay={200}>
              <p className="masthead-subtitle">{copy.heroSubtitle}</p>
            </ScrollReveal>
            <ScrollReveal delay={300}>
              <div className="btn-group">
                <DemoGateForm />
                <a href={hrefFor(locale, "/ai-readiness")} className="btn btn-secondary">
                  {copy.aiReadinessCta}
                </a>
                <a href={bookDemoUrl} className="btn btn-primary" target="_blank" rel="noopener noreferrer">
                  {copy.briefing}
                </a>
              </div>
            </ScrollReveal>
          </div>

          <ScrollReveal delay={400}>
            <div className="masthead-video">
              <video src="/videos/landing_page.mp4" autoPlay loop muted playsInline>
                {locale === "es" ? (
                  <track kind="subtitles" src="/videos/landing_page.es.vtt" srcLang="es" label="Español" default />
                ) : (
                  <track kind="subtitles" src="/videos/landing_page.vtt" srcLang="en" label="English" default />
                )}
              </video>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container" style={{ textAlign: "center" }}>
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">{copy.dailyLabel}</span>
              <h2>{copy.dailyTitle}</h2>
              <p>{copy.dailyBody}</p>
            </div>
          </ScrollReveal>

          <ScrollReveal delay={200}>
            <Image
              src="/images/personalization-editions.png"
              alt="CEO Edition vs VP Engineering Edition vs New Hire Edition"
              width={1600}
              height={800}
              style={{ width: "100%", height: "auto", maxWidth: "1000px", margin: "0 auto", mixBlendMode: "multiply" }}
            />
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled section-dark">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label" style={{ color: "rgba(250,249,246,0.6)", borderColor: "rgba(250,249,246,0.3)" }}>{copy.changesLabel}</span>
              <h2>{copy.changesTitle}</h2>
            </div>
          </ScrollReveal>

          <div className="cards-grid" style={{ background: "rgba(250,249,246,0.1)", border: "1px solid rgba(250,249,246,0.15)" }}>
            {copy.outcomes.map((outcome, index) => (
              <ScrollReveal key={outcome.title} delay={index * 100}>
                <div className="card" style={{ background: "rgba(250,249,246,0.04)" }}>
                  <div className="card-number" style={{ color: "rgba(250,249,246,0.2)" }}>{outcome.number}</div>
                  <h3>{outcome.title}</h3>
                  <p style={{ fontStyle: "italic", marginBottom: "16px", color: "rgba(250,249,246,0.8)" }}>{outcome.scenario}</p>
                  <p>{outcome.body}</p>
                  <div className="rule" style={{ background: "transparent", borderBottom: "1px solid rgba(250,249,246,0.1)", height: "1px", margin: "24px 0" }} />
                  <p style={{ fontWeight: 600, color: "var(--text-inverse)" }}>{outcome.result}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="demo-panel">
              <div className="demo-panel-text">
                <span className="section-label">{copy.commandLabel}</span>
                <h2>{copy.commandTitle}</h2>
                <p>{copy.commandBody}</p>
                <div className="btn-group">
                  <DemoGateForm />
                </div>
              </div>
              <div className="demo-panel-visual">
                <div className="demo-terminal">
                  <div className="demo-terminal-bar">
                    <div className="demo-terminal-dot" />
                    <div className="demo-terminal-dot" />
                    <div className="demo-terminal-dot" />
                  </div>
                  <div className="demo-terminal-body">
                    <p><span className="prompt">you:</span> <span className="cmd">{copy.terminal.q1}</span></p>
                    <p><span className="output">{copy.terminal.a1}</span></p>
                    <p><span className="output">{copy.terminal.i1}</span></p>
                    <p><span className="output">{copy.terminal.i2}</span></p>
                    <p><span className="output">{copy.terminal.i3}</span></p>
                    <p>&nbsp;</p>
                    <p><span className="prompt">you:</span> <span className="cmd">{copy.terminal.q2}</span></p>
                    <p><span className="output">{copy.terminal.a2}</span></p>
                  </div>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header">
              <span className="section-label">{copy.capabilitiesLabel}</span>
              <h2>{copy.capabilitiesTitle}</h2>
              <p>{copy.capabilitiesBody}</p>
            </div>
          </ScrollReveal>

          <div className="cards-grid">
            {copy.capabilities.map((capability, index) => (
              <ScrollReveal key={capability.title} delay={index * 100}>
                <div className="card">
                  <span className="section-label">{capability.label}</span>
                  <h3>{capability.title}</h3>
                  <p>{capability.body}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="pull-quote" style={{ borderColor: "var(--text)", margin: "0 auto" }}>
              <span className="section-label">{copy.productionLabel}</span>
              <h2 style={{ fontSize: "2rem", marginBottom: "16px" }}>{copy.productionTitle}</h2>
              <p style={{ fontFamily: "var(--font-sans)", fontSize: "1.1rem", fontStyle: "normal", color: "var(--text-secondary)" }}>
                {copy.productionBody}
              </p>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">{copy.implementationLabel}</span>
              <h2>{copy.implementationTitle}</h2>
              <p style={{ marginBottom: "24px" }}>{copy.implementationBody}</p>
              <a href={hrefFor(locale, "/how-we-work")} className="btn btn-secondary">{copy.implementationCta}</a>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="section-header centered">
              <span className="section-label">{copy.deploymentLabel}</span>
              <h2>{copy.deploymentTitle}</h2>
            </div>
          </ScrollReveal>
          <div className="cards-grid">
            {copy.deployments.map((deployment, index) => (
              <ScrollReveal key={deployment.title} delay={index * 100}>
                <div className="card">
                  <div className="card-number">{deployment.number}</div>
                  <h3>{deployment.title}</h3>
                  <p>{deployment.body}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-ruled">
        <div className="container">
          <ScrollReveal>
            <div className="founder-banner">
              <div className="founder-banner-content">
                <span className="section-label">{copy.founderLabel}</span>
                <h2>{copy.founderTitle}</h2>
                <p>{copy.founderBody}</p>
                <div className="btn-group" style={{ marginTop: "24px" }}>
                  <a href={hrefFor(locale, "/about")} className="btn btn-secondary">{copy.founderCta}</a>
                </div>
              </div>
              <div className="founder-banner-visual">
                <Image
                  src="/images/how-to-dao-cover.png"
                  alt="How to DAO Book Cover"
                  width={858}
                  height={1024}
                  sizes="(max-width: 1024px) min(100vw - 96px, 240px), 240px"
                  className="book-cover-large"
                />
                <div className="founder-avatar-wrapper">
                  <Image
                    src="/images/puncar-pfp.jpg"
                    alt="Jan Puncar Brezina"
                    width={48}
                    height={48}
                    className="founder-avatar"
                  />
                  <span className="founder-name">Jan &ldquo;Puncar&rdquo; Brezina</span>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="section section-dark cta-banner">
        <div className="container">
          <ScrollReveal>
            <h2>{copy.finalTitle}</h2>
            <p>{copy.finalBody}</p>
            <div className="btn-group">
              <DemoGateForm />
              <a href={bookDemoUrl} className="btn btn-primary" target="_blank" rel="noopener noreferrer">
                {copy.briefing}
              </a>
            </div>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
