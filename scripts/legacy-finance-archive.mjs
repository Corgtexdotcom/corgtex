#!/usr/bin/env node
/**
 * Safe bridge for retiring the old Spend/Accounts backend.
 *
 * The destructive schema cleanup is gated by live data. This script provides a
 * read-only audit and explicit per-workspace export bundle so old rows can be
 * archived before the tables are dropped.
 *
 * Usage:
 *   node scripts/legacy-finance-archive.mjs audit
 *   node scripts/legacy-finance-archive.mjs export --workspace <id-or-slug> --out-dir .artifacts/legacy-finance-archive
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const LEGACY_FINANCE_ARCHIVE_VERSION = "1";
export const DEFAULT_OUT_DIR = ".artifacts/legacy-finance-archive";

export const LEGACY_FINANCE_TABLE_KEYS = [
  "ledgerAccounts",
  "ledgerEntries",
  "spendRequests",
  "spendProposalLinks",
  "spendComments",
  "approvalFlows",
  "approvalDecisions",
  "objections",
  "deliberationEntries",
  "workItemVersions",
  "workspaceArchiveRecords",
  "auditLogs",
  "events",
  "workflowJobs",
  "notifications",
];

const AUDIT_SQL = `
SELECT
  w.id,
  w.slug,
  w.name,
  COUNT(DISTINCT sr.id) AS spend_count,
  COUNT(DISTINCT la.id) AS ledger_account_count,
  COUNT(DISTINCT le.id) AS ledger_entry_count,
  COUNT(DISTINCT sc.id) AS spend_comment_count,
  MAX(GREATEST(
    COALESCE(sr."updatedAt", 'epoch'),
    COALESCE(la."updatedAt", 'epoch'),
    COALESCE(le."createdAt", 'epoch'),
    COALESCE(sc."createdAt", 'epoch')
  )) AS last_activity_at
FROM "Workspace" w
LEFT JOIN "SpendRequest" sr ON sr."workspaceId" = w.id
LEFT JOIN "LedgerAccount" la ON la."workspaceId" = w.id
LEFT JOIN "LedgerEntry" le ON le."workspaceId" = w.id
LEFT JOIN "SpendComment" sc ON sc."spendId" = sr.id
GROUP BY w.id, w.slug, w.name
HAVING
  COUNT(DISTINCT sr.id) > 0 OR
  COUNT(DISTINCT la.id) > 0 OR
  COUNT(DISTINCT le.id) > 0 OR
  COUNT(DISTINCT sc.id) > 0
ORDER BY last_activity_at DESC;
`;

function usage() {
  return [
    "Usage:",
    "  node scripts/legacy-finance-archive.mjs audit",
    "  node scripts/legacy-finance-archive.mjs export --workspace <id-or-slug> --out-dir .artifacts/legacy-finance-archive",
    "",
    "The audit prints aggregate counts only. Export writes row-level JSON files to the local output directory.",
  ].join("\n");
}

export function parseArgs(argv) {
  const [command = "audit", ...rest] = argv;
  const args = {
    command,
    workspace: null,
    outDir: DEFAULT_OUT_DIR,
    pretty: true,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--workspace") args.workspace = rest[++index] ?? null;
    else if (arg === "--out-dir") args.outDir = rest[++index] ?? null;
    else if (arg === "--compact") args.pretty = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!["audit", "export"].includes(args.command)) {
    throw new Error(`Unknown command: ${args.command}`);
  }
  if (args.command === "export" && !args.workspace?.trim()) {
    throw new Error("Export requires --workspace <id-or-slug>.");
  }
  if (args.command === "export" && !args.outDir?.trim()) {
    throw new Error("Export requires --out-dir.");
  }
  return args;
}

function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

function toJsonSafe(value) {
  return JSON.parse(JSON.stringify(value, jsonReplacer));
}

function asCount(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10) || 0;
  return 0;
}

function asIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function safePathPart(value) {
  return String(value ?? "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "unknown";
}

export function normalizeAuditRows(rows) {
  return (rows ?? []).map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    spendCount: asCount(row.spend_count),
    ledgerAccountCount: asCount(row.ledger_account_count),
    ledgerEntryCount: asCount(row.ledger_entry_count),
    spendCommentCount: asCount(row.spend_comment_count),
    lastActivityAt: asIso(row.last_activity_at),
  }));
}

async function withReadOnlyTransaction(prisma, callback) {
  if (!prisma.$transaction) {
    return callback(prisma);
  }
  return prisma.$transaction(async (tx) => {
    if (tx.$executeRawUnsafe) {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    }
    return callback(tx);
  });
}

export async function auditLegacyFinance({ prisma }) {
  return withReadOnlyTransaction(prisma, async (tx) => {
    const rows = await tx.$queryRawUnsafe(AUDIT_SQL);
    return normalizeAuditRows(rows);
  });
}

async function findMany(delegate, args) {
  if (!delegate?.findMany) return [];
  return delegate.findMany(args);
}

async function resolveWorkspace(tx, selector) {
  const value = selector?.trim();
  if (!value) throw new Error("workspace selector is required.");
  const workspace = await tx.workspace.findFirst({
    where: {
      OR: [
        { id: value },
        { slug: value },
      ],
    },
    select: {
      id: true,
      slug: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!workspace) {
    throw new Error(`Workspace not found for selector: ${value}`);
  }
  return workspace;
}

function ids(rows) {
  return rows.map((row) => row.id).filter(Boolean);
}

function spendEntityWhere(workspaceId, spendIds) {
  return {
    workspaceId,
    OR: [
      { entityType: "SpendRequest", entityId: { in: spendIds } },
      { entityType: "SPEND", entityId: { in: spendIds } },
    ],
  };
}

function legacyFinanceEntityWhere(workspaceId, spendIds, ledgerAccountIds) {
  return {
    workspaceId,
    OR: [
      { entityType: "SpendRequest", entityId: { in: spendIds } },
      { entityType: "SPEND", entityId: { in: spendIds } },
      { entityType: "LedgerAccount", entityId: { in: ledgerAccountIds } },
    ],
  };
}

function legacyFinanceAggregateWhere(workspaceId, spendIds, ledgerAccountIds) {
  return {
    workspaceId,
    OR: [
      { aggregateType: "SpendRequest", aggregateId: { in: spendIds } },
      { aggregateType: "SPEND", aggregateId: { in: spendIds } },
      { aggregateType: "LedgerAccount", aggregateId: { in: ledgerAccountIds } },
    ],
  };
}

function legacyFinanceNotificationWhere(workspaceId, spendIds, ledgerAccountIds) {
  return {
    workspaceId,
    OR: [
      { entityType: "SpendRequest", entityId: { in: spendIds } },
      { entityType: "SPEND", entityId: { in: spendIds } },
      { entityType: "LedgerAccount", entityId: { in: ledgerAccountIds } },
    ],
  };
}

export async function buildLegacyFinanceArchive({ prisma, workspaceSelector, generatedAt = new Date() }) {
  return withReadOnlyTransaction(prisma, async (tx) => {
    const workspace = await resolveWorkspace(tx, workspaceSelector);
    const [ledgerAccounts, ledgerEntries, spendRequests] = await Promise.all([
      findMany(tx.ledgerAccount, {
        where: { workspaceId: workspace.id },
        orderBy: { id: "asc" },
      }),
      findMany(tx.ledgerEntry, {
        where: { workspaceId: workspace.id },
        orderBy: [{ effectiveAt: "asc" }, { id: "asc" }],
      }),
      findMany(tx.spendRequest, {
        where: { workspaceId: workspace.id },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      }),
    ]);

    const spendIds = ids(spendRequests);
    const ledgerAccountIds = ids(ledgerAccounts);

    const [
      spendProposalLinks,
      spendComments,
      approvalFlows,
      deliberationEntries,
      workItemVersions,
      workspaceArchiveRecords,
      auditLogs,
      events,
      notifications,
    ] = await Promise.all([
      spendIds.length ? findMany(tx.spendProposalLink, {
        where: { spendId: { in: spendIds } },
        orderBy: { id: "asc" },
      }) : [],
      spendIds.length ? findMany(tx.spendComment, {
        where: { spendId: { in: spendIds } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }) : [],
      spendIds.length ? findMany(tx.approvalFlow, {
        where: { workspaceId: workspace.id, subjectType: "SPEND", subjectId: { in: spendIds } },
        orderBy: { id: "asc" },
      }) : [],
      spendIds.length ? findMany(tx.deliberationEntry, {
        where: { workspaceId: workspace.id, parentType: "SPEND", parentId: { in: spendIds } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }) : [],
      spendIds.length ? findMany(tx.workItemVersion, {
        where: spendEntityWhere(workspace.id, spendIds),
        orderBy: [{ entityId: "asc" }, { version: "asc" }],
      }) : [],
      (spendIds.length || ledgerAccountIds.length) ? findMany(tx.workspaceArchiveRecord, {
        where: legacyFinanceEntityWhere(workspace.id, spendIds, ledgerAccountIds),
        orderBy: [{ archivedAt: "asc" }, { id: "asc" }],
      }) : [],
      (spendIds.length || ledgerAccountIds.length) ? findMany(tx.auditLog, {
        where: legacyFinanceEntityWhere(workspace.id, spendIds, ledgerAccountIds),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }) : [],
      (spendIds.length || ledgerAccountIds.length) ? findMany(tx.event, {
        where: legacyFinanceAggregateWhere(workspace.id, spendIds, ledgerAccountIds),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }) : [],
      (spendIds.length || ledgerAccountIds.length) ? findMany(tx.notification, {
        where: legacyFinanceNotificationWhere(workspace.id, spendIds, ledgerAccountIds),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }) : [],
    ]);

    const flowIds = ids(approvalFlows);
    const eventIds = ids(events);
    const [approvalDecisions, objections, workflowJobs] = await Promise.all([
      flowIds.length ? findMany(tx.approvalDecision, {
        where: { flowId: { in: flowIds } },
        orderBy: [{ flowId: "asc" }, { id: "asc" }],
      }) : [],
      flowIds.length ? findMany(tx.objection, {
        where: { flowId: { in: flowIds } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }) : [],
      eventIds.length ? findMany(tx.workflowJob, {
        where: { workspaceId: workspace.id, eventId: { in: eventIds } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }) : [],
    ]);

    const tables = {
      ledgerAccounts,
      ledgerEntries,
      spendRequests,
      spendProposalLinks,
      spendComments,
      approvalFlows,
      approvalDecisions,
      objections,
      deliberationEntries,
      workItemVersions,
      workspaceArchiveRecords,
      auditLogs,
      events,
      workflowJobs,
      notifications,
    };
    const counts = Object.fromEntries(
      LEGACY_FINANCE_TABLE_KEYS.map((key) => [key, tables[key]?.length ?? 0]),
    );

    return toJsonSafe({
      manifest: {
        schemaVersion: LEGACY_FINANCE_ARCHIVE_VERSION,
        generatedAt,
        source: "corgtex-legacy-finance",
        workspace,
        counts,
      },
      tables,
    });
  });
}

export async function writeLegacyFinanceArchive({ archive, outDir, pretty = true }) {
  const workspace = archive.manifest.workspace;
  const workspaceDir = path.join(
    outDir,
    `${safePathPart(workspace.slug)}-${safePathPart(workspace.id)}`,
  );
  await mkdir(workspaceDir, { recursive: true });

  const spaces = pretty ? 2 : 0;
  const files = [];
  async function writeJsonFile(fileName, payload) {
    const filePath = path.join(workspaceDir, fileName);
    await writeFile(filePath, `${JSON.stringify(payload, null, spaces)}\n`, "utf8");
    files.push(filePath);
  }

  await writeJsonFile("manifest.json", archive.manifest);
  for (const key of LEGACY_FINANCE_TABLE_KEYS) {
    await writeJsonFile(`${key}.json`, archive.tables[key] ?? []);
  }

  return {
    workspaceDir,
    files,
    counts: archive.manifest.counts,
  };
}

export async function exportLegacyFinanceArchive({ prisma, workspaceSelector, outDir, pretty = true, generatedAt = new Date() }) {
  const archive = await buildLegacyFinanceArchive({ prisma, workspaceSelector, generatedAt });
  const written = await writeLegacyFinanceArchive({ archive, outDir, pretty });
  return {
    workspace: archive.manifest.workspace,
    counts: archive.manifest.counts,
    workspaceDir: written.workspaceDir,
    files: written.files,
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
    return;
  }

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    if (args.command === "audit") {
      const rows = await auditLegacyFinance({ prisma });
      console.log(JSON.stringify({ rows }, null, args.pretty ? 2 : 0));
      return;
    }

    const result = await exportLegacyFinanceArchive({
      prisma,
      workspaceSelector: args.workspace,
      outDir: args.outDir,
      pretty: args.pretty,
    });
    console.log(JSON.stringify({
      workspace: result.workspace,
      counts: result.counts,
      workspaceDir: result.workspaceDir,
      files: result.files,
    }, null, args.pretty ? 2 : 0));
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
