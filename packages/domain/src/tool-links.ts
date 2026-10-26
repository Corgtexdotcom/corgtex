import type { Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma } from "@corgtex/shared";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { actorUserIdForWorkspace } from "./auth";
import { recordAudit } from "./audit-trail";
import { requireWorkspaceOperation } from "./agent-operation-authorization";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { AppError, invariant } from "./errors";
import { findConversationToolLinkArchiveOutcome, recordConversationToolLinkArchiveOutcome,
  getConversationOperationOutcomeInputRoots } from "./conversation-operation-outcome";
import { getMcpToolInputRoots } from "./mcp-tool-input-context";
import { captureConversationInputReceipt, validateConversationInputReceipt, type ConversationInputReceipt } from "./conversation-lineage";
import { DigestReadRelease, mergeArtifactInputProofs } from "./digest-lineage";
import { prepareProducerLineage, finishProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, currentArtifactInputRoots, isArtifactInputProofReadable, lineageContentFingerprint, sealArtifactInputActor, type LineageKind, type LineageRoot } from "./source-lineage";
import {
  canEditToolLinkMetadata,
  canManageToolLinkCredential,
  requireToolLinkCredentialManager,
  requireToolLinkMetadataEditor,
} from "./collaborative-permissions";

const toolLinkSelect = {
  id: true,
  workspaceId: true,
  createdByUserId: true,
  title: true,
  url: true,
  category: true,
  descriptionMd: true,
  accessNotesMd: true,
  previewTitle: true,
  previewDescription: true,
  previewImageUrl: true,
  previewFaviconUrl: true,
  credentialLabel: true,
  credentialSecretEnc: true,
  archivedAt: true,
  archivedByUserId: true,
  archiveReason: true,
  createdAt: true,
  updatedAt: true,
  createdBy: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
  circleTags: {
    include: {
      circle: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.WorkspaceToolLinkSelect;

type ToolLinkRecord = Prisma.WorkspaceToolLinkGetPayload<{ select: typeof toolLinkSelect }>;

const toolLinkReceipts = new WeakMap<object, ConversationInputReceipt>();

/** An actor/workspace/payload-bound server receipt, rechecked on every use. */
export async function getWorkspaceToolLinkInputRoots(actor: AppActor, workspaceId: string, value: object) {
  const receipt = toolLinkReceipts.get(value);
  invariant(receipt, 409, "UNKNOWN_LINEAGE", "Tool link output has no trusted source receipt.");
  return validateConversationInputReceipt({ actor, workspaceId, value, receipt });
}

async function bindToolLinkOutput(actor: AppActor, workspaceId: string, value: object, roots: LineageRoot[], tx?: Prisma.TransactionClient) {
  toolLinkReceipts.set(value, await captureConversationInputReceipt({ actor, workspaceId, value, trustedRoots: roots, db: tx }));
}

async function captureToolLinkReader(actor: AppActor, workspaceId: string, membership: MembershipSummary | null | undefined,
  tx?: Prisma.TransactionClient) {
  return captureArtifactInputProof(actor, workspaceId, [
    { kind: "Workspace", id: workspaceId },
    ...(membership ? [{ kind: "Member" as const, id: membership.id, snapshot: { id: membership.id,
      userId: membership.userId, role: membership.role, isActive: membership.isActive } }] : []),
  ], tx);
}

function toolLinkInputSnapshot(kind: LineageKind, row: Record<string, unknown>) {
  return kind === "WorkspaceToolLink" && Array.isArray(row.circleTags) ? { ...row,
    circleTags: row.circleTags.map((tag) => ({ id: tag.id, toolLinkId: tag.toolLinkId, circleId: tag.circleId, createdAt: tag.createdAt })),
  } : row;
}

async function captureReadableToolLinkInputs<T extends { id: string }>(actor: AppActor, workspaceId: string,
  kind: LineageKind, records: T[], tx?: Prisma.TransactionClient, writtenRevision = false) {
  const admitted: T[] = [];
  const proofs = new Map<string, LineageRoot[]>();
  for (const row of records) {
    try {
      let roots: LineageRoot[];
      if (writtenRevision) {
        // The read observer retains the consumed old revision until its caller
        // rebases it. Bind the new revision separately without replacing that input.
        const inherited = await currentArtifactInputRoots(tx ?? prisma, workspaceId, { kind, id: row.id }, row);
        invariant(inherited, 409, "UNKNOWN_LINEAGE", "Tool link output has no complete stored lineage.");
        roots = mergeArtifactInputProofs([{ kind, id: row.id, fingerprint: lineageContentFingerprint(kind, row) }], inherited);
        invariant(await isArtifactInputProofReadable(actor, workspaceId, roots, tx), 409, "SOURCE_CHANGED", "Tool link output changed.");
      } else roots = await captureArtifactInputProof(actor, workspaceId, [{ kind, id: row.id, snapshot: toolLinkInputSnapshot(kind, row) }], tx);
      admitted.push(row);
      proofs.set(row.id, roots);
    } catch (error) {
      if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code)) throw error;
    }
  }
  return { records: admitted, roots: mergeArtifactInputProofs(...proofs.values()), proofs };
}

async function serializeReadableToolLinks(actor: AppActor, workspaceId: string,
  membership: MembershipSummary | null | undefined, links: ToolLinkRecord[], tx?: Prisma.TransactionClient) {
  const readerRoots = await captureToolLinkReader(actor, workspaceId, membership, tx);
  const admitted = await captureReadableToolLinkInputs(actor, workspaceId, "WorkspaceToolLink", links, tx, Boolean(tx));
  const [creators, circles] = await Promise.all([
    captureReadableToolLinkInputs(actor, workspaceId, "User", admitted.records.flatMap((link) => link.createdBy ? [link.createdBy] : []), tx),
    captureReadableToolLinkInputs(actor, workspaceId, "Circle", admitted.records.flatMap((link) => link.circleTags.map((tag) => tag.circle).filter((circle) => !circle.archivedAt)), tx),
  ]);
  const credentialCaps = actor.kind === "agent"
    ? await captureReadableToolLinkInputs(actor, workspaceId, "WorkspaceToolLinkCredential", admitted.records, tx)
    : { records: admitted.records.filter((link) => canManageToolLinkCredential(actor, membership, link)), roots: [], proofs: new Map<string, LineageRoot[]>() };
  const credentialManagerIds = new Set(credentialCaps.records.map((row) => row.id));
  const creatorIds = new Set(creators.records.map((row) => row.id));
  const circleIds = new Set(circles.records.map((row) => row.id));
  const roots = mergeArtifactInputProofs(readerRoots, admitted.roots, creators.roots, circles.roots, credentialCaps.roots);
  const result = admitted.records.map((link) => serializeToolLink(actor, membership, {
    ...link, createdBy: link.createdBy && creatorIds.has(link.createdBy.id) ? link.createdBy : null,
    circleTags: link.circleTags.filter((tag) => circleIds.has(tag.circleId)),
  }, credentialManagerIds.has(link.id)));
  invariant(await isArtifactInputProofReadable(actor, workspaceId, roots, tx), 409, "SOURCE_CHANGED", "Tool link inputs changed before return.");
  for (let index = 0; index < result.length; index++) {
    const link = admitted.records[index];
    const ownRoots = mergeArtifactInputProofs(readerRoots, admitted.proofs.get(link.id) ?? [],
      creators.proofs.get(link.createdBy?.id ?? "") ?? [], credentialCaps.proofs.get(link.id) ?? [],
      ...link.circleTags.filter(tag => circleIds.has(tag.circleId)).map(tag => circles.proofs.get(tag.circleId) ?? []));
    await bindToolLinkOutput(actor, workspaceId, result[index], ownRoots, tx);
  }
  return { result, roots };
}

async function requireReadableToolLink(actor: AppActor, workspaceId: string, link: ToolLinkRecord, tx?: Prisma.TransactionClient) {
  return captureArtifactInputProof(actor, workspaceId, [{ kind: "WorkspaceToolLink", id: link.id, snapshot: toolLinkInputSnapshot("WorkspaceToolLink", link) }], tx);
}

function normalizeString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeTitle(value: string) {
  const title = value.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Tool title is required.");
  invariant(title.length <= 160, 400, "INVALID_INPUT", "Tool title must be 160 characters or fewer.");
  return title;
}

function normalizeCategory(value: string | null | undefined) {
  return normalizeString(value)?.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64) || "OTHER";
}

