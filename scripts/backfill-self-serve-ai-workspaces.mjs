#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import prismaPackage from "@prisma/client";

const { PrismaClient } = prismaPackage;

export const SELF_SERVE_AI_WORKSPACE_FLAGS = [
  "AI_WORKSPACES",
  "OPENWORK_DEFAULT",
  "EXECUTION_PACKETS",
];

function usage(exitCode = 1) {
  const message = [
    "Usage:",
    "  node scripts/backfill-self-serve-ai-workspaces.mjs [--apply] [--limit <count>]",
    "",
    "Dry-run is the default. Use --apply to enable free AI workspace/MCP setup for active self-serve trials.",
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

export function selfServeAiWorkspaceWhere(now = new Date()) {
  return {
    plan: "TRIAL",
    procurementTrials: {
      some: {
        status: "ACTIVE",
        trialExpiresAt: { gt: now },
      },
    },
    OR: SELF_SERVE_AI_WORKSPACE_FLAGS.flatMap((flag) => [
      { featureFlags: { none: { flag } } },
      { featureFlags: { some: { flag, enabled: false } } },
    ]),
  };
}

function flagMap(workspace) {
  return new Map((workspace.featureFlags ?? []).map((flag) => [flag.flag, flag]));
}

function missingFlags(workspace) {
  const flags = flagMap(workspace);
  return SELF_SERVE_AI_WORKSPACE_FLAGS.filter((flag) => !flags.get(flag)?.enabled);
}

function summarizeWorkspace(workspace) {
  return {
    id: workspace.id,
    slug: workspace.slug,
    missingFlags: missingFlags(workspace),
  };
}

export async function findSelfServeAiWorkspaceBackfillWorkspaces(prisma, params = {}) {
  const now = params.now ?? new Date();
  return prisma.workspace.findMany({
    where: selfServeAiWorkspaceWhere(now),
    orderBy: { createdAt: "asc" },
    ...(params.limit ? { take: params.limit } : {}),
    select: {
      id: true,
      slug: true,
      featureFlags: {
        where: { flag: { in: SELF_SERVE_AI_WORKSPACE_FLAGS } },
        select: { flag: true, enabled: true },
      },
    },
  });
}

export async function backfillSelfServeAiWorkspaces(prisma, params = {}) {
  const workspaces = await findSelfServeAiWorkspaceBackfillWorkspaces(prisma, params);
  const targets = workspaces
    .map((workspace) => ({ workspace, flags: missingFlags(workspace) }))
    .filter((target) => target.flags.length > 0);
  let updated = 0;

  if (params.apply) {
    for (const target of targets) {
      for (const flag of target.flags) {
        await prisma.workspaceFeatureFlag.upsert({
          where: { workspaceId_flag: { workspaceId: target.workspace.id, flag } },
          update: { enabled: true },
          create: { workspaceId: target.workspace.id, flag, enabled: true },
        });
        updated += 1;
      }
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
    console.log(JSON.stringify(await backfillSelfServeAiWorkspaces(prisma, parseArgs(process.argv.slice(2))), null, 2));
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
