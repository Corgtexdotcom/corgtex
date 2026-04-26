import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const TEST_PREFIX = "[TEST]";
const ARCHIVE_REASON = "Automated tester artifact cleanup.";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function shouldPurgeEligible() {
  return process.argv.includes("--purge-eligible") || process.env.PURGE_ELIGIBLE_TEST_ARTIFACTS === "true";
}

function testPrefixWhere(fields) {
  return {
    OR: fields.map((field) => ({ [field]: { startsWith: TEST_PREFIX } })),
  };
}

function actorLabel(tester, cleanupActorEmail) {
  return cleanupActorEmail ?? `cleanup:${tester.email}`;
}

function labelFor(record) {
  return record.title ?? record.name ?? record.label ?? record.displayName ?? record.agentKey ?? record.email ?? record.description ?? record.id;
}

function snapshot(record) {
  return JSON.parse(JSON.stringify(record));
}

async function resolveWorkspace() {
  const workspaceId = optional("WORKSPACE_ID");
  const workspaceSlug = optional("WORKSPACE_SLUG");

  if (!workspaceId && !workspaceSlug) {
    throw new Error("Set WORKSPACE_ID or WORKSPACE_SLUG.");
  }

  const workspace = await prisma.workspace.findFirst({
    where: workspaceId ? { id: workspaceId } : { slug: workspaceSlug },
    select: { id: true, slug: true },
  });

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  return workspace;
}

async function archiveRecord(tx, params) {
  const { workspaceId, actorUserId, archivedByLabel, entityType, delegate, record, data = {} } = params;
  const archivedAt = new Date();

  await tx[delegate].update({
    where: { id: record.id },
    data: {
      archivedAt,
      archivedByUserId: actorUserId,
      archiveReason: ARCHIVE_REASON,
      ...data,
    },
  });

  await tx.workspaceArchiveRecord.create({
    data: {
      workspaceId,
      entityType,
      entityId: record.id,
      entityLabel: labelFor(record),
      previousState: snapshot(record),
      archiveReason: ARCHIVE_REASON,
      archivedByUserId: actorUserId,
      archivedByLabel,
      archivedAt,
    },
  });

  await tx.auditLog.create({
    data: {
      workspaceId,
      actorUserId,
      action: "test_artifact.archived",
      entityType,
      entityId: record.id,
      meta: {
        label: labelFor(record),
        reason: ARCHIVE_REASON,
      },
    },
  });
}

async function archiveBatch(tx, params) {
  const { records, ...rest } = params;
  for (const record of records) {
    await archiveRecord(tx, {
      ...rest,
      record,
      data: params.archiveData?.(record) ?? {},
    });
  }
  return records.length;
}

