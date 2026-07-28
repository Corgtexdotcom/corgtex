import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

import { seedStableClient } from "./lib/client-stable-seed.mjs";
import {
  INTERNAL_VALIDATION_WORKSPACE_NAME,
  INTERNAL_VALIDATION_WORKSPACE_SLUG,
} from "./lib/validation-workspace.mjs";

const FIXTURE_SOURCE = "production-validation-seed";

function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function requiredEnv(names) {
  const value = firstEnv(names);
  if (!value) throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
  return value;
}

function pinValidationSeedEnvironment() {
  const explicitValidationAdminEmail = process.env.VALIDATION_BOOTSTRAP_ADMIN_EMAIL?.trim();
  const globalAdminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminEmail = requiredEnv(["VALIDATION_BOOTSTRAP_ADMIN_EMAIL", "ADMIN_EMAIL"]).toLowerCase();
  const reusesGlobalAdmin = Boolean(globalAdminEmail && adminEmail === globalAdminEmail);
  process.env.VALIDATION_BOOTSTRAP_ADMIN_EMAIL = adminEmail;
  process.env.VALIDATION_WORKSPACE_SLUG = INTERNAL_VALIDATION_WORKSPACE_SLUG;
  process.env.VALIDATION_WORKSPACE_NAME = INTERNAL_VALIDATION_WORKSPACE_NAME;
  if (explicitValidationAdminEmail && !reusesGlobalAdmin) {
    process.env.VALIDATION_ADMIN_DISPLAY_NAME ??= "Corgtex Validation Admin";
  } else {
    delete process.env.ADMIN_DISPLAY_NAME;
    delete process.env.CLIENT_ADMIN_DISPLAY_NAME;
    delete process.env.VALIDATION_ADMIN_DISPLAY_NAME;
  }
  process.env.VALIDATION_USERS_JSON = "[]";
  process.env.VALIDATION_SEND_INVITES = "false";
  process.env.VALIDATION_PRINT_INVITE_LINKS = "false";
  process.env.VALIDATION_SEED_SAMPLE_DATA = "true";
  delete process.env.PRODUCTION_VALIDATION_WORKSPACE_ID;
  delete process.env.PRODUCTION_VALIDATION_WORKSPACE_SLUG;
  delete process.env.CLIENT_WORKSPACE_SLUG;
  delete process.env.CLIENT_WORKSPACE_NAME;
  delete process.env.WORKSPACE_SLUG;
  delete process.env.WORKSPACE_NAME;
  delete process.env.CLIENT_USERS_JSON;
  delete process.env.CLIENT_USERS_CSV;
  delete process.env.CLIENT_SEND_INVITES;
  delete process.env.CLIENT_PRINT_INVITE_LINKS;
}

function assertValidationSeedEnvironmentPinned() {
  if (process.env.VALIDATION_WORKSPACE_SLUG !== INTERNAL_VALIDATION_WORKSPACE_SLUG) {
    throw new Error(`Validation seed must stay pinned to ${INTERNAL_VALIDATION_WORKSPACE_SLUG}.`);
  }
  if (process.env.VALIDATION_USERS_JSON !== "[]") {
    throw new Error("Validation seed must not import client users.");
  }
  if (process.env.VALIDATION_SEND_INVITES !== "false" || process.env.CLIENT_SEND_INVITES) {
    throw new Error("Validation seed must not send invitation emails.");
  }
  for (const name of ["CLIENT_USERS_JSON", "CLIENT_USERS_CSV", "CLIENT_WORKSPACE_SLUG", "WORKSPACE_SLUG"]) {
    if (process.env[name]?.trim()) {
      throw new Error(`Validation seed must not inherit ${name}.`);
    }
  }
}

