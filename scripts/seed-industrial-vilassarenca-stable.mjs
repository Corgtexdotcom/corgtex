import { seedStableClient } from "./lib/client-stable-seed.mjs";

const WORKSPACE_SLUG = process.env.WORKSPACE_SLUG?.trim() || "industrial-vilassarenca";
const WORKSPACE_NAME = process.env.WORKSPACE_NAME?.trim() || "Industrial Vilassarenca";
const DEFAULT_LOCALE = process.env.CLIENT_DEFAULT_LOCALE?.trim() || process.env.NEXT_PUBLIC_DEFAULT_LOCALE?.trim() || "es";
const CLIENT_CURRENCY = process.env.CLIENT_CURRENCY?.trim() || "EUR";

const seedDate = "2026-05-04T09:00:00.000Z";

const companyProfileMd = `# Perfil de Industrial Vilassarenca

Industrial Vilassarenca es un fabricante español especializado en componentes de aluminio de alta precisión mediante fundición inyectada a alta presión en cámara fría.

## Contexto

- Sector: fabricación de automoción.
- Fundación: 1966.
- Sede: España.
- Actividad principal: componentes HPDC de aluminio.
- Clientes objetivo: OEMs de automoción, proveedores Tier 1, fabricantes de movilidad eléctrica y empresas industriales.

## Capacidades principales

- Fundición inyectada a alta presión en cámara fría.
- Diseño y desarrollo avanzado de moldes.
- Producción de alto volumen.
- Geometrías complejas y paredes delgadas.
- Fabricación near-net-shape.
- Optimización de procesos para reducir mecanizados secundarios.

## Propuesta de valor

Industrial Vilassarenca compite por precisión, repetibilidad, colaboración técnica y eficiencia de costes. Su experiencia permite producir piezas complejas para automoción, incluyendo componentes estructurales, motor, transmisión, carcasas, envolventes, gestión térmica y aplicaciones para vehículo eléctrico.`;

const transformationGuideMd = `# Guía inicial de transformación hacia autogestión

Esta instancia está preparada para acompañar la transformación hacia autogestión de Industrial Vilassarenca.

## Principios de trabajo

- Empezar con visibilidad antes de rediseñar estructuras.
- Convertir tensiones reales en decisiones pequeñas y trazables.
- Definir roles por responsabilidades, no por organigramas informales.
- Mantener decisiones, acuerdos y aprendizajes en el Brain.
- Usar reuniones y propuestas como sistema operativo de cambio.

## Ritmo recomendado

1. Mapear los círculos iniciales y las responsabilidades críticas.
2. Capturar tensiones operativas de producción, calidad, ingeniería, mantenimiento y soporte.
3. Procesar propuestas con consentimiento antes de cambiar políticas o roles.
4. Revisar objetivos de transformación cada mes.
5. Mantener auditoría y trazabilidad de decisiones desde el primer día.`;

const glossaryMd = `# Glosario de autogestión

## Tensión

Una tensión es la distancia entre la realidad actual y una mejora posible. No es una queja; es una señal para aprender o ajustar el sistema.

## Círculo

Un círculo es un dominio de trabajo con propósito, responsabilidades y autoridad clara.

## Rol

Un rol agrupa responsabilidades concretas que una persona puede asumir. Una persona puede tener varios roles.

## Propuesta

Una propuesta transforma una tensión en un cambio concreto. Debe ser clara, reversible cuando sea posible y trazable.

## Consentimiento

Consentir no significa estar plenamente de acuerdo. Significa no ver una objeción razonada que haga inseguro probar el cambio.

## Brain

El Brain es la memoria operativa de la organización: decisiones, aprendizajes, documentos, reuniones y conocimiento de trabajo.`;

