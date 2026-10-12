import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { resolveKnowledgeAccessDomains } from "./brain-access";
import { brainSourceContentFingerprint } from "./brain-derivation";
import { invariant } from "./errors";

export type LineageKind =
  | "BrainSource" | "BrainArticle" | "BrainArticleVersion" | "Document" | "Meeting"
  | "Proposal" | "Goal" | "GoalLink" | "CheckIn" | "ContextGraphObject"
  | "ContextGraphRelationship" | "ContextGraphEvidenceRef" | "ContextGraphProposedDiff";

export type LineageInput = { kind: LineageKind; id: string };
export type LineageRoot = LineageInput & { fingerprint: string };
type LineageClient = Prisma.TransactionClient | typeof prisma;

const CONTENT_FIELDS: Record<LineageKind, string[]> = {
  BrainSource: [],
  BrainArticle: ["slug", "title", "type", "authority", "bodyMd", "frontmatterJson", "sourceIds", "isPrivate", "ownerMemberId", "publishedAt", "archivedAt"],
  BrainArticleVersion: ["articleId", "version", "bodyMd"],
  Document: ["title", "source", "storageKey", "textContent", "accessDomain", "archivedAt"],
  Meeting: ["title", "transcript", "summaryMd", "blocksJson", "archivedAt"],
  Proposal: ["title", "summary", "bodyMd", "decisionMd", "isPrivate", "authorUserId"],
  Goal: ["title", "descriptionMd", "level", "cadence", "parentGoalId", "circleId", "ownerMemberId", "status", "isPrivate", "authorUserId", "archivedAt"],
  GoalLink: ["goalId", "entityType", "entityId", "confidence", "linkedBy", "source", "metadata"],
  CheckIn: ["questionText", "questionSource", "metadata", "relatedEntityType", "relatedEntityId"],
  ContextGraphObject: ["objectType", "title", "summary", "properties", "status", "sourceEntityType", "sourceEntityId"],
  ContextGraphRelationship: ["sourceObjectId", "targetObjectId", "relationshipType", "properties", "status", "sourceEntityType", "sourceEntityId"],
  ContextGraphEvidenceRef: ["objectId", "relationshipId", "sourceType", "sourceId", "knowledgeChunkId", "quote", "metadata"],
  ContextGraphProposedDiff: ["diffJson", "reason", "evidenceJson"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Hash only fields that can convey information or change visibility. */
export function lineageContentFingerprint(kind: LineageKind, row: unknown): string {
  invariant(isRecord(row), 409, "UNKNOWN_LINEAGE", "Artifact content cannot be verified.");
  const fields = CONTENT_FIELDS[kind];
  return createHash("sha256").update(JSON.stringify([kind, ...fields.map((field) => row[field] ?? null)])).digest("hex");
}

function parseRoots(value: Prisma.JsonValue): LineageRoot[] | null {
  if (!Array.isArray(value)) return null;
  const roots: LineageRoot[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.kind !== "string" || !(item.kind in CONTENT_FIELDS)
      || typeof item.id !== "string" || !item.id
      || typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.fingerprint)) return null;
    roots.push(item as LineageRoot);
  }
  return roots;
}

async function loadArtifact(db: LineageClient, workspaceId: string, input: LineageInput) {
  const where = { id: input.id, workspaceId };
  switch (input.kind) {
    case "BrainSource": return db.brainSource.findFirst({ where });
    case "BrainArticle": return db.brainArticle.findFirst({ where });
    case "BrainArticleVersion": return db.brainArticleVersion.findFirst({ where: { id: input.id, article: { workspaceId } } });
    case "Document": return db.document.findFirst({ where });
    case "Meeting": return db.meeting.findFirst({ where });
    case "Proposal": return db.proposal.findFirst({ where });
    case "Goal": return db.goal.findFirst({ where });
    case "GoalLink": return db.goalLink.findFirst({ where: { id: input.id, goal: { workspaceId } } });
    case "CheckIn": return db.checkIn.findFirst({ where });
    case "ContextGraphObject": return db.contextGraphObject.findFirst({ where });
    case "ContextGraphRelationship": return db.contextGraphRelationship.findFirst({ where });
    case "ContextGraphEvidenceRef": return db.contextGraphEvidenceRef.findFirst({ where });
    case "ContextGraphProposedDiff": return db.contextGraphProposedDiff.findFirst({ where });
  }
}

function isArchived(row: unknown) {
  return isRecord(row) && (row.archivedAt != null || row.status === "archived");
}

function actorCanReadRecord(actor: AppActor, membership: { id: string; role: string } | null, kind: LineageKind, row: Record<string, unknown>) {
  if (kind === "BrainArticle" && row.isPrivate === true) {
    return actor.kind === "agent" || membership?.role === "ADMIN" || row.ownerMemberId === membership?.id;
  }
  if ((kind === "Proposal" || kind === "Goal") && row.isPrivate === true) {
    return row.status === "DRAFT" && (actor.kind === "agent" || membership?.role === "ADMIN"
      || (actor.kind === "user" && row.authorUserId === actor.user.id));
  }
  if (kind === "CheckIn") return actor.kind === "agent" || membership?.id === row.memberId;
  return true;
}