function normalizeUrl(value: string) {
  const raw = value.trim();
  invariant(raw.length > 0, 400, "INVALID_INPUT", "Tool URL is required.");
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AppError(400, "INVALID_INPUT", "Tool URL must be a valid URL.");
  }

  invariant(parsed.protocol === "https:" || parsed.protocol === "http:", 400, "INVALID_INPUT", "Tool URL must use http or https.");
  parsed.hash = "";
  return parsed.toString();
}

function normalizeSecret(value: string | null | undefined) {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function serializeToolLink(
  actor: AppActor,
  membership: MembershipSummary | null | undefined,
  link: ToolLinkRecord,
  canManageCredential = canManageToolLinkCredential(actor, membership, link),
) {
  return {
    id: link.id,
    workspaceId: link.workspaceId,
    title: link.title,
    url: link.url,
    category: link.category,
    descriptionMd: link.descriptionMd,
    accessNotesMd: link.accessNotesMd,
    previewTitle: link.previewTitle,
    previewDescription: link.previewDescription,
    previewImageUrl: link.previewImageUrl,
    previewFaviconUrl: link.previewFaviconUrl,
    credentialLabel: link.credentialLabel,
    hasCredential: Boolean(link.credentialSecretEnc),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    archivedAt: link.archivedAt,
    archiveReason: link.archiveReason,
    createdBy: link.createdBy,
    circles: link.circleTags
      .map((tag) => tag.circle)
      .filter((circle) => !circle.archivedAt)
      .map((circle) => ({ id: circle.id, name: circle.name })),
    canManage: canEditToolLinkMetadata(actor, membership),
    canManageCredentials: canManageCredential,
    canArchive: canManageToolLinkCredential(actor, membership, link),
  };
}

async function validateCircleIds(tx: Prisma.TransactionClient, workspaceId: string, circleIds: string[] | undefined) {
  const normalized = [...new Set((circleIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (normalized.length === 0) return [];

  const circles = await tx.circle.findMany({
    where: {
      id: { in: normalized },
      workspaceId,
      archivedAt: null,
    },
    select: { id: true },
  });
  invariant(circles.length === normalized.length, 400, "INVALID_INPUT", "One or more circle tags are invalid.");
  return normalized;
}

export async function listWorkspaceToolLinks(actor: AppActor, params: {
  workspaceId: string;
  archiveFilter?: ArchiveFilter;
}) {
  const membership = await requireWorkspaceOperation({ actor, workspaceId: params.workspaceId, operation: "list_tool_links" });
  const release = new DigestReadRelease(actor, params.workspaceId);
  const visible: ReturnType<typeof serializeToolLink>[] = [];
  const allRoots = new Map<string, LineageRoot>();
  let afterId: string | undefined;
  while (true) {
    const links = await prisma.workspaceToolLink.findMany({
      where: { workspaceId: params.workspaceId, ...archiveFilterWhere(params.archiveFilter), ...(afterId ? {id: {gt: afterId}} : {}) },
      orderBy: {id: "asc"}, select: toolLinkSelect, take: 100,
    });
    const {result, roots} = await release.observeRead(() => serializeReadableToolLinks(actor, params.workspaceId, membership, links));
    release.add(roots);
    for (const root of roots) {
      const key = `${root.kind}:${root.id}`;
      allRoots.set(key, mergeArtifactInputProofs(allRoots.has(key) ? [allRoots.get(key)!] : [], [root])[0]);
    }
    visible.push(...result);
    if (links.length < 100) break;
    afterId = links.at(-1)!.id;
  }
  visible.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  await release.observeRead(() => bindToolLinkOutput(actor, params.workspaceId, visible, [...allRoots.values()]));
  return release.finish(visible);
}

export async function getWorkspaceToolLink(actor: AppActor, params: {
  workspaceId: string;
  toolLinkId: string;
}) {
  const membership = await requireWorkspaceOperation({ actor, workspaceId: params.workspaceId, operation: "list_tool_links" });
  const link = await prisma.workspaceToolLink.findFirst({
    where: {
      id: params.toolLinkId,
      workspaceId: params.workspaceId,
      archivedAt: null,
    },
    select: {
      ...toolLinkSelect,
      credentialSecretEnc: true,
    },
  });
  invariant(link, 404, "NOT_FOUND", "Tool link not found.");
  await requireReadableToolLink(actor, params.workspaceId, link);
  const { result: [result] } = await serializeReadableToolLinks(actor, params.workspaceId, membership, [link]);
  invariant(result, 404, "NOT_FOUND", "Tool link not found.");
  return result;
}

export async function createWorkspaceToolLink(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  url: string;
  category?: string | null;
  descriptionMd?: string | null;
  accessNotesMd?: string | null;
  previewTitle?: string | null;
  previewDescription?: string | null;
  previewImageUrl?: string | null;
  previewFaviconUrl?: string | null;
  credentialLabel?: string | null;
  credentialSecret?: string | null;
  circleIds?: string[];
} & ProducerLineageParams) {
  const membership = await requireWorkspaceOperation({ actor, workspaceId: params.workspaceId, operation: "upsert_tool_link" });
  const createdByUserId = actor.kind === "user" ? actor.user.id : await actorUserIdForWorkspace(actor, params.workspaceId);
  const secret = normalizeSecret(params.credentialSecret);

  const result = await prisma.$transaction(async (tx) => {
    const circleIds = await validateCircleIds(tx, params.workspaceId, params.circleIds);
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, capture: params });
    invariant(receipt.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "Tool link creation requires complete source inputs.");
    const link = await tx.workspaceToolLink.create({
      data: {
        workspaceId: params.workspaceId,
        createdByUserId,
        title: normalizeTitle(params.title),
        url: normalizeUrl(params.url),
        category: normalizeCategory(params.category),
        descriptionMd: normalizeString(params.descriptionMd),
        accessNotesMd: normalizeString(params.accessNotesMd),
        previewTitle: normalizeString(params.previewTitle),
        previewDescription: normalizeString(params.previewDescription),
        previewImageUrl: normalizeString(params.previewImageUrl),
        previewFaviconUrl: normalizeString(params.previewFaviconUrl),
        credentialLabel: normalizeString(params.credentialLabel),
        credentialSecretEnc: secret ? encryptSecret(secret) : null,
        circleTags: {
          create: circleIds.map((circleId) => ({ circleId })),
        },
      },
      select: {
        ...toolLinkSelect,
        credentialSecretEnc: true,
      },
    });

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "WorkspaceToolLink", id: link.id }, content: link, receipt });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "tool_link.created",
      entityType: "WorkspaceToolLink",
      entityId: link.id,
      meta: {
        title: link.title,
        category: link.category,
        hasCredential: Boolean(link.credentialSecretEnc),
        circleIds,
      },
    });

    const { result: [result] } = await serializeReadableToolLinks(actor, params.workspaceId, membership, [link], tx);
    invariant(result, 409, "UNKNOWN_LINEAGE", "Tool link output has no complete source proof.");
    return result;
  });
  await getWorkspaceToolLinkInputRoots(actor, params.workspaceId, result);
  return result;
}

