import { isDeepStrictEqual } from "node:util";
import { Prisma, type Document, type KnowledgeAccessDomain } from "@prisma/client";
import { mcpCredentialVersion, mcpScopesHash, prisma, type AppActor } from "@corgtex/shared";
import { assertMcpOriginActive, getMcpOrigin } from "../../shared/src/mcp-context";
import { requireWorkspaceMembership } from "./auth";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { lockBrainSourceLink } from "./brain-source-links";
import { invariant } from "./errors";
import { appendEvents } from "./events";
import { lockFinanceImportArtifactOwnership } from "./finance-import-artifact-ownership";
import { assertArtifactInputWriteFence, captureArtifactInputProof, captureImmutableArtifactInputProof,
  inspectStoredArtifactInputDependencies, isArtifactInputProofReadable, preserveUnknownArtifactInputSnapshot,
  recordArtifactInputLineage, sealArtifactInputActor } from "./source-lineage";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const string = (metadata: Record<string, unknown>, key: string) => typeof metadata[key] === "string" ? metadata[key] as string : null;

/** Every semantic field comes from the independently proven Document. */
function documentSourceProjection(document: Document, sourceType: "DOC" | "FILE_UPLOAD") {
  const metadata = record(document.metadata) ? document.metadata : {};
  const size = typeof metadata.sizeBytes === "number" && Number.isSafeInteger(metadata.sizeBytes) && metadata.sizeBytes >= 0
    ? metadata.sizeBytes : null;
  return { title: document.title, content: [document.title, document.textContent].join("\n\n"), channel: document.source,
    tier: 2, externalId: null, absorbedAt: null, ingestionGuidanceMd: string(metadata, "ingestionGuidanceMd"),
    fileStorageKey: sourceType === "FILE_UPLOAD" ? document.storageKey : null,
    fileMimeType: sourceType === "FILE_UPLOAD" ? document.mimeType : null,
    fileName: sourceType === "FILE_UPLOAD" ? string(metadata, "fileName") : null,
    fileSizeBytes: sourceType === "FILE_UPLOAD" ? size : null,
    metadata: { documentId: document.id, storageKey: document.storageKey, mimeType: document.mimeType,
      ...(string(metadata, "sourceUrl") ? { sourceUrl: string(metadata, "sourceUrl") } : {}) } as Prisma.InputJsonObject };
}

