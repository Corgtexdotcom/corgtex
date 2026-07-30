#!/usr/bin/env tsx
import type { KnowledgeSourceType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import {
  createOrUpdateAzureKnowledgeIndex,
  mapKnowledgeChunkToAzureDocument,
  uploadAzureKnowledgeDocuments,
  syncAzureKnowledgeSource,
  type AzureKnowledgeChunkInput,
} from "@corgtex/knowledge";

type Args = {
  command: string;
  workspaceId?: string;
  dryRun: boolean;
  deleteStale: boolean;
};

let usedPrisma = false;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? "",
    dryRun: false,
    deleteStale: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace-id") {
      args.workspaceId = argv[++index];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--delete-stale") {
      args.deleteStale = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  return [
    "Usage:",
    "  npm run knowledge:azure-search -- setup-index",
    "  npm run knowledge:azure-search -- backfill [--workspace-id <id>] [--dry-run] [--delete-stale]",
  ].join("\n");
}

function asEmbedding(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => typeof entry === "number" ? entry : Number(entry))
    .filter((entry) => Number.isFinite(entry));
}

function sourceKey(chunk: Pick<AzureKnowledgeChunkInput, "workspaceId" | "sourceType" | "sourceId">) {
  return `${chunk.workspaceId}::${chunk.sourceType}::${chunk.sourceId}`;
}

async function backfill(args: Args) {
  usedPrisma = true;
  const rows = await prisma.knowledgeChunk.findMany({
    where: args.workspaceId ? { workspaceId: args.workspaceId } : undefined,
    orderBy: [
      { workspaceId: "asc" },
      { sourceType: "asc" },
      { sourceId: "asc" },
      { chunkIndex: "asc" },
    ],
    select: {
      id: true,
      workspaceId: true,
      sourceType: true,
      accessDomain: true,
      sourceId: true,
      sourceTitle: true,
      chunkIndex: true,
      content: true,
      embedding: true,
      metadata: true,
      sensitivity: true,
      createdAt: true,
    },
  });

  const chunks: AzureKnowledgeChunkInput[] = rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    sourceType: row.sourceType as KnowledgeSourceType,
    accessDomain: row.accessDomain,
    sourceId: row.sourceId,
    sourceTitle: row.sourceTitle,
    chunkIndex: row.chunkIndex,
    content: row.content,
    embedding: asEmbedding(row.embedding),
    metadata: row.metadata,
    sensitivity: row.sensitivity,
    createdAt: row.createdAt,
  }));

  const sourceCount = new Set(chunks.map(sourceKey)).size;
  if (args.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      workspaceId: args.workspaceId ?? null,
      chunks: chunks.length,
      sources: sourceCount,
      deleteStale: args.deleteStale,
    }));
    return;
  }

  await createOrUpdateAzureKnowledgeIndex();

  if (args.deleteStale) {
    const groups = new Map<string, AzureKnowledgeChunkInput[]>();
    for (const chunk of chunks) {
      const key = sourceKey(chunk);
      groups.set(key, [...(groups.get(key) ?? []), chunk]);
    }

    let uploaded = 0;
    let deleted = 0;
    for (const group of groups.values()) {
      const first = group[0];
      const result = await syncAzureKnowledgeSource({
        workspaceId: first.workspaceId,
        sourceType: first.sourceType,
        sourceId: first.sourceId,
        chunks: group,
      });
      uploaded += result.uploaded;
      deleted += result.deleted;
    }
    console.log(JSON.stringify({ workspaceId: args.workspaceId ?? null, chunks: chunks.length, sources: sourceCount, uploaded, deleted }));
    return;
  }

  const documents = chunks.map(mapKnowledgeChunkToAzureDocument);
  const result = await uploadAzureKnowledgeDocuments(documents);
  console.log(JSON.stringify({ workspaceId: args.workspaceId ?? null, chunks: chunks.length, sources: sourceCount, uploaded: result.uploaded, deleted: 0 }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command) {
    throw new Error(usage());
  }

  if (args.command === "setup-index") {
    if (args.dryRun) {
      throw new Error("--dry-run is not supported for setup-index.");
    }
    await createOrUpdateAzureKnowledgeIndex();
    console.log(JSON.stringify({ setupIndex: true }));
    return;
  }

  if (args.command === "backfill") {
    await backfill(args);
    return;
  }

  if (args.command === "delete-source") {
    throw new Error("delete-source is intentionally not exposed; use source sync or backfill --delete-stale.");
  }

  throw new Error(usage());
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (usedPrisma) {
      await prisma.$disconnect?.();
    }
  });