export async function updateWorkspaceToolLink(actor: AppActor, params: {
  workspaceId: string;
  toolLinkId: string;
  title?: string;
  url?: string;
  category?: string | null;
  descriptionMd?: string | null;
  accessNotesMd?: string | null;
  previewTitle?: string | null;
  previewDescription?: string | null;
  previewImageUrl?: string | null;
  previewFaviconUrl?: string | null;
  credentialLabel?: string | null;
  credentialSecret?: string | null;
  circleIds?: string[];
} & ProducerLineageParams) {
  const membership = await requireWorkspaceOperation({ actor, workspaceId: params.workspaceId, operation: "upsert_tool_link" });

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkspaceToolLink" WHERE id = ${params.toolLinkId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const existing = await tx.workspaceToolLink.findFirst({
      where: {
        id: params.toolLinkId,
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
      select: toolLinkSelect,
    });
    invariant(existing, 404, "NOT_FOUND", "Tool link not found.");
    requireToolLinkMetadataEditor(actor, membership);
    await requireReadableToolLink(actor, params.workspaceId, existing, tx);
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "WorkspaceToolLink", id: existing.id }, before: existing, capture: params });
    invariant(receipt.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "A partial edit cannot prove the existing tool link content.");
    if (receipt.mode === "ADVANCE") await captureArtifactInputSnapshotProof(actor, params.workspaceId,
      { kind: "WorkspaceToolLink", id: existing.id, fingerprint: lineageContentFingerprint("WorkspaceToolLink", existing) }, tx);
    const editsCredential = params.credentialLabel !== undefined || params.credentialSecret !== undefined;
    if (editsCredential) {
      requireToolLinkCredentialManager(actor, membership, existing);
    }

    const data: Prisma.WorkspaceToolLinkUpdateInput = {};
    if (params.title !== undefined) data.title = normalizeTitle(params.title);
    if (params.url !== undefined) data.url = normalizeUrl(params.url);
    if (params.category !== undefined) data.category = normalizeCategory(params.category);
    if (params.descriptionMd !== undefined) data.descriptionMd = normalizeString(params.descriptionMd);
    if (params.accessNotesMd !== undefined) data.accessNotesMd = normalizeString(params.accessNotesMd);
    if (params.previewTitle !== undefined) data.previewTitle = normalizeString(params.previewTitle);
    if (params.previewDescription !== undefined) data.previewDescription = normalizeString(params.previewDescription);
    if (params.previewImageUrl !== undefined) data.previewImageUrl = normalizeString(params.previewImageUrl);
    if (params.previewFaviconUrl !== undefined) data.previewFaviconUrl = normalizeString(params.previewFaviconUrl);
    if (params.credentialLabel !== undefined) data.credentialLabel = normalizeString(params.credentialLabel);
    if (params.credentialSecret !== undefined) {
      const secret = normalizeSecret(params.credentialSecret);
      data.credentialSecretEnc = secret ? encryptSecret(secret) : null;
    }

    if (params.circleIds !== undefined) {
      const circleIds = await validateCircleIds(tx, params.workspaceId, params.circleIds);
      await tx.workspaceToolLinkCircleTag.deleteMany({
        where: { toolLinkId: existing.id },
      });
      if (circleIds.length > 0) {
        await tx.workspaceToolLinkCircleTag.createMany({
          data: circleIds.map((circleId) => ({
            toolLinkId: existing.id,
            circleId,
          })),
          skipDuplicates: true,
        });
      }
    }

    const updated = await tx.workspaceToolLink.update({
      where: { id: existing.id },
      data,
      select: {
        ...toolLinkSelect,
        credentialSecretEnc: true,
      },
    });

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "WorkspaceToolLink", id: updated.id }, content: updated, receipt });
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "tool_link.updated",
      entityType: "WorkspaceToolLink",
      entityId: updated.id,
      meta: {
        fields: [
          ...Object.keys(data),
          ...(params.circleIds !== undefined ? ["circleIds"] : []),
        ],
        hasCredential: Boolean(updated.credentialSecretEnc),
      },
    });

    const { result: [result] } = await serializeReadableToolLinks(actor, params.workspaceId, membership, [updated], tx);
    invariant(result, 409, "UNKNOWN_LINEAGE", "Tool link output has no complete source proof.");
    return result;
  });
  await getWorkspaceToolLinkInputRoots(actor, params.workspaceId, result);
  return result;
}