export const validationSeedConfig = {
  envPrefix: "VALIDATION",
  defaultLocale: "en",
  workspace: {
    slug: INTERNAL_VALIDATION_WORKSPACE_SLUG,
    name: INTERNAL_VALIDATION_WORKSPACE_NAME,
    description: "Internal production validation workspace containing only synthetic, reversible smoke-test data.",
  },
  invite: {
    subject: "Corgtex validation workspace access",
    title: "Corgtex validation workspace",
    greeting: "Hi {name},",
    body: "Use this internal workspace only for tagged Corgtex production validation runs.",
    button: "Set up access",
    fallbackName: "there",
  },
  featureFlags: {
    FINANCE: true,
    RELATIONSHIPS: true,
    GOALS: true,
    TOOL_LINKS: true,
    MEETING_TRANSCRIPT_SOURCES: true,
    MEETING_CONTEXTUAL_INTELLIGENCE: true,
    AGENT_GOVERNANCE: true,
    SETTINGS_GENERAL: true,
    AI_WORKSPACES: true,
  },
  approvalPolicies: [
    { subjectType: "PROPOSAL", mode: "CONSENT" },
    { subjectType: "ACTION", mode: "SINGLE" },
  ],
  circles: [
    {
      key: "operations",
      name: "Validation Operations",
      purposeMd: "Synthetic operations records used by production validation smokes.",
      domainMd: "No customer data. All mutation-heavy tests must use tagged temporary records and cleanup.",
      sortOrder: 10,
    },
    {
      key: "relationships",
      name: "Validation Relationships",
      purposeMd: "Synthetic CRM records used to prove relationship surfaces without touching customer tenants.",
      domainMd: "Fixture account, contact, deal, activity, and communication suggestion.",
      sortOrder: 20,
    },
  ],
  roles: [
    {
      key: "validation-steward",
      circleKey: "operations",
      name: "Validation Steward",
      purposeMd: "Owns production validation safety, evidence, and cleanup.",
      accountabilities: [
        "Keep validation records synthetic and clearly tagged.",
        "Archive or complete temporary validation records after each run.",
      ],
    },
    {
      key: "relationship-steward",
      circleKey: "relationships",
      name: "Relationship Validation Steward",
      purposeMd: "Maintains harmless CRM fixtures for visual and MCP relationship validation.",
      accountabilities: ["Keep CRM validation fixtures free of customer data."],
    },
  ],
  roleAssignmentsByMemberRole: {
    ADMIN: ["validation-steward", "relationship-steward"],
    FACILITATOR: ["validation-steward"],
  },
  brainArticles: [
    {
      title: "Internal Validation Workspace Rules",
      slug: "internal-validation-workspace-rules",
      type: "RUNBOOK",
      authority: "AUTHORITATIVE",
      bodyMd: [
        "# Internal Validation Workspace Rules",
        "",
        "This workspace contains only synthetic records for production validation.",
        "Mutation-heavy smokes must prefix temporary records with PROD-VERIFY and record cleanup evidence.",
        "Customer and demo tenants must not be used for destructive validation writes.",
      ].join("\n"),
    },
  ],
  meeting: {
    title: "Validation Fixture Meeting",
    source: "production-validation-seed",
    recordedAt: "2026-01-01T12:00:00.000Z",
    summaryMd: "Synthetic meeting used to keep briefing and meeting surfaces non-empty.",
    transcript: "Validation Steward: Confirm all production smoke records are tagged and cleaned up.",
  },
  action: {
    circleKey: "operations",
    title: "Validation fixture action",
    bodyMd: "Synthetic open action used as stable read-only fixture data.",
    status: "OPEN",
  },
  tension: {
    circleKey: "operations",
    title: "Validation fixture tension",
    bodyMd: "Synthetic tension used as stable read-only fixture data.",
    status: "OPEN",
    priority: 2,
  },
  proposal: {
    circleKey: "operations",
    title: "Validation fixture proposal",
    summary: "Synthetic proposal used as stable read-only fixture data.",
    bodyMd: "Adopt the validation workspace rules for smoke-test isolation.",
    status: "OPEN",
  },
  goals: [
    {
      key: "validation-confidence",
      title: "Maintain production validation confidence",
      descriptionMd: "Keep production evidence repeatable without using customer data.",
      level: "COMPANY",
      cadence: "QUARTERLY",
      status: "ACTIVE",
      owner: "admin",
      circleKey: "operations",
      keyResults: [
        {
          title: "All production validation writes have cleanup evidence",
          targetValue: 100,
          currentValue: 0,
          unit: "percent",
        },
      ],
    },
  ],
  auditAction: "internal_validation_workspace.seeded",
};