async function rootIsReadable(db: LineageClient, actor: AppActor, workspaceId: string,
  membership: { id: string; role: string } | null, domains: readonly string[], root: LineageRoot) {
  const row = await loadArtifact(db, workspaceId, root);
  if (!isRecord(row) || isArchived(row)) return false;
  if (root.kind === "BrainArticleVersion") {
    const parent = await db.brainArticle.findFirst({ where: {
      id: String((row as Record<string, unknown>).articleId), workspaceId,
    } });
    if (!isRecord(parent) || isArchived(parent) || !actorCanReadRecord(actor, membership, "BrainArticle", parent)) return false;
  }
  if (root.kind === "GoalLink") {
    const parent = await db.goal.findFirst({ where: {
      id: String((row as Record<string, unknown>).goalId), workspaceId,
    } });
    if (!isRecord(parent) || isArchived(parent) || !actorCanReadRecord(actor, membership, "Goal", parent)) return false;
  }
  if ((root.kind === "BrainSource" || root.kind === "Document")
    && !domains.includes(String((row as Record<string, unknown>).accessDomain))) return false;
  if (!actorCanReadRecord(actor, membership, root.kind, row)) return false;
  const fingerprint = root.kind === "BrainSource"
    ? brainSourceContentFingerprint(row as Parameters<typeof brainSourceContentFingerprint>[0])
    : lineageContentFingerprint(root.kind, row);
  return fingerprint === root.fingerprint;
}

async function latestManifest(db: LineageClient, workspaceId: string, input: LineageInput) {
  return db.artifactInputLineage.findFirst({ where: {
    workspaceId, artifactType: input.kind, artifactId: input.id,
  }, orderBy: { revision: "desc" } });
}

/** A manifest is a proof of complete input capture, not a model's citation list. */
export async function recordArtifactInputLineage(params: {
  tx: Prisma.TransactionClient;
  actor: AppActor;
  workspaceId: string;
  artifact: LineageInput;
  content: unknown;
  origin: "HUMAN_ORIGINAL" | "DERIVED";
  inputs: LineageInput[];
  inheritedRoots?: LineageRoot[];
  /** Graph nodes are mutable; retain their verified source roots, not an obsolete node snapshot. */
  transitiveOnlyKinds?: LineageKind[];
}) {
  const { tx, actor, workspaceId, artifact, content } = params;
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
  invariant(params.origin !== "HUMAN_ORIGINAL" || (actor.kind === "user" && params.inputs.length === 0 && !params.inheritedRoots?.length),
    409, "UNKNOWN_LINEAGE", "Only a direct human original can have an empty input manifest.");
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const roots = new Map<string, LineageRoot>();
  const transitiveOnly = new Set(params.transitiveOnlyKinds ?? []);
  const addRoot = (root: LineageRoot) => {
    const key = `${root.kind}:${root.id}`;
    const existing = roots.get(key);
    invariant(!existing || existing.fingerprint === root.fingerprint, 409, "SOURCE_CHANGED", "Input revisions conflict.");
    roots.set(key, root);
  };
  const expandRoot = async (root: LineageRoot, visited = new Set<string>()): Promise<void> => {
    invariant(await rootIsReadable(tx, actor, workspaceId, membership, domains, root),
      409, "SOURCE_CHANGED", "An earlier input is no longer available.");
    if (!transitiveOnly.has(root.kind)) { addRoot(root); return; }
    const key = `${root.kind}:${root.id}`;
    invariant(!visited.has(key), 409, "UNKNOWN_LINEAGE", "Input lineage is cyclic.");
    const parent = await latestManifest(tx, workspaceId, root);
    invariant(parent?.contentHash === root.fingerprint, 409, "UNKNOWN_LINEAGE", "Input lineage is incomplete.");
    const parentRoots = parseRoots(parent.rootsJson);
    invariant(parentRoots, 409, "UNKNOWN_LINEAGE", "Input lineage is invalid.");
    const nextVisited = new Set(visited).add(key);
    for (const parentRoot of parentRoots) await expandRoot(parentRoot, nextVisited);
  };
  for (const root of params.inheritedRoots ?? []) await expandRoot(root);
  for (const input of params.inputs) {
    const row = await loadArtifact(tx, workspaceId, input);
    invariant(isRecord(row) && !isArchived(row), 409, "SOURCE_CHANGED", "An input is unavailable.");
    const fingerprint = input.kind === "BrainSource"
      ? brainSourceContentFingerprint(row as Parameters<typeof brainSourceContentFingerprint>[0])
      : lineageContentFingerprint(input.kind, row);
    const directRoot = { ...input, fingerprint };
    invariant(await rootIsReadable(tx, actor, workspaceId, membership, domains, directRoot),
      409, "SOURCE_RESTRICTED", "An input is not accessible.");
    await expandRoot(directRoot);
    if (input.kind !== "BrainSource" && input.kind !== "Document" && input.kind !== "Meeting") {
      const parent = await latestManifest(tx, workspaceId, input);
      invariant(parent && parent.contentHash === fingerprint, 409, "UNKNOWN_LINEAGE", "An input has incomplete lineage.");
      const parentRoots = parseRoots(parent.rootsJson);
      invariant(parentRoots, 409, "UNKNOWN_LINEAGE", "An input has invalid lineage.");
      for (const root of parentRoots) await expandRoot(root);
    }
  }
  invariant(params.origin !== "DERIVED" || params.inputs.length > 0 || roots.size > 0,
    409, "UNKNOWN_LINEAGE", "Derived content requires complete input lineage.");
  const previous = await latestManifest(tx, workspaceId, artifact);
  return tx.artifactInputLineage.create({ data: {
    workspaceId, artifactType: artifact.kind, artifactId: artifact.id,
    revision: (previous?.revision ?? 0) + 1, origin: params.origin,
    contentHash: lineageContentFingerprint(artifact.kind, content),
    inputsJson: params.inputs as Prisma.InputJsonArray,
    rootsJson: [...roots.values()] as Prisma.InputJsonArray,
  } });
}

