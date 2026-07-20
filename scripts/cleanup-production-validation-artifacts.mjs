#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

import {
  INTERNAL_VALIDATION_WORKSPACE_SLUG,
  requireInternalValidationWorkspace,
} from "./lib/validation-workspace.mjs";

const PROD_VERIFY_PREFIX = "PROD-VERIFY ";
const SMOKE_BRIEFING_MODEL = "production-validation-fixture";
const ARCHIVE_REASON = "Production validation artifact cleanup.";

function requiredSelectorMessage() {
  return "Set at least one cleanup selector: --date-key=YYYY-MM-DD, --run-id=<run-id>, or --before=<ISO timestamp>.";
}

function parseFlag(argv, name) {
  const prefix = `--${name}=`;
  const value = argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : null;
}

function normalizeDateKey(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`date-key must use YYYY-MM-DD format, got: ${value}`);
  }
  return normalized;
}

function normalizeBefore(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`before must be a valid ISO timestamp, got: ${value}`);
  }
  return date;
}

function normalizeRunId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function parseCleanupArgs(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }

  const selectors = {
    dateKey: normalizeDateKey(parseFlag(argv, "date-key")),
    runId: normalizeRunId(parseFlag(argv, "run-id")),
    before: normalizeBefore(parseFlag(argv, "before")),
  };

  if (!selectors.dateKey && !selectors.runId && !selectors.before) {
    throw new Error(requiredSelectorMessage());
  }

  return {
    help: false,
    apply: argv.includes("--apply"),
    workspaceId: parseFlag(argv, "workspace-id"),
    workspaceSlug: parseFlag(argv, "workspace-slug") || INTERNAL_VALIDATION_WORKSPACE_SLUG,
    selectors,
  };
}

function validationTitleWhere({ dateKey, runId }) {
  const conditions = [{ title: { startsWith: dateKey ? `${PROD_VERIFY_PREFIX}${dateKey}` : PROD_VERIFY_PREFIX } }];
  if (runId) conditions.push({ title: { contains: runId } });
  return { AND: conditions };
}

function updatedBeforeWhere(before) {
  return before ? { updatedAt: { lt: before } } : {};
}

export function buildProductionValidationArtifactQueries(workspaceId, selectors) {
  const titleWhere = validationTitleWhere(selectors);
  const updatedAt = updatedBeforeWhere(selectors.before);

  const queries = {};
  if (selectors.dateKey || selectors.before) {
    queries.WorkspaceBriefing = {
      delegate: "workspaceBriefing",
      mode: "delete",
      where: {
        workspaceId,
        modelUsed: SMOKE_BRIEFING_MODEL,
        ...(selectors.dateKey ? { dateKey: selectors.dateKey } : {}),
        ...(selectors.before ? { generatedAt: { lt: selectors.before } } : {}),
      },
      select: { id: true, title: true, dateKey: true, generatedAt: true, modelUsed: true },
    };
  }

  return {
    ...queries,
    Action: {
      delegate: "action",
      mode: "archive",
      where: { workspaceId, archivedAt: null, ...titleWhere, ...updatedAt },
      select: { id: true, title: true, updatedAt: true, archivedAt: true },
    },
    Proposal: {
      delegate: "proposal",
      mode: "archive",
      where: { workspaceId, archivedAt: null, ...titleWhere, ...updatedAt },
      select: { id: true, title: true, updatedAt: true, archivedAt: true },
    },
    BrainArticle: {
      delegate: "brainArticle",
      mode: "archive",
      where: { workspaceId, archivedAt: null, ...titleWhere, ...updatedAt },
      select: { id: true, title: true, slug: true, updatedAt: true, archivedAt: true },
    },
  };
}

function summarizeRecord(record) {
  return {
    id: record.id,
    title: record.title ?? null,
    slug: record.slug ?? null,
    dateKey: record.dateKey ?? null,
    generatedAt: record.generatedAt instanceof Date ? record.generatedAt.toISOString() : record.generatedAt ?? null,
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : record.updatedAt ?? null,
  };
}

function countCandidates(candidates) {
  return Object.fromEntries(Object.entries(candidates).map(([type, records]) => [type, records.length]));
}

