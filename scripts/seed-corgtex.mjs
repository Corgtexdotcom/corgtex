import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

const WORKSPACE_SLUG = "corgtex";
const WORKSPACE_NAME = "Corgtex";

// ─── Helpers ───
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

// ─── Article Definitions ───
const ARTICLES = [
  // ARCHITECTURE
  { title: "Platform Technical Architecture", type: "ARCHITECTURE", authority: "AUTHORITATIVE",
    body: `# Platform Technical Architecture\n\nStack: Next.js 15 (App Router), React 19, TypeScript (strict), Vanilla CSS (no Tailwind), PostgreSQL via Prisma ORM, Railway for deployment.\n\nAll workspaces operate on a single shared deployment. There is no per-workspace code.` },
  { title: "Monorepo Package Structure", type: "ARCHITECTURE", authority: "REFERENCE",
    body: `# Monorepo Package Structure\n\n- \`apps/web\`: Main UI and route handlers\n- \`apps/worker\`: Workflow worker loop\n- \`apps/site\`: Marketing website\n- \`packages/domain\`: Business logic\n- \`packages/shared\`: Env/db/types\n- \`packages/workflows\`: Event/job orchestration\n- \`packages/knowledge\`: RAG pipeline\n- \`packages/agents\`: Execution runtime` },
  { title: "Database Schema Overview", type: "ARCHITECTURE", authority: "REFERENCE",
    body: `# Database Schema Overview\n\nEverything originates from the \`Workspace\` model. Core relations include \`User\`, \`Member\`, \`Circle\`, \`Role\`, \`Proposal\`, \`Tension\`, \`LedgerAccount\`, \`BrainArticle\`, \`KnowledgeChunk\`, \`Action\`, \`DemoLead\`, and \`Meeting\`. All IDs are UUIDs. Finance amounts are \`Int\` representing Cents.` },
  { title: "Agent Runtime Architecture", type: "ARCHITECTURE", authority: "REFERENCE",
    body: `# Agent Runtime Architecture\n\nAgents execute autonomously or directly interact with users via Chat Interface. Driven by \`AgentRun\`, \`AgentCredential\`, and Model Context Protocols (MCP). Built on OpenRouter for LLM gateway routing.` },
  { title: "Knowledge & RAG Pipeline", type: "ARCHITECTURE", authority: "REFERENCE",
    body: `# Knowledge & RAG Pipeline\n\nDocuments and Meeting Transcripts ingest into the Brain via Recursive Text Splitting. \`BrainArticle\` stores formal synthesized content, while \`KnowledgeChunk\` powers the RAG vector search for conversational AI contexts.` },
  { title: "Workflow & Event System", type: "ARCHITECTURE", authority: "REFERENCE",
    body: `# Workflow & Event System\n\nImplemented via Outbox Pattern. Events record in the \`Event\` table and trigger \`WorkflowJob\` execution for guaranteed delivery and fault tolerance.` },
  
  // PRODUCT
  { title: "Governance System", type: "PRODUCT", authority: "AUTHORITATIVE",
    body: `# Governance System\n\nBuilt on Consent-based decision-making. Circles represent domains, Roles have accountabilities, and Proposals must pass through an objection checking phase (integrated or withdrawn) before execution.` },
  { title: "Finance Module", type: "PRODUCT", authority: "AUTHORITATIVE",
    body: `# Finance Module\n\nManages \`LedgerAccount\` double-entry book-keeping. \`SpendRequest\` handles cross-circle expense approvals with receipt attachment and reconciliation tracing.` },
  { title: "Organization Brain", type: "PRODUCT", authority: "AUTHORITATIVE",
    body: `# Organization Brain\n\nDynamic AI knowledge base with Versioning. Submits backlinks and automatically groups organizational knowledge based on semantic relevance via AI bots.` },
  { title: "O2 Integration — Organic Organization", type: "PRODUCT", authority: "REFERENCE",
    body: `# O2 Integration\n\nSupports Organic Organization (O2) methodology primitives: Maturity Stages, Check-ins, and standard Artifacts tracking platform maturity.` },
  { title: "Demo System", type: "PRODUCT", authority: "REFERENCE",
    body: `# Demo System\n\nPublic instances feature an auto-login gate. The Demo Guard natively blocks data mutations in read-only setups. Now gated behind an Email-capture flow storing \`DemoLead\` rows in Corgtex.` },
  
  // STRATEGY
  { title: "GEO & AI Search Optimization", type: "STRATEGY", authority: "AUTHORITATIVE",
    body: `# GEO & AI Search Optimization\n\n(PR #103) Focus on making Corgtex a top referenced entity by AI platforms via \`llms.txt\`, JSON-LD schema generation, robots.txt, and AI extractability content practices.` },
  { title: "Customer Acquisition Strategy", type: "STRATEGY", authority: "AUTHORITATIVE",
    body: `# Customer Acquisition Strategy\n\nUtilizing "How to DAO" assets as lead magnets. All website visitors triggering the demo must enter their email, funneling them into the platform as a \`DemoLead\` tracked in the internal Corgtex workspace UI.` },
  { title: "Multi-Workspace Model", type: "STRATEGY", authority: "AUTHORITATIVE",
    body: `# Multi-Workspace Model\n\nOne codebase serving \`crina\` (Client), \`jnj-demo\` (Public Demo), and \`corgtex\` (Internal Dogfood & Company Home). Each accesses the same feature deployments without cross-client codebase branching.` },
  
  // PROCESS
  { title: "Deployment Pipeline", type: "PROCESS", authority: "REFERENCE",
    body: `# Deployment Pipeline\n\nDeployed securely through Railway with strict Docker configuration. \`start-web.mjs\` orchestrates migrations, seeds, and server startup upon container initialization.` },
  { title: "Prisma Migration Workflow", type: "PROCESS", authority: "REFERENCE",
    body: `# Prisma Migration Workflow\n\nNever blindly \`db push\`. Proactively generate explicit migrations via \`npm run prisma:migrate -- --name <X>\`. The Next.js build step strictly remains DB-agnostic.` },
  { title: "Git & PR Strategy", type: "PROCESS", authority: "REFERENCE",
    body: `# Git & PR Strategy\n\nEvery feature exists in a sandbox branch. Pull-Requests are automatically opened using the \`gh\` CLI.` },
  { title: "Testing Strategy", type: "PROCESS", authority: "REFERENCE",
    body: `# Testing Strategy\n\nVitest isolates components in node environments. \`npm run check\` runs TypeScript validation. E2E uses the Agent API layer configured with an API key.` },

  // DECISION
  { title: "PR #90: J&J Demo Seeding", type: "DECISION", authority: "REFERENCE",
    body: `# PR #90: J&J Demo Seeding\n\nEstablished the first public readonly workspace to highlight comprehensive data density without showing admin UI.` },
  { title: "PR #98: O2 Methodology Integration", type: "DECISION", authority: "REFERENCE",
    body: `# PR #98: O2 Methodology Integration\n\nAdded explicit tracking of Organic Organization primitives to accommodate existing clients.` },
  { title: "PR #99: Finance Agent UX", type: "DECISION", authority: "REFERENCE",
    body: `# PR #99: Finance Agent UX\n\nEnabled Agent to submit and process finance spends on behalf of users.` },
  { title: "PR #103: GEO Implementation", type: "DECISION", authority: "REFERENCE",
    body: `# PR #103: GEO Implementation\n\nRe-structured Web metadata layer to be highly indexable by Gemini/Claude crawlers.` }
];