async function upsertRelationshipFixtures() {
  const prisma = new PrismaClient();
  try {
    const workspaceSlug = INTERNAL_VALIDATION_WORKSPACE_SLUG;
    const adminEmail = requiredEnv(["VALIDATION_BOOTSTRAP_ADMIN_EMAIL", "ADMIN_EMAIL"]).toLowerCase();
    const workspace = await prisma.workspace.findUnique({
      where: { slug: workspaceSlug },
      select: { id: true, slug: true },
    });
    if (!workspace) throw new Error(`Workspace '${workspaceSlug}' was not seeded.`);

    const adminUser = await prisma.user.findUnique({
      where: { email: adminEmail },
      select: { id: true },
    });
    if (!adminUser) throw new Error(`Admin user '${adminEmail}' was not seeded.`);

    const account = await prisma.crmAccount.upsert({
      where: {
        workspaceId_slug: {
          workspaceId: workspace.id,
          slug: "validation-fixture-labs",
        },
      },
      update: {
        name: "Validation Fixture Labs",
        domain: "validation.example",
        relationshipType: "PROSPECT",
        lifecycleStage: "DISCOVERY",
        descriptionMd: "Synthetic CRM account for production validation only.",
        source: FIXTURE_SOURCE,
        tags: ["internal-validation", "synthetic"],
        ownerUserId: adminUser.id,
        archivedAt: null,
      },
      create: {
        workspaceId: workspace.id,
        name: "Validation Fixture Labs",
        slug: "validation-fixture-labs",
        domain: "validation.example",
        relationshipType: "PROSPECT",
        lifecycleStage: "DISCOVERY",
        descriptionMd: "Synthetic CRM account for production validation only.",
        source: FIXTURE_SOURCE,
        tags: ["internal-validation", "synthetic"],
        ownerUserId: adminUser.id,
      },
    });

    const contact = await prisma.crmContact.upsert({
      where: {
        workspaceId_email: {
          workspaceId: workspace.id,
          email: "validation-contact@validation.example",
        },
      },
      update: {
        accountId: account.id,
        name: "Validation Contact",
        company: account.name,
        title: "Synthetic Fixture",
        source: FIXTURE_SOURCE,
        tags: ["internal-validation", "synthetic"],
        archivedAt: null,
      },
      create: {
        workspaceId: workspace.id,
        accountId: account.id,
        email: "validation-contact@validation.example",
        name: "Validation Contact",
        company: account.name,
        title: "Synthetic Fixture",
        source: FIXTURE_SOURCE,
        tags: ["internal-validation", "synthetic"],
      },
    });

    const dealTitle = "Validation fixture opportunity";
    const existingDeal = await prisma.crmDeal.findFirst({
      where: { workspaceId: workspace.id, accountId: account.id, title: dealTitle },
      select: { id: true },
    });
    const deal = existingDeal
      ? await prisma.crmDeal.update({
          where: { id: existingDeal.id },
          data: {
            contactId: contact.id,
            stage: "QUALIFIED",
            valueCents: 1250000,
            currency: "USD",
            ownerUserId: adminUser.id,
            notes: "Synthetic deal for production validation only.",
            archivedAt: null,
          },
        })
      : await prisma.crmDeal.create({
          data: {
            workspaceId: workspace.id,
            accountId: account.id,
            contactId: contact.id,
            title: dealTitle,
            stage: "QUALIFIED",
            valueCents: 1250000,
            currency: "USD",
            ownerUserId: adminUser.id,
            notes: "Synthetic deal for production validation only.",
          },
        });

    const activity = await prisma.crmActivity.upsert({
      where: {
        workspaceId_source_sourceExternalId: {
          workspaceId: workspace.id,
          source: FIXTURE_SOURCE,
          sourceExternalId: "validation-fixture-activity",
        },
      },
      update: {
        accountId: account.id,
        contactId: contact.id,
        dealId: deal.id,
        actorUserId: adminUser.id,
        ownerUserId: adminUser.id,
        type: "TASK",
        title: "Validation fixture CRM task",
        bodyMd: "Synthetic open CRM task for production validation only.",
        dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        completedAt: null,
      },
      create: {
        workspaceId: workspace.id,
        accountId: account.id,
        contactId: contact.id,
        dealId: deal.id,
        actorUserId: adminUser.id,
        ownerUserId: adminUser.id,
        type: "TASK",
        title: "Validation fixture CRM task",
        bodyMd: "Synthetic open CRM task for production validation only.",
        source: FIXTURE_SOURCE,
        sourceExternalId: "validation-fixture-activity",
        dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const existingSuggestion = await prisma.crmCommunicationSuggestion.findFirst({
      where: {
        workspaceId: workspace.id,
        source: FIXTURE_SOURCE,
        externalRequestId: "validation-fixture-suggestion",
      },
      select: { id: true },
    });
    const suggestionData = {
      accountId: account.id,
      contactId: contact.id,
      dealId: deal.id,
      activityId: activity.id,
      actorUserId: adminUser.id,
      ownerUserId: adminUser.id,
      status: "SUGGESTED",
      channel: "EMAIL",
      title: "Validation fixture communication suggestion",
      subject: "Synthetic validation follow-up",
      bodyMd: "Synthetic communication suggestion for production validation only.",
      recipientEmail: contact.email,
      recipientName: contact.name,
      source: FIXTURE_SOURCE,
      requestedAt: new Date(),
    };
    const suggestion = existingSuggestion
      ? await prisma.crmCommunicationSuggestion.update({
          where: { id: existingSuggestion.id },
          data: suggestionData,
        })
      : await prisma.crmCommunicationSuggestion.create({
          data: {
            workspaceId: workspace.id,
            externalRequestId: "validation-fixture-suggestion",
            ...suggestionData,
          },
        });

    console.log(`Seeded internal validation CRM fixtures in '${workspace.slug}'.`);
    console.log(JSON.stringify({
      workspaceId: workspace.id,
      accountId: account.id,
      contactId: contact.id,
      dealId: deal.id,
      activityId: activity.id,
      suggestionId: suggestion.id,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

export async function main() {
  pinValidationSeedEnvironment();
  assertValidationSeedEnvironmentPinned();
  await seedStableClient(validationSeedConfig);
  await upsertRelationshipFixtures();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error("[seed-internal-validation-workspace] Seed failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
