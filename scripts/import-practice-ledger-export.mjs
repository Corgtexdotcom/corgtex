#!/usr/bin/env node
/**
 * D4 of the Practice Ledger tier-3 -> tier-2 cutover: the data import path.
 *
 * Consumes a Corgtex-shaped PortableModule export from the Practice Ledger
 * satellite and idempotently loads it into the native `PracticeProject` table.
 * Idempotency key is `(workspaceId, sourceSatelliteId)` (the stable Practice
 * Ledger id), so re-running the import updates rather than duplicates.
 *
 * Usage:
 *   node scripts/import-practice-ledger-export.mjs --file <export.json> --workspace <workspaceId> [--apply]
 *
 * The export file is either a PortableRecordBatch ({ moduleKey, schemaVersion,
 * records }) or a bare array of records. Without --apply it is a dry run.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

export const PRACTICE_FINANCE_MODULE_KEY = "practice-ledger";
export const PRACTICE_FINANCE_SCHEMA_VERSION = "1";

const VALID_STATUSES = new Set(["ACTIVE", "ON_HOLD", "CLOSED"]);

export function parseArgs(argv) {
  const args = { file: null, workspaceId: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--file") args.file = argv[++i] ?? null;
    else if (arg === "--workspace") args.workspaceId = argv[++i] ?? null;
    else if (arg === "--apply") args.apply = true;
  }
  return args;
}

function toCents(value) {
  if (value == null) return 0;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function toBpsOrNull(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > 10000) return null;
  return rounded;
}

function normalizeStatus(value) {
  const normalized = String(value ?? "ACTIVE").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return VALID_STATUSES.has(normalized) ? normalized : "ACTIVE";
}

/**
 * Normalize one export record into PracticeProject fields, or return null when
 * the record is missing a stable id / required identity (so it is skipped).
 */
export function parsePortableRecord(record) {
  if (!record || typeof record !== "object") return null;
  const sourceSatelliteId = String(record.id ?? record.sourceSatelliteId ?? "").trim();
  const code = String(record.code ?? "").trim();
  const name = String(record.name ?? "").trim();
  const clientName = String(record.clientName ?? record.client ?? "").trim();
  if (!sourceSatelliteId || !code || !name || !clientName) return null;

  return {
    sourceSatelliteId,
    code,
    name,
    clientName,
    status: normalizeStatus(record.status),
    poValueCents: toCents(record.poValueCents),
    serviceBudgetCents: toCents(record.serviceBudgetCents),
    expenseBudgetCents: toCents(record.expenseBudgetCents),
    usedCents: toCents(record.usedCents),
    weeklyBurnCents: toCents(record.weeklyBurnCents),
    targetMarginBps: toBpsOrNull(record.targetMarginBps),
    currentMarginBps: toBpsOrNull(record.currentMarginBps),
  };
}

/** Split records into importable rows and skipped (invalid) records. */
export function planImport(records) {
  const valid = [];
  const skipped = [];
  for (const record of records ?? []) {
    const parsed = parsePortableRecord(record);
    if (parsed) valid.push(parsed);
    else skipped.push(record);
  }
  return { valid, skipped };
}

function batchRecords(batch) {
  if (Array.isArray(batch)) return batch;
  if (batch && Array.isArray(batch.records)) return batch.records;
  return [];
}

/**
 * Idempotently upsert a Practice Ledger export batch into PracticeProject.
 * Dry run (apply=false) plans only and writes nothing.
 */
export async function importPracticeLedgerExport({ prisma, workspaceId, batch, apply = false }) {
  if (!workspaceId) throw new Error("workspaceId is required.");
  const { valid, skipped } = planImport(batchRecords(batch));

  let imported = 0;
  if (apply) {
    for (const row of valid) {
      const { sourceSatelliteId, ...fields } = row;
      try {
        await prisma.practiceProject.upsert({
          where: { workspaceId_sourceSatelliteId: { workspaceId, sourceSatelliteId } },
          update: fields,
          create: { workspaceId, sourceSatelliteId, ...fields },
        });
        imported += 1;
      } catch {
        // A code collision with a differently-sourced project, etc. - skip it.
        skipped.push(row);
      }
    }
  }

  return {
    dryRun: !apply,
    planned: valid.length,
    imported: apply ? imported : 0,
    skipped: skipped.length,
  };
}

async function main() {
  const { file, workspaceId, apply } = parseArgs(process.argv.slice(2));
  if (!file || !workspaceId) {
    console.error("Usage: node scripts/import-practice-ledger-export.mjs --file <export.json> --workspace <workspaceId> [--apply]");
    process.exit(1);
    return;
  }

  const raw = JSON.parse(readFileSync(file, "utf8"));
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const result = await importPracticeLedgerExport({ prisma, workspaceId, batch: raw, apply });
    console.log(JSON.stringify(result));
    if (result.dryRun) {
      console.error(`Dry run: ${result.planned} record(s) would import, ${result.skipped} skipped. Re-run with --apply to write.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