async function main() {
  const workspace = await resolveWorkspace();
  const testerEmail = required("TESTER_EMAIL").toLowerCase();
  const cleanupActorEmail = optional("CLEANUP_ACTOR_EMAIL")?.toLowerCase();
  const purgeEligible = shouldPurgeEligible();

  const tester = await prisma.user.findUnique({
    where: { email: testerEmail },
    select: { id: true, email: true },
  });

  if (!tester) {
    throw new Error("Tester user not found.");
  }

  const cleanupActor = cleanupActorEmail
    ? await prisma.user.findUnique({
        where: { email: cleanupActorEmail },
        select: { id: true },
      })
    : null;

  const actorUserId = cleanupActor?.id ?? null;
  const archivedByLabel = actorLabel(tester, cleanupActorEmail);

  const [
    actions,
    tensions,
    proposals,
    meetings,
    spends,
    ledgerAccounts,
    documents,
    brainArticles,
    brainSources,
    crmContacts,
    crmDeals,
    goals,
    cycles,
    circles,
    roles,
    webhookEndpoints,
    expertiseTags,
    workspaceAgentConfigs,
    oauthApps,
    externalDataSources,
    agentIdentities,
  ] = await Promise.all([
    prisma.action.findMany({
      where: { workspaceId: workspace.id, authorUserId: tester.id, archivedAt: null, title: { startsWith: TEST_PREFIX } },
    }),
    prisma.tension.findMany({
      where: { workspaceId: workspace.id, authorUserId: tester.id, archivedAt: null, title: { startsWith: TEST_PREFIX } },
    }),
    prisma.proposal.findMany({
      where: { workspaceId: workspace.id, authorUserId: tester.id, archivedAt: null, title: { startsWith: TEST_PREFIX } },
    }),
    prisma.meeting.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, ...testPrefixWhere(["title", "source"]) },
    }),
    prisma.spendRequest.findMany({
      where: {
        workspaceId: workspace.id,
        requesterUserId: tester.id,
        archivedAt: null,
        OR: [
          { description: { startsWith: TEST_PREFIX } },
          { category: { startsWith: TEST_PREFIX } },
          { vendor: { startsWith: TEST_PREFIX } },
        ],
      },
    }),
    prisma.ledgerAccount.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, name: { startsWith: TEST_PREFIX } },
    }),
    prisma.document.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, ...testPrefixWhere(["title", "source"]) },
    }),
    prisma.brainArticle.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, title: { startsWith: TEST_PREFIX } },
    }),
    prisma.brainSource.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, ...testPrefixWhere(["title", "externalId", "channel"]) },
    }),
    prisma.crmContact.findMany({
      where: {
        workspaceId: workspace.id,
        archivedAt: null,
        OR: [
          { name: { startsWith: TEST_PREFIX } },
          { company: { startsWith: TEST_PREFIX } },
          { source: { startsWith: TEST_PREFIX } },
          { tags: { has: TEST_PREFIX } },
        ],
      },
    }),
    prisma.crmDeal.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, title: { startsWith: TEST_PREFIX } },
    }),
    prisma.goal.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, title: { startsWith: TEST_PREFIX } },
    }),
    prisma.cycle.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, name: { startsWith: TEST_PREFIX } },
    }),
    prisma.circle.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, name: { startsWith: TEST_PREFIX } },
    }),
    prisma.role.findMany({
      where: { archivedAt: null, name: { startsWith: TEST_PREFIX }, circle: { workspaceId: workspace.id } },
    }),
    prisma.webhookEndpoint.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, label: { startsWith: TEST_PREFIX } },
    }),
    prisma.expertiseTag.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, label: { startsWith: TEST_PREFIX } },
    }),
    prisma.workspaceAgentConfig.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, agentKey: { startsWith: TEST_PREFIX } },
    }),
    prisma.oAuthApp.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, name: { startsWith: TEST_PREFIX } },
    }),
    prisma.externalDataSource.findMany({
      where: { workspaceId: workspace.id, archivedAt: null, label: { startsWith: TEST_PREFIX } },
    }),
    prisma.agentIdentity.findMany({
      where: {
        workspaceId: workspace.id,
        archivedAt: null,
        OR: [
          { displayName: { startsWith: TEST_PREFIX } },
          { agentKey: { startsWith: TEST_PREFIX } },
        ],
      },
    }),
  ]);

  const counts = {};

  await prisma.$transaction(async (tx) => {
    const base = { workspaceId: workspace.id, actorUserId, archivedByLabel };
    counts.Action = await archiveBatch(tx, { ...base, entityType: "Action", delegate: "action", records: actions });
    counts.Tension = await archiveBatch(tx, { ...base, entityType: "Tension", delegate: "tension", records: tensions });
    counts.Proposal = await archiveBatch(tx, {
      ...base,
      entityType: "Proposal",
      delegate: "proposal",
      records: proposals,
    });
    counts.Meeting = await archiveBatch(tx, { ...base, entityType: "Meeting", delegate: "meeting", records: meetings });
    counts.SpendRequest = await archiveBatch(tx, { ...base, entityType: "SpendRequest", delegate: "spendRequest", records: spends });
    counts.LedgerAccount = await archiveBatch(tx, { ...base, entityType: "LedgerAccount", delegate: "ledgerAccount", records: ledgerAccounts });
    counts.Document = await archiveBatch(tx, { ...base, entityType: "Document", delegate: "document", records: documents });
    counts.BrainArticle = await archiveBatch(tx, { ...base, entityType: "BrainArticle", delegate: "brainArticle", records: brainArticles });
    counts.BrainSource = await archiveBatch(tx, { ...base, entityType: "BrainSource", delegate: "brainSource", records: brainSources });
    counts.CrmContact = await archiveBatch(tx, { ...base, entityType: "CrmContact", delegate: "crmContact", records: crmContacts });
    counts.CrmDeal = await archiveBatch(tx, { ...base, entityType: "CrmDeal", delegate: "crmDeal", records: crmDeals });
    counts.Goal = await archiveBatch(tx, { ...base, entityType: "Goal", delegate: "goal", records: goals });
    counts.Cycle = await archiveBatch(tx, { ...base, entityType: "Cycle", delegate: "cycle", records: cycles });
    counts.Circle = await archiveBatch(tx, { ...base, entityType: "Circle", delegate: "circle", records: circles });
    counts.Role = await archiveBatch(tx, { ...base, entityType: "Role", delegate: "role", records: roles });
    counts.WebhookEndpoint = await archiveBatch(tx, {
      ...base,
      entityType: "WebhookEndpoint",
      delegate: "webhookEndpoint",
      records: webhookEndpoints,
      archiveData: () => ({ status: "DISABLED" }),
    });
    counts.ExpertiseTag = await archiveBatch(tx, { ...base, entityType: "ExpertiseTag", delegate: "expertiseTag", records: expertiseTags });
    counts.WorkspaceAgentConfig = await archiveBatch(tx, {
      ...base,
      entityType: "WorkspaceAgentConfig",
      delegate: "workspaceAgentConfig",
      records: workspaceAgentConfigs,
      archiveData: () => ({ enabled: false }),
    });
    counts.OAuthApp = await archiveBatch(tx, {
      ...base,
      entityType: "OAuthApp",
      delegate: "oAuthApp",
      records: oauthApps,
      archiveData: () => ({ isActive: false }),
    });
    counts.ExternalDataSource = await archiveBatch(tx, {
      ...base,
      entityType: "ExternalDataSource",
      delegate: "externalDataSource",
      records: externalDataSources,
      archiveData: () => ({ isActive: false }),
    });
    counts.AgentIdentity = await archiveBatch(tx, {
      ...base,
      entityType: "AgentIdentity",
      delegate: "agentIdentity",
      records: agentIdentities,
      archiveData: () => ({ isActive: false }),
    });
  });

  const purged = { SpendRequest: 0, LedgerAccount: 0 };
  if (purgeEligible) {
    const draftSpendIds = spends.filter((spend) => spend.status === "DRAFT").map((spend) => spend.id);
    if (draftSpendIds.length > 0) {
      const spendsWithLedger = await prisma.ledgerEntry.findMany({
        where: { referenceType: "SpendRequest", referenceId: { in: draftSpendIds } },
        select: { referenceId: true },
      });
      const blockedSpendIds = new Set(spendsWithLedger.map((entry) => entry.referenceId).filter(Boolean));
      const purgeSpendIds = draftSpendIds.filter((id) => !blockedSpendIds.has(id));
      if (purgeSpendIds.length > 0) {
        const result = await prisma.spendRequest.deleteMany({ where: { id: { in: purgeSpendIds } } });
        purged.SpendRequest = result.count;
        await prisma.workspaceArchiveRecord.updateMany({
          where: { workspaceId: workspace.id, entityType: "SpendRequest", entityId: { in: purgeSpendIds }, purgedAt: null },
          data: { purgedAt: new Date(), purgedByUserId: actorUserId, purgeReason: "Eligible draft test spend cleanup." },
        });
      }
    }

    const ledgerAccountIds = ledgerAccounts.map((account) => account.id);
    if (ledgerAccountIds.length > 0) {
      const [accountsWithEntries, accountsWithActiveSpends] = await Promise.all([
        prisma.ledgerEntry.findMany({ where: { accountId: { in: ledgerAccountIds } }, select: { accountId: true } }),
        prisma.spendRequest.findMany({
          where: { ledgerAccountId: { in: ledgerAccountIds }, archivedAt: null },
          select: { ledgerAccountId: true },
        }),
      ]);
      const blockedAccountIds = new Set([
        ...accountsWithEntries.map((entry) => entry.accountId),
        ...accountsWithActiveSpends.map((spend) => spend.ledgerAccountId).filter(Boolean),
      ]);
      const purgeAccountIds = ledgerAccountIds.filter((id) => !blockedAccountIds.has(id));
      if (purgeAccountIds.length > 0) {
        const result = await prisma.ledgerAccount.deleteMany({ where: { id: { in: purgeAccountIds } } });
        purged.LedgerAccount = result.count;
        await prisma.workspaceArchiveRecord.updateMany({
          where: { workspaceId: workspace.id, entityType: "LedgerAccount", entityId: { in: purgeAccountIds }, purgedAt: null },
          data: { purgedAt: new Date(), purgedByUserId: actorUserId, purgeReason: "Eligible unused test ledger account cleanup." },
        });
      }
    }
  }

  const archivedTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const purgedTotal = Object.values(purged).reduce((sum, count) => sum + count, 0);
  console.log(`Archived ${archivedTotal} test artifacts in ${workspace.slug}.`);
  console.log(JSON.stringify({ archived: counts, purged }, null, 2));
  if (!purgeEligible && purgedTotal === 0) {
    console.log("Pass --purge-eligible or PURGE_ELIGIBLE_TEST_ARTIFACTS=true to purge eligible draft spend/account test rows.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