async function main() {
  console.log("🚀 Starting Corgtex Internal Workspace Seed...");

  // 1. Get or create workspace (Base seed handles this usually, but let's be safe)
  let workspace = await prisma.workspace.findUnique({ where: { slug: WORKSPACE_SLUG } });
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        slug: WORKSPACE_SLUG,
        name: WORKSPACE_NAME,
        description: "Internal company operating environment for Corgtex",
      }
    });
    console.log(`Created workspace ${WORKSPACE_SLUG}`);
  }
  const wsId = workspace.id;
  console.log(`Using workspace ${workspace.slug} (${wsId})`);

  // 2. Ensure system & admin user exists
  const adminEmail = "puncar@corgtex.com";
  let adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!adminUser) {
    adminUser = await prisma.user.create({
      data: {
        email: adminEmail,
        displayName: "Puncar (Founder)",
        passwordHash: hashPassword(process.env.ADMIN_PASSWORD || "corgtex-default-pw")
      }
    });
  }
  
  await prisma.member.upsert({
    where: { workspaceId_userId: { workspaceId: wsId, userId: adminUser.id } },
    update: { role: "ADMIN", isActive: true },
    create: { workspaceId: wsId, userId: adminUser.id, role: "ADMIN", isActive: true }
  });

  const systemEmail = "system+corgtex@corgtex.local";
  let systemUser = await prisma.user.findUnique({ where: { email: systemEmail } });
  if (!systemUser) {
    systemUser = await prisma.user.create({
      data: { 
        email: systemEmail, 
        displayName: "Corgtex System Agent", 
        passwordHash: hashPassword("system-internal-only") 
      }
    });
  }

  await prisma.member.upsert({
    where: { workspaceId_userId: { workspaceId: wsId, userId: systemUser.id } },
    update: { role: "ADMIN", isActive: true },
    create: { workspaceId: wsId, userId: systemUser.id, role: "ADMIN", isActive: true }
  });

  const additionalUsers = [
    { email: "andy.durrant@zinata.com", name: "Andy Durrant" },
    { email: "datise.biasi@zinata.com", name: "Datise Biasi" },
    { email: "datyusp@gmail.com", name: "datyusp" },
    { email: "dschmidt@csieis.com", name: "dschmidt" },
    { email: "noel.peberdy@zinata.com", name: "Noel Peberdy" }
  ];

  for (const u of additionalUsers) {
    let userRecord = await prisma.user.findUnique({ where: { email: u.email } });
    if (!userRecord) {
      userRecord = await prisma.user.create({
        data: {
          email: u.email,
          displayName: u.name,
          passwordHash: hashPassword("Selfmanagement")
        }
      });
      console.log(`Created user ${u.email}`);
    } else {
      userRecord = await prisma.user.update({
        where: { email: u.email },
        data: {
          passwordHash: hashPassword("Selfmanagement")
        }
      });
      console.log(`Updated password for ${u.email}`);
    }

    await prisma.member.upsert({
      where: { workspaceId_userId: { workspaceId: wsId, userId: userRecord.id } },
      update: { role: "MEMBER", isActive: true },
      create: { workspaceId: wsId, userId: userRecord.id, role: "MEMBER", isActive: true }
    });
  }

  // 3. Create Circles
  const circleNames = ["General", "Engineering", "Product", "Growth", "Operations"];
  const circleIds = {};
  for (const name of circleNames) {
    let c = await prisma.circle.findFirst({
      where: { workspaceId: wsId, name }
    });
    if (!c) {
      c = await prisma.circle.create({
        data: {
          workspaceId: wsId,
          name,
          purposeMd: `Execute and maintain Corgtex operations dynamically within the ${name} domain.`,
        }
      });
    }
    circleIds[name] = c.id;
  }
  console.log(`Ensured ${circleNames.length} circles exist.`);

  // 4. Create Brain Articles
  let articleCount = 0;
  for (const article of ARTICLES) {
    const slug = slugify(article.title);
    const created = await prisma.brainArticle.upsert({
      where: { workspaceId_slug: { workspaceId: wsId, slug } },
      update: {
        title: article.title,
        type: article.type,
        authority: article.authority,
        bodyMd: article.body,
      },
      create: {
        workspaceId: wsId,
        slug,
        title: article.title,
        type: article.type,
        authority: article.authority,
        bodyMd: article.body,
      },
    });

    const existingVersion = await prisma.brainArticleVersion.findFirst({
      where: { articleId: created.id, version: 1 },
    });
    if (!existingVersion) {
      await prisma.brainArticleVersion.create({
        data: {
          articleId: created.id,
          version: 1,
          bodyMd: article.body,
          changeSummary: "Initial seed article derived from repo.",
        },
      });
    }
    articleCount++;
  }
  console.log(`Created ${articleCount} brain articles.`);

  // 5. Create Tensions & Proposals
  const tensionsToCreate = [
    {
      title: "Need pgvector for semantic search",
      bodyMd: "Our RAG pipeline currently uses a rudimentary distance check. We should move to pgvector.",
      circleId: circleIds["Engineering"],
    },
    {
      title: "Demo Guard Coverage Gaps",
      bodyMd: "Users on the read-only jnj-demo might still hit un-guarded backend POST routes. Need comprehensive testing.",
      circleId: circleIds["Engineering"],
    }
  ];

  for (const t of tensionsToCreate) {
    const existing = await prisma.tension.findFirst({
      where: { workspaceId: wsId, title: t.title }
    });
    if (!existing) {
      await prisma.tension.create({
        data: {
          workspaceId: wsId,
          authorUserId: adminUser.id,
          title: t.title,
          bodyMd: t.bodyMd,
          circleId: t.circleId,
        }
      });
    }
  }

  console.log(`Ensured sample tensions exist.`);

  // 6. Create Ledger Accounts
  const accounts = [
    { name: "Infrastructure Hosting (Railway)", currency: "USD", balanceCents: 1540_00 },
    { name: "LLM API Tranches (OpenRouter)", currency: "USD", balanceCents: 200_00 },
    { name: "Domain Registrations", currency: "USD", balanceCents: -50_00 },
  ];

  for (const acct of accounts) {
    const existing = await prisma.ledgerAccount.findFirst({
      where: { workspaceId: wsId, name: acct.name },
    });
    if (!existing) {
      await prisma.ledgerAccount.create({
        data: { workspaceId: wsId, name: acct.name, type: "MANUAL", currency: acct.currency, balanceCents: acct.balanceCents },
      });
    }
  }
  console.log(`Created ${accounts.length} ledger accounts.`);

  console.log("✅ Corgtex internal workspace seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