/** Rebuild an established copied document source, never certify its previous bytes. */
export async function rebuildDocumentBrainSource(actor: AppActor, params: { workspaceId: string; sourceId: string }) {
  sealArtifactInputActor(actor);
  params = Object.freeze({ ...params });
  return prisma.$transaction(async tx => {
    await lockBrainSourceLink(tx, params.sourceId);
    await tx.$queryRaw`SELECT id FROM "BrainSource" WHERE id = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    // Admission reads policy and a typed binding, not old semantic fields.
    const headers = await tx.$queryRaw<Array<{ id: string; workspaceId: string; sourceType: string;
      accessDomain: KnowledgeAccessDomain; authorMemberId: string | null; documentId: string | null; bindingMalformed: boolean }>>`
      SELECT id, "workspaceId", "sourceType"::text, "accessDomain"::text, "authorMemberId",
      CASE WHEN "sourceType" IN ('DOC', 'FILE_UPLOAD') AND jsonb_typeof(metadata->'documentId') = 'string'
        THEN metadata->>'documentId' ELSE NULL END AS "documentId",
      CASE WHEN metadata ? 'documentId' AND ("sourceType" NOT IN ('DOC', 'FILE_UPLOAD')
        OR jsonb_typeof(metadata->'documentId') IS DISTINCT FROM 'string') THEN true ELSE false END AS "bindingMalformed"
      FROM "BrainSource" WHERE id = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} AND "archivedAt" IS NULL`;
    const source = headers[0];
    invariant(source && ["DOC", "FILE_UPLOAD"].includes(source.sourceType) && !source.bindingMalformed && source.documentId,
      409, "MANUAL_REBUILD_REQUIRED", "A verified document-source recipe is required.");
    const documentId = source.documentId;
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${documentId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    await assertArtifactInputWriteFence(tx);
    const membership = await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx });
    const origin = getMcpOrigin();
    if (origin) {
      await assertMcpOriginActive(tx, origin, params.workspaceId);
      if (actor.kind === "user") {
        const token = origin.kind === "oauth" ? await tx.mcpOAuthAccessToken.findUnique({ where: { id: origin.id },
          select: { userId: true, workspaceId: true, scopes: true } }) : null;
        invariant(token?.userId === actor.user.id && token.workspaceId === params.workspaceId && ["brain:write", ...(source.accessDomain === "FINANCE" ? ["finance:write"] : [])].every(scope => token.scopes.includes(scope)),
          403, "MCP_AUTHORIZATION_REVOKED", "Current source write consent is required.");
      } else invariant(origin.kind === "agent" && origin.id === actor.credentialId && origin.credentialVersion === actor.credentialVersion
        && origin.scopeHash === mcpScopesHash(actor.scopes ?? []), 403, "MCP_AUTHORIZATION_REVOKED", "The source control principal changed.");
    }
    if (actor.kind === "user") invariant(membership?.role === "ADMIN" || membership?.id === source.authorMemberId,
      403, "FORBIDDEN", "Only the current source author or workspace administrator may rebuild it.");
    else {
      const credential = actor.authProvider === "credential" && actor.credentialId && actor.credentialVersion
        ? await tx.agentCredential.findFirst({ where: { id: actor.credentialId, workspaceId: params.workspaceId, isActive: true },
          select: { tokenHash: true, scopes: true } }) : null;
      invariant(credential && mcpCredentialVersion(credential.tokenHash) === actor.credentialVersion
        && mcpScopesHash(credential.scopes) === mcpScopesHash(actor.scopes ?? []) && credential.scopes.includes("brain:write")
        && (source.accessDomain !== "FINANCE" || credential.scopes.includes("finance:write")),
      403, "MCP_AUTHORIZATION_REVOKED", "Current authenticated source write authority is required.");
    }
    invariant((await resolveKnowledgeAccessDomains(actor, params.workspaceId, tx)).includes(source.accessDomain),
      403, "FORBIDDEN", "The source domain is not currently permitted.");
    const known = await tx.artifactInputLineage.findFirst({ where: { workspaceId: params.workspaceId,
      artifactType: "BrainSource", artifactId: source.id, origin: { in: ["HUMAN_ORIGINAL", "NATIVE_ORIGINAL", "DERIVED"] } }, orderBy: { revision: "desc" } });
    invariant(!known || !["HUMAN_ORIGINAL", "NATIVE_ORIGINAL"].includes(known.origin),
      409, "MANUAL_REBUILD_REQUIRED", "Original sources remain unchanged.");
    for (const [kind, id] of [["BRAIN_SOURCE", source.id], ["DOCUMENT", documentId]] as const) {
      await lockFinanceImportArtifactOwnership(tx, { workspaceId: params.workspaceId, kind, id });
      invariant(!await tx.financeImportBatch.findFirst({ where: { workspaceId: params.workspaceId,
        [kind === "DOCUMENT" ? "documentId" : "brainSourceId"]: id }, select: { id: true } }),
      409, "FINANCE_IMPORT_ARTIFACT_MANAGED", "Finance imports use their own rebuild path.");
    }
    const document = await tx.document.findFirst({ where: { id: documentId, workspaceId: params.workspaceId, archivedAt: null } });
    invariant(document && document.textContent?.trim(), 409, "MANUAL_REBUILD_REQUIRED", "The current document has no source text.");
    const documentProof = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "Document", id: document.id, snapshot: document }], tx);
    const ancestry = await inspectStoredArtifactInputDependencies(tx, params.workspaceId, documentProof);
    invariant(ancestry.complete && !ancestry.roots.some(root => root.kind === "BrainSource" && root.id === source.id),
      409, "UNKNOWN_LINEAGE", "The document cannot reuse the source being rebuilt.");
    const roots = await captureImmutableArtifactInputProof(actor, params.workspaceId, documentProof, tx);
    const data = documentSourceProjection(document, source.sourceType as "DOC" | "FILE_UPLOAD");
    // This sole read of old bytes is confined to UNKNOWN history storage. They
    // never become copy inputs or a new original/derived proof.
    const before = await tx.brainSource.findUniqueOrThrow({ where: { id: source.id } });
    await preserveUnknownArtifactInputSnapshot(tx, params.workspaceId, { kind: "BrainSource", id: source.id }, before);
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots, tx), 409, "SOURCE_CHANGED", "Document inputs changed.");
    const updated = await tx.brainSource.update({ where: { id: source.id }, data });
    invariant(updated.sourceType === source.sourceType && updated.authorMemberId === source.authorMemberId
      && updated.accessDomain === source.accessDomain && Object.entries(data).every(([field, value]) =>
        isDeepStrictEqual(updated[field as keyof typeof updated], value)),
    409, "SOURCE_CHANGED", "The persisted source does not match its complete document inputs.");
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainSource", id: source.id }, content: updated, origin: "DERIVED", inputs: [], inheritedRoots: roots });
    await appendEvents(tx, [{ workspaceId: params.workspaceId, type: "brain-source.created", aggregateType: "BrainSource",
      aggregateId: source.id, payload: { sourceId: source.id } }, { workspaceId: params.workspaceId,
      type: "source-lineage.changed", aggregateType: "BrainSource", aggregateId: source.id, payload: { kind: "BrainSource", id: source.id } }]);
    await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "BrainSource", id: updated.id, snapshot: updated }], tx);
    await assertArtifactInputWriteFence(tx);
    return updated;
  }, { maxWait: 5_000, timeout: 120_000 });
}