const manufacturingArticleMd = `# Contexto industrial y oportunidades

Industrial Vilassarenca opera en un mercado de fundición de aluminio exigente y competitivo.

## Tendencias alineadas

- Aligeramiento para eficiencia de combustible y autonomía de vehículos eléctricos.
- Electrificación y crecimiento de componentes EV.
- Uso de aluminio reciclable y presión por sostenibilidad.
- Integración de piezas para reducir ensamblajes.

## Retos iniciales para la transformación

- Presión de márgenes desde OEMs y Tier 1.
- Necesidad de innovación continua en utillaje y procesos.
- Coordinación entre ingeniería, producción, calidad y mantenimiento.
- Transición gradual hacia componentes específicos para vehículo eléctrico.

## Uso recomendado de Corgtex

Capturar tensiones de proceso, documentar decisiones de mejora, mantener roles claros y hacer visibles los aprendizajes entre turnos, equipos y funciones.`;

await seedStableClient({
  envPrefix: "INDUSTRIAL_VILASSARENCA",
  defaultLocale: DEFAULT_LOCALE,
  workspace: {
    slug: WORKSPACE_SLUG,
    name: WORKSPACE_NAME,
    description: "Instancia europea para Industrial Vilassarenca y su transformación hacia autogestión.",
  },
  invite: {
    subject: "Invitación al espacio de Industrial Vilassarenca",
    title: "Acceso a Industrial Vilassarenca",
    greeting: "Hola {name},",
    fallbackName: "equipo",
    body: "Has sido invitado/a a configurar tu cuenta para el espacio de trabajo de Industrial Vilassarenca.",
    button: "Configurar cuenta",
  },
  featureFlags: {
    GOALS: true,
    RELATIONSHIPS: false,
    AGENT_GOVERNANCE: false,
    OS_METRICS: false,
    CYCLES: false,
    MULTILINGUAL: true,
  },
  approvalPolicies: [
    { subjectType: "PROPOSAL", mode: "CONSENT" },
    { subjectType: "SPEND", mode: "SINGLE" },
  ],
  circles: [
    {
      key: "general",
      name: "General",
      purposeMd: "Coordinar el espacio inicial de Industrial Vilassarenca y las decisiones transversales.",
      maturityStage: "GETTING_STARTED",
      sortOrder: 0,
    },
    {
      key: "transformation",
      name: "Transformación",
      purposeMd: "Acompañar la transición hacia autogestión con claridad, ritmo y seguridad.",
      maturityStage: "GETTING_STARTED",
      sortOrder: 10,
    },
    {
      key: "operations",
      name: "Operaciones HPDC",
      purposeMd: "Conectar producción, calidad, ingeniería y mejora de procesos HPDC.",
      maturityStage: "GETTING_STARTED",
      sortOrder: 20,
    },
    {
      key: "governance",
      name: "Gobernanza",
      purposeMd: "Mantener roles, círculos, propuestas y acuerdos de autogestión.",
      maturityStage: "GETTING_STARTED",
      sortOrder: 30,
    },
    {
      key: "finance",
      name: "Finanzas",
      purposeMd: "Mantener visibilidad sobre gastos, presupuestos y decisiones financieras asociadas al piloto.",
      maturityStage: "GETTING_STARTED",
      sortOrder: 40,
    },
  ],
  roles: [
    {
      key: "workspace-owner",
      circleKey: "general",
      name: "Responsable del espacio",
      purposeMd: "Asegura que la instancia está lista para el equipo cliente.",
      accountabilities: ["Validar accesos", "Confirmar alcance de lanzamiento", "Coordinar la entrega inicial"],
      sortOrder: 0,
    },
    {
      key: "transformation-sponsor",
      circleKey: "transformation",
      name: "Patrocinio de transformación",
      purposeMd: "Mantiene foco y contexto ejecutivo para la transformación.",
      accountabilities: ["Priorizar temas de transformación", "Eliminar bloqueos", "Conectar dirección y equipos"],
      sortOrder: 0,
    },
    {
      key: "facilitator",
      circleKey: "transformation",
      name: "Facilitación",
      purposeMd: "Cuida el ritmo de reuniones, tensiones y seguimiento.",
      accountabilities: ["Preparar reuniones", "Facilitar procesamiento de tensiones", "Mantener acciones visibles"],
      sortOrder: 10,
    },
    {
      key: "operations-steward",
      circleKey: "operations",
      name: "Steward de operaciones",
      purposeMd: "Conecta las mejoras de autogestión con la realidad industrial diaria.",
      accountabilities: ["Identificar tensiones operativas", "Coordinar aprendizaje entre funciones", "Mantener foco en seguridad y calidad"],
      sortOrder: 0,
    },
    {
      key: "governance-steward",
      circleKey: "governance",
      name: "Steward de gobernanza",
      purposeMd: "Mantiene propuestas, roles y acuerdos con trazabilidad.",
      accountabilities: ["Revisar propuestas", "Mantener roles y círculos", "Documentar acuerdos"],
      sortOrder: 0,
    },
    {
      key: "finance-steward",
      circleKey: "finance",
      name: "Steward financiero",
      purposeMd: "Mantiene higiene financiera para el piloto.",
      accountabilities: ["Revisar gastos", "Mantener cuentas manuales", "Coordinar aprobaciones financieras"],
      sortOrder: 0,
    },
    {
      key: "knowledge-steward",
      circleKey: "governance",
      name: "Steward de conocimiento",
      purposeMd: "Mantiene el Brain como memoria operativa de la transformación.",
      accountabilities: ["Actualizar artículos clave", "Detectar conocimiento obsoleto", "Conectar reuniones con aprendizajes"],
      sortOrder: 10,
    },
  ],
  roleAssignmentsByMemberRole: {
    ADMIN: ["workspace-owner", "transformation-sponsor", "facilitator", "operations-steward", "governance-steward", "finance-steward", "knowledge-steward"],
    FACILITATOR: ["facilitator", "governance-steward", "knowledge-steward"],
    FINANCE_STEWARD: ["finance-steward"],
    CONTRIBUTOR: [],
  },
  brainArticles: [
    {
      title: "Perfil de Industrial Vilassarenca",
      slug: "perfil-industrial-vilassarenca",
      type: "CUSTOMER",
      authority: "AUTHORITATIVE",
      bodyMd: companyProfileMd,
    },
    {
      title: "Guía inicial de transformación hacia autogestión",
      slug: "guia-transformacion-autogestion",
      type: "RUNBOOK",
      authority: "AUTHORITATIVE",
      bodyMd: transformationGuideMd,
    },
    {
      title: "Glosario de autogestión",
      slug: "glosario-autogestion",
      type: "GLOSSARY",
      authority: "AUTHORITATIVE",
      bodyMd: glossaryMd,
    },
    {
      title: "Contexto industrial y oportunidades",
      slug: "contexto-industrial-oportunidades",
      type: "STRATEGY",
      authority: "REFERENCE",
      bodyMd: manufacturingArticleMd,
    },
  ],
  meeting: {
    title: "Kickoff de transformación - Industrial Vilassarenca",
    source: "industrial-vilassarenca-stable-seed",
    recordedAt: seedDate,
    summaryMd: [
      "## Kickoff de transformación",
      "",
      "- Confirmar el alcance inicial de la instancia europea.",
      "- Validar módulos activos: Home, Goals, Brain, Members, Tensions, Actions, Meetings, Proposals, Circles, Finance, Audit, Settings y Agent Chat.",
      "- Acordar que Cycles, Relationships, Agent Governance y OS Metrics quedan pospuestos.",
      "- Empezar con tensiones reales de operación, roles y visibilidad de decisiones.",
    ].join("\n"),
    transcript: "Reunión inicial sembrada para Industrial Vilassarenca. Sustituir por notas aprobadas después del kickoff real.",
  },
  tension: {
    circleKey: "transformation",
    title: "Clarificar prioridades iniciales de autogestión",
    bodyMd: "Usar esta tensión inicial para decidir qué áreas, equipos y procesos deben entrar primero en el piloto de autogestión.",
    priority: 3,
    urgency: 2,
    importance: 3,
  },
  action: {
    circleKey: "general",
    title: "Confirmar usuarios iniciales y responsables del piloto",
    bodyMd: "Confirmar lista de usuarios, roles de acceso y responsables de transformación antes de enviar invitaciones.",
  },
  proposal: {
    circleKey: "governance",
    title: "Adoptar alcance inicial de la instancia Industrial Vilassarenca",
    summary: "Usar el alcance estable como base para iniciar el piloto de transformación.",
    bodyMd: [
      "## Propuesta",
      "",
      "Activar los módulos estables para el lanzamiento inicial: Home, Goals, Brain, Members, Tensions, Actions, Meetings, Proposals, Circles, Finance, Audit, Settings y Agent Chat.",
      "",
      "Mantener Cycles, Relationships, Agent Governance y OS Metrics desactivados hasta completar una revisión separada de preparación.",
      "",
      "Trabajar en español por defecto y mantener inglés disponible cuando sea útil.",
    ].join("\n"),
  },
  finance: {
    accountName: "Industrial Vilassarenca Operativa",
    currency: CLIENT_CURRENCY,
    balanceCents: 0,
    starterSpend: {
      amountCents: 50000,
      category: "Transformación",
      description: "Revisión inicial de preparación de la instancia",
      vendor: "Corgtex",
      spentAt: seedDate,
      status: "OPEN",
    },
  },
  goals: [
    {
      key: "transformation-launch",
      title: "Lanzar el piloto de autogestión con seguridad y claridad",
      descriptionMd: "Preparar una primera versión operativa del sistema de trabajo para capturar tensiones, decisiones y aprendizajes.",
      level: "COMPANY",
      cadence: "QUARTERLY",
      status: "ACTIVE",
      progressPercent: 10,
      startDate: "2026-05-01T00:00:00.000Z",
      targetDate: "2026-07-31T00:00:00.000Z",
      owner: "admin",
      sortOrder: 0,
      keyResults: [
        { title: "Usuarios iniciales invitados y activos", targetValue: 1, currentValue: 0, unit: "grupo", progressPercent: 0 },
        { title: "Primeras tensiones operativas capturadas", targetValue: 10, currentValue: 1, unit: "tensiones", progressPercent: 10 },
        { title: "Roles iniciales revisados", targetValue: 6, currentValue: 6, unit: "roles", progressPercent: 100 },
      ],
    },
    {
      key: "operations-map",
      parentKey: "transformation-launch",
      circleKey: "operations",
      title: "Mapear flujos críticos de operación HPDC",
      descriptionMd: "Identificar dónde la autogestión puede mejorar coordinación, aprendizaje y velocidad de decisión.",
      level: "CIRCLE",
      cadence: "QUARTERLY",
      status: "ACTIVE",
      progressPercent: 5,
      sortOrder: 10,
      keyResults: [
        { title: "Procesos críticos priorizados", targetValue: 5, currentValue: 0, unit: "procesos", progressPercent: 0 },
        { title: "Tensiones de calidad, producción e ingeniería clasificadas", targetValue: 20, currentValue: 1, unit: "tensiones", progressPercent: 5 },
      ],
    },
    {
      key: "governance-baseline",
      parentKey: "transformation-launch",
      circleKey: "governance",
      title: "Definir base de roles, círculos y decisiones por consentimiento",
      descriptionMd: "Crear la estructura mínima para que los equipos puedan probar decisiones distribuidas con trazabilidad.",
      level: "CIRCLE",
      cadence: "QUARTERLY",
      status: "ACTIVE",
      progressPercent: 15,
      sortOrder: 20,
      keyResults: [
        { title: "Círculos iniciales publicados", targetValue: 5, currentValue: 5, unit: "círculos", progressPercent: 100 },
        { title: "Primeras propuestas procesadas", targetValue: 3, currentValue: 1, unit: "propuestas", progressPercent: 33 },
      ],
    },
  ],
  auditAction: "industrial_vilassarenca.stable_seeded",
});