export async function upsertWorkspaceToolLink(actor: AppActor, params: Omit<Parameters<typeof createWorkspaceToolLink>[1], "workspaceId"> & {
  workspaceId: string;
  toolLinkId?: string | null;
}) {
  if (params.toolLinkId) {
    return updateWorkspaceToolLink(actor, {
      ...params,
      toolLinkId: params.toolLinkId,
    });
  }

  return createWorkspaceToolLink(actor, params);
}

export async function archiveWorkspaceToolLink(actor: AppActor, params: {
  workspaceId: string;
  toolLinkId: string;
  reason?: string | null;
  requestLineageRoots?: readonly LineageRoot[];
} & ProducerLineageParams) {
  const membership = await requireWorkspaceOperation({ actor, workspaceId: params.workspaceId, operation: "archive_tool_link" });
  const requestLineageRoots = params.requestLineageRoots ?? getMcpToolInputRoots(actor, params.workspaceId);
  const outcomeRequest = { workspaceId: params.workspaceId, toolLinkId: params.toolLinkId, requestLineageRoots };
  const result = await prisma.$transaction(async (tx) => {
    if (requestLineageRoots.length) {
      const previous = await findConversationToolLinkArchiveOutcome(actor, outcomeRequest, tx);
      if (previous) return previous;
    }
    await tx.$queryRaw`SELECT id FROM "WorkspaceToolLink" WHERE id = ${params.toolLinkId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const existing = await tx.workspaceToolLink.findFirst({ where: {
      id: params.toolLinkId, workspaceId: params.workspaceId, archivedAt: null,
    }, select: toolLinkSelect });
    invariant(existing, 404, "NOT_FOUND", "Tool link not found.");
    requireToolLinkCredentialManager(actor, membership, existing);
    if (params.lineageRoots?.length) invariant(await isArtifactInputProofReadable(actor, params.workspaceId, params.lineageRoots, tx),
      409, "SOURCE_CHANGED", "Archive inputs changed before persistence.");
    await requireReadableToolLink(actor, params.workspaceId, existing, tx);
    // Preserve the original revision in the archive history. Its live grant is
    // intentionally revoked by the archive; no receipt certifies the old body afterward.
    await archiveWorkspaceArtifact(actor, {
      workspaceId: params.workspaceId, entityType: "WorkspaceToolLink", entityId: params.toolLinkId,
      reason: params.reason ?? "Archived from tool links directory.", _tx: tx,
    });
    return requestLineageRoots.length ? recordConversationToolLinkArchiveOutcome(actor, outcomeRequest, tx) : { id: params.toolLinkId };
  });
  if ("success" in result) await getConversationOperationOutcomeInputRoots(actor, params.workspaceId, result);
  return result;
}

async function readToolLinkCredential<T>(actor: AppActor, params: { workspaceId: string; toolLinkId: string },
  consume: (link: ToolLinkRecord, tx: Prisma.TransactionClient) => Promise<T>) {
  sealArtifactInputActor(actor);
  params = Object.freeze({ ...params });
  await requireWorkspaceOperation({ actor, workspaceId: params.workspaceId, operation: "reveal_tool_link_credential" });
  let roots: LineageRoot[] = [];
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkspaceToolLink" WHERE id = ${params.toolLinkId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
    const membership = await requireWorkspaceOperation({ actor, workspaceId: params.workspaceId,
      operation: "reveal_tool_link_credential", tx });
    const metadata = await tx.workspaceToolLink.findFirst({ where: {
      id: params.toolLinkId, workspaceId: params.workspaceId, archivedAt: null,
    }, select: { id: true, createdByUserId: true } });
    invariant(metadata, 404, "NOT_FOUND", "Tool link not found.");
    requireToolLinkCredentialManager(actor, membership, metadata);
    const link = await tx.workspaceToolLink.findFirst({ where: {
      id: metadata.id, workspaceId: params.workspaceId, archivedAt: null, createdByUserId: metadata.createdByUserId,
    }, select: toolLinkSelect });
    invariant(link, 404, "NOT_FOUND", "Tool link not found.");
    requireToolLinkCredentialManager(actor, membership, link);
    roots = await captureArtifactInputProof(actor, params.workspaceId,
      [{ kind: "WorkspaceToolLinkCredential", id: link.id, snapshot: link }], tx);
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots, tx),
      409, "SOURCE_CHANGED", "Credential access changed before use.");
    const value = await consume(link, tx);
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots, tx),
      409, "SOURCE_CHANGED", "Credential access changed during use.");
    return value;
  });
  invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots),
    409, "SOURCE_CHANGED", "Credential access changed before return.");
  await bindToolLinkOutput(actor, params.workspaceId, result as object, roots);
  return result;
}

/** Model tools use the protected Tools UI; no credential value enters model messages. */
export async function getWorkspaceToolLinkCredentialAccess(actor: AppActor, params: {
  workspaceId: string; toolLinkId: string;
}) {
  return readToolLinkCredential(actor, params, async (link) => ({
    credentialLabel: link.credentialLabel, hasCredential: Boolean(link.credentialSecretEnc),
  }));
}

export async function revealWorkspaceToolLinkCredential(actor: AppActor, params: {
  workspaceId: string;
  toolLinkId: string;
}) {
  return readToolLinkCredential(actor, params, async (link, tx) => {
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId, action: "tool_link.credential_revealed", entityType: "WorkspaceToolLink", entityId: link.id,
      meta: { credentialLabel: link.credentialLabel, hasCredential: Boolean(link.credentialSecretEnc) },
    });
    return { credentialLabel: link.credentialLabel,
      credentialSecret: link.credentialSecretEnc ? decryptSecret(link.credentialSecretEnc) : null };
  });
}
