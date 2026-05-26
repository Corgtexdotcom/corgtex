import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function argValue(name) {
  const equalsArg = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (equalsArg) return equalsArg.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : null;
}

async function resolveWorkspace(value) {
  if (!value) {
    throw new Error("Usage: node scripts/backfill-document-brain-sources.mjs --workspace <id-or-slug> [--apply]");
  }

  const workspace = await prisma.workspace.findFirst({
    where: {
      OR: [
        { id: value },
        { slug: value },
      ],
    },
    select: { id: true, slug: true, name: true },
  });

  if (!workspace) {
    throw new Error(`Workspace not found: ${value}`);
  }

  return workspace;
}

function metadataRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function main() {
  const apply = process.argv.includes("--apply");
  const workspace = await resolveWorkspace(argValue("--workspace"));
  const documents = await prisma.document.findMany({
    where: {
      workspaceId: workspace.id,
      archivedAt: null,
      textContent: { not: null },
    },
    select: {
      id: true,
      title: true,
      source: true,
      storageKey: true,
      mimeType: true,
      textContent: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const existingSources = await prisma.brainSource.findMany({
    where: {
      workspaceId: workspace.id,
      sourceType: { in: ["DOC", "FILE_UPLOAD"] },
      archivedAt: null,
    },
    select: { id: true, metadata: true },
  });
  const existingDocumentIds = new Set(
    existingSources
      .map((source) => metadataRecord(source.metadata).documentId)
      .filter((documentId) => typeof documentId === "string"),
  );
  const missing = documents.filter((document) => (
    document.textContent?.trim() && !existingDocumentIds.has(document.id)
  ));

  if (!apply) {
    console.log(JSON.stringify({
      dryRun: true,
      workspace: workspace.slug,
      textDocuments: documents.length,
      missingBrainSources: missing.length,
    }, null, 2));
    return;
  }

  let created = 0;
  for (const document of missing) {
    await prisma.$transaction(async (tx) => {
      const source = await tx.brainSource.create({
        data: {
          workspaceId: workspace.id,
          sourceType: "DOC",
          tier: 2,
          title: document.title,
          content: [document.title, document.textContent?.trim()].filter(Boolean).join("\n\n"),
          channel: document.source,
          metadata: {
            documentId: document.id,
            storageKey: document.storageKey,
            mimeType: document.mimeType,
            backfilledBy: "backfill-document-brain-sources",
          },
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorUserId: null,
          action: "brain-source.created",
          entityType: "BrainSource",
          entityId: source.id,
          meta: {
            sourceType: source.sourceType,
            tier: source.tier,
            documentId: document.id,
            backfilled: true,
          },
        },
      });

      await tx.event.create({
        data: {
          workspaceId: workspace.id,
          type: "brain-source.created",
          aggregateType: "BrainSource",
          aggregateId: source.id,
          payload: { sourceId: source.id },
        },
      });
    });
    created += 1;
  }

  console.log(JSON.stringify({
    dryRun: false,
    workspace: workspace.slug,
    textDocuments: documents.length,
    missingBrainSources: missing.length,
    createdBrainSources: created,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
