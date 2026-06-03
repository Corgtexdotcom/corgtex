#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import prismaPackage from "@prisma/client";

const { PrismaClient } = prismaPackage;

const FEATURE_FLAG = "MEETING_RECORDERS";
const STRIPE_PAYG_RECORDER_ACCESS_KEY = "stripePaygAiRecorderAccess";
const STRIPE_PAYG_RECORDER_ACCESS_GRANTED_AT_KEY = "stripePaygAiRecorderAccessGrantedAt";

function usage(exitCode = 1) {
  const message = [
    "Usage:",
    "  node scripts/backfill-paid-recorder-access.mjs [--apply] [--limit <count>]",
    "",
    "Dry-run is the default. Use --apply to enable meeting recorder setup for active PAYG workspaces.",
  ].join("\n");
  (exitCode === 0 ? process.stdout : process.stderr).write(`${message}\n`);
  process.exit(exitCode);
}

export function parseArgs(argv) {
  const args = { apply: false, limit: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--help" || entry === "-h") usage(0);
    if (entry === "--apply") {
      args.apply = true;
      continue;
    }
    const inlineLimit = entry.startsWith("--limit=") ? entry.slice("--limit=".length) : null;
    if (entry === "--limit" || inlineLimit !== null) {
      const limit = Number(inlineLimit ?? argv[index + 1]);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer.");
      args.limit = limit;
      index += inlineLimit === null ? 1 : 0;
      continue;
    }
    throw new Error(`Unknown argument: ${entry}`);
  }
  return args;
}

export function paidRecorderWorkspaceWhere() {
  return {
    plan: "PAYG_AI",
    billingProfile: { is: { billingStatus: "ACTIVE" } },
    OR: [
      { featureFlags: { none: { flag: FEATURE_FLAG } } },
      { featureFlags: { some: { flag: FEATURE_FLAG, enabled: false } } },
    ],
  };
}

function recorderFlag(workspace) {
  return workspace.featureFlags?.[0] ?? null;
}

function recorderAccessConfig(config) {
  return {
    ...(config && typeof config === "object" && !Array.isArray(config) ? config : {}),
    [STRIPE_PAYG_RECORDER_ACCESS_KEY]: true,
    [STRIPE_PAYG_RECORDER_ACCESS_GRANTED_AT_KEY]: new Date().toISOString(),
  };
}

function summarizeWorkspace(workspace) {
  const flag = recorderFlag(workspace);
  return {
    id: workspace.id,
    slug: workspace.slug,
    recorderAccessEnabled: Boolean(flag?.enabled),
    needsBackfill: !flag?.enabled,
  };
}

export async function findPaidRecorderBackfillWorkspaces(prisma, params = {}) {
  return prisma.workspace.findMany({
    where: paidRecorderWorkspaceWhere(),
    orderBy: { createdAt: "asc" },
    ...(params.limit ? { take: params.limit } : {}),
    select: {
      id: true,
      slug: true,
      featureFlags: {
        where: { flag: FEATURE_FLAG },
        select: { enabled: true, config: true },
      },
    },
  });
}

export async function backfillPaidRecorderAccess(prisma, params = {}) {
  const workspaces = await findPaidRecorderBackfillWorkspaces(prisma, params);
  const targets = workspaces.filter((workspace) => !recorderFlag(workspace)?.enabled);
  let updated = 0;

  if (params.apply) {
    for (const workspace of targets) {
      const config = recorderAccessConfig(recorderFlag(workspace)?.config);
      await prisma.workspaceFeatureFlag.upsert({
        where: { workspaceId_flag: { workspaceId: workspace.id, flag: FEATURE_FLAG } },
        update: { enabled: true, config },
        create: { workspaceId: workspace.id, flag: FEATURE_FLAG, enabled: true, config },
      });
      updated += 1;
    }
  }

  return {
    dryRun: !params.apply,
    scanned: workspaces.length,
    targets: targets.length,
    updated,
    workspaces: workspaces.map(summarizeWorkspace),
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log(JSON.stringify(await backfillPaidRecorderAccess(prisma, parseArgs(process.argv.slice(2))), null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