export async function findProductionValidationArtifactCandidates(prisma, workspace, selectors) {
  requireInternalValidationWorkspace(workspace, { purpose: "production validation artifact cleanup" });
  const queries = buildProductionValidationArtifactQueries(workspace.id, selectors);
  const entries = await Promise.all(Object.entries(queries).map(async ([type, query]) => {
    const records = await prisma[query.delegate].findMany({
      where: query.where,
      select: query.select,
      orderBy: { updatedAt: "asc" },
    });
    return [type, records.map(summarizeRecord)];
  }));
  const candidates = Object.fromEntries(entries);
  return {
    workspace: { id: workspace.id, slug: workspace.slug ?? null },
    selectors: {
      dateKey: selectors.dateKey,
      runId: selectors.runId,
      before: selectors.before ? selectors.before.toISOString() : null,
    },
    candidates,
    counts: countCandidates(candidates),
  };
}

async function applyCleanup(tx, candidates, now) {
  const results = {};
  const archiveData = {
    archivedAt: now,
    archiveReason: ARCHIVE_REASON,
  };

  for (const [type, records] of Object.entries(candidates)) {
    const ids = records.map((record) => record.id);
    if (ids.length === 0) {
      results[type] = 0;
      continue;
    }

    if (type === "WorkspaceBriefing") {
      const result = await tx.workspaceBriefing.deleteMany({ where: { id: { in: ids } } });
      results[type] = result.count;
    } else if (type === "Action") {
      const result = await tx.action.updateMany({ where: { id: { in: ids }, archivedAt: null }, data: archiveData });
      results[type] = result.count;
    } else if (type === "Proposal") {
      const result = await tx.proposal.updateMany({ where: { id: { in: ids }, archivedAt: null }, data: archiveData });
      results[type] = result.count;
    } else if (type === "BrainArticle") {
      const result = await tx.brainArticle.updateMany({ where: { id: { in: ids }, archivedAt: null }, data: archiveData });
      results[type] = result.count;
    }
  }

  return results;
}

export async function cleanupProductionValidationArtifacts(prisma, workspace, selectors, { apply = false, now = new Date() } = {}) {
  const report = await findProductionValidationArtifactCandidates(prisma, workspace, selectors);
  if (!apply) {
    return { ...report, mode: "dry-run", cleaned: {} };
  }

  const cleaned = await prisma.$transaction((tx) => applyCleanup(tx, report.candidates, now));
  return {
    ...report,
    mode: "apply",
    cleaned,
  };
}

async function resolveWorkspace(prisma, args) {
  const workspace = await prisma.workspace.findFirst({
    where: args.workspaceId ? { id: args.workspaceId } : { slug: args.workspaceSlug },
    select: { id: true, slug: true, name: true },
  });
  if (!workspace) throw new Error("Workspace not found for production validation artifact cleanup.");
  return requireInternalValidationWorkspace(workspace, { purpose: "production validation artifact cleanup" });
}

function usage() {
  return [
    "usage: node scripts/cleanup-production-validation-artifacts.mjs --date-key=YYYY-MM-DD [--apply]",
    "",
    "Dry-runs or applies cleanup for production validation-owned artifacts in corgtex-validation.",
    "",
    "Selectors:",
    "  --date-key=YYYY-MM-DD       clean records tagged for that validation date",
    "  --run-id=<run-id>           narrow PROD-VERIFY records to one validation run id",
    "  --before=<ISO timestamp>    clean validation-owned records older than this timestamp",
    "",
    "Safety:",
    "  --workspace-slug=<slug>     defaults to corgtex-validation",
    "  --workspace-id=<id>         optional exact workspace id",
    "  --apply                    perform cleanup; omitted mode is dry-run",
  ].join("\n");
}

async function main() {
  const args = parseCleanupArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const prisma = new PrismaClient();
  try {
    const workspace = await resolveWorkspace(prisma, args);
    const report = await cleanupProductionValidationArtifacts(prisma, workspace, args.selectors, { apply: args.apply });
    console.log(JSON.stringify(report, null, 2));
    if (!args.apply) {
      console.error("Dry run only. Re-run with --apply after reviewing the candidate list.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