/** Preserve the prior body's exact permissions when saving article history. */
export async function copyArtifactInputLineage(params: {
  tx: Prisma.TransactionClient;
  workspaceId: string;
  from: LineageInput;
  fromContent: unknown;
  to: LineageInput;
  toContent: unknown;
}) {
  const prior = await latestManifest(params.tx, params.workspaceId, params.from);
  if (!prior || prior.contentHash !== lineageContentFingerprint(params.from.kind, params.fromContent)
    || !parseRoots(prior.rootsJson)) return false;
  await params.tx.artifactInputLineage.create({ data: {
    workspaceId: params.workspaceId,
    artifactType: params.to.kind,
    artifactId: params.to.id,
    revision: 1,
    origin: prior.origin,
    contentHash: lineageContentFingerprint(params.to.kind, params.toContent),
    inputsJson: prior.inputsJson as Prisma.InputJsonValue,
    rootsJson: prior.rootsJson as Prisma.InputJsonValue,
  } });
  return true;
}

/** Explicitly remove any old proof after a writer cannot attest its complete inputs. */
export async function invalidateArtifactInputLineage(params: {
  tx: Prisma.TransactionClient;
  workspaceId: string;
  artifact: LineageInput;
  content: unknown;
}) {
  const previous = await latestManifest(params.tx, params.workspaceId, params.artifact);
  return params.tx.artifactInputLineage.create({ data: {
    workspaceId: params.workspaceId,
    artifactType: params.artifact.kind,
    artifactId: params.artifact.id,
    revision: (previous?.revision ?? 0) + 1,
    origin: "UNKNOWN",
    contentHash: lineageContentFingerprint(params.artifact.kind, params.content),
    inputsJson: Prisma.JsonNull,
    rootsJson: Prisma.JsonNull,
  } });
}

export async function hasCurrentArtifactInputLineage(db: LineageClient, workspaceId: string,
  artifact: LineageInput, content: unknown) {
  const manifest = await latestManifest(db, workspaceId, artifact);
  return Boolean(manifest && manifest.contentHash === lineageContentFingerprint(artifact.kind, content)
    && parseRoots(manifest.rootsJson));
}

export async function currentArtifactInputRoots(db: LineageClient, workspaceId: string,
  artifact: LineageInput, content: unknown) {
  const manifest = await latestManifest(db, workspaceId, artifact);
  if (!manifest || manifest.contentHash !== lineageContentFingerprint(artifact.kind, content)) return null;
  return parseRoots(manifest.rootsJson);
}

/** Returns only ids whose current content and every permission-bearing input are provably safe. */
export async function readableArtifactIds(actor: AppActor, workspaceId: string,
  kind: LineageKind, records: Array<{ id: string; [key: string]: unknown }>, db: LineageClient = prisma) {
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  const manifests = await db.artifactInputLineage.findMany({ where: {
    workspaceId, artifactType: kind, artifactId: { in: records.map((record) => record.id) },
  }, orderBy: { revision: "desc" } });
  const latest = new Map<string, typeof manifests[number]>();
  for (const manifest of manifests) if (!latest.has(manifest.artifactId)) latest.set(manifest.artifactId, manifest);
  const rootCache = new Map<string, boolean>();
  const visible = new Set<string>();
  for (const record of records) {
    const manifest = latest.get(record.id);
    if (!manifest || manifest.contentHash !== lineageContentFingerprint(kind, record)
      || isArchived(record) || !actorCanReadRecord(actor, membership, kind, record)) continue;
    const roots = parseRoots(manifest.rootsJson);
    if (!roots) continue;
    let allowed = true;
    for (const root of roots) {
      const key = `${root.kind}:${root.id}:${root.fingerprint}`;
      if (!rootCache.has(key)) rootCache.set(key, await rootIsReadable(db, actor, workspaceId, membership, domains, root));
      if (!rootCache.get(key)) { allowed = false; break; }
    }
    if (allowed) visible.add(record.id);
  }
  return visible;
}
