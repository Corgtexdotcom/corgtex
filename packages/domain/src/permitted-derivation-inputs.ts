import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { lockBrainSourceLink, lockActiveArticleSources } from "./brain-source-links";
import { mergeArtifactInputProofs } from "./digest-lineage";
import { meetingTranscriptInputProjection } from "./meeting-intelligence-context";
import { captureArtifactInputProof, inspectStoredArtifactInputDependencies, lineageContentFingerprint,
  assertArtifactInputWriteFence, captureArtifactPermissionEpochs,
  type LineageKind, type LineageRoot } from "./source-lineage";
import type { PermissionEpochProof } from "./source-permission-epochs";

export const PERMITTED_DERIVATION_SOURCE_KINDS = ["BrainSource", "Document", "MeetingTranscript", "CommunicationMessage",
  "ConversationPromptInput", "ConversationIngressInput", "AgentRequestInput", "BrainArticle", "Role", "Circle", "Action", "Tension", "Goal"] as const;
export type PermittedDerivationSourceKind = typeof PERMITTED_DERIVATION_SOURCE_KINDS[number];
/** The model receives only independently permitted, explicitly projected source content. */
export type PermittedDerivationSource = {
  kind: PermittedDerivationSourceKind;
  id: string;
  title: string | null;
  content: string;
  ingestionGuidanceMd: string | null;
  sourceType?: string;
  tier?: number;
};

type CandidateRow = { id: string; [key: string]: unknown };
const ORIGINAL_ONLY_KINDS = new Set<LineageKind>(["BrainArticle", "Role", "Circle", "Action", "Tension", "Goal"]);
// Include archiveable ancestors even when their body is not a separate prompt entry.
const ARCHIVE_ENTITY_TYPES: Readonly<Partial<Record<string, string>>> = {
  BrainSource: "BrainSource", Document: "Document", Meeting: "Meeting", MeetingTranscript: "Meeting",
  BrainArticle: "BrainArticle", Role: "Role", Circle: "Circle", Action: "Action", Tension: "Tension", Goal: "Goal",
  Proposal: "Proposal", AgentIdentity: "AgentIdentity", CrmAccount: "CrmAccount", CrmActivity: "CrmActivity",
  CrmContact: "CrmContact", CrmDeal: "CrmDeal", WorkspaceToolLink: "WorkspaceToolLink",
};
const INPUT_TABLES: Readonly<Partial<Record<string, string>>> = {
  ...ARCHIVE_ENTITY_TYPES, CommunicationMessage: "CommunicationMessage", ConversationPromptInput: "ConversationPromptInput",
  ConversationIngressInput: "ConversationIngressInput", AgentRequestInput: "AgentRequestInput", ArtifactInputSnapshot: "ArtifactInputSnapshot",
  // Immutable native receipts remain ancestors, never separate prompt bodies.
  NativeTranscriptInput: "NativeTranscriptInput", MeetingAudioAsset: "MeetingAudioAsset",
  CommunicationMessageNativeInput: "CommunicationMessageNativeInput", CommunicationInstallation: "CommunicationInstallation", CommunicationChannel: "CommunicationChannel",
};
function canonicalJson(value: unknown): unknown {
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalJson(entry)]));
  return value;
}
export function derivationHash(value: unknown) { return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex"); }
export function derivationRootSignature(roots: readonly LineageRoot[]) {
  return roots.map(root => ({ ...root })).sort((left, right) =>
    JSON.stringify([left.kind, left.id, left.fingerprint]).localeCompare(JSON.stringify([right.kind, right.id, right.fingerprint])));
}
export function derivationStateSignature(states: Record<string, string>) {
  return Object.entries(states).sort(([left], [right]) => left.localeCompare(right));
}
function isSourceKind(kind: unknown): kind is PermittedDerivationSourceKind {
  return typeof kind === "string" && (PERMITTED_DERIVATION_SOURCE_KINDS as readonly string[]).includes(kind);
}
/** Version bodies remain historical evidence; only their parent identity is needed for exclusion/epochs. */
async function versionParents(tx: Prisma.TransactionClient, workspaceId: string, roots: readonly LineageRoot[]) {
  const ids = [...new Set(roots.filter((root) => root.kind === "BrainArticleVersion").map((root) => root.id))].sort();
  return ids.length ? tx.brainArticleVersion.findMany({ where: { article: { workspaceId }, id: { in: ids } }, select: { id: true, articleId: true } }) : [];
}

export async function derivationArchiveStates(tx: Prisma.TransactionClient, workspaceId: string, roots: readonly LineageRoot[]) {
  const states: Record<string, string> = Object.create(null);
  const identities = new Map<string, { entityType: string; id: string }>();
  for (const root of roots) {
    const entityType = ARCHIVE_ENTITY_TYPES[root.kind];
    if (entityType) identities.set(JSON.stringify([entityType, root.id]), { entityType, id: root.id });
  }
  for (const parent of await versionParents(tx, workspaceId, roots)) {
    identities.set(JSON.stringify(["BrainArticle", parent.articleId]), { entityType: "BrainArticle", id: parent.articleId });
  }
  for (const [key, { entityType, id }] of [...identities].sort(([left], [right]) => left.localeCompare(right))) {
    const history = await tx.workspaceArchiveRecord.findMany({ where: { workspaceId, entityType, entityId: id },
      select: { id: true, archivedAt: true, restoredAt: true, purgedAt: true }, orderBy: { id: "asc" } });
    states[key] = derivationHash(history);
  }
  return states;
}
async function loadCandidates(tx: Prisma.TransactionClient, workspaceId: string, kind: PermittedDerivationSourceKind,
  ids: string[]): Promise<CandidateRow[]> {
  const where = { workspaceId, id: { in: ids } };
  let rows: unknown[];
  switch (kind) {
    case "BrainSource": rows = await tx.brainSource.findMany({ where: { ...where, archivedAt: null } }); break;
    case "Document": rows = await tx.document.findMany({ where: { ...where, archivedAt: null } }); break;
    case "MeetingTranscript": rows = (await tx.meeting.findMany({ where: { ...where, archivedAt: null } })).map(meetingTranscriptInputProjection); break;
    case "CommunicationMessage": rows = await tx.communicationMessage.findMany({ where }); break;
    case "ConversationPromptInput": rows = await tx.conversationPromptInput.findMany({ where }); break;
    case "ConversationIngressInput": rows = await tx.conversationIngressInput.findMany({ where }); break;
    case "AgentRequestInput": rows = await tx.agentRequestInput.findMany({ where }); break;
    case "BrainArticle": rows = await tx.brainArticle.findMany({ where: { ...where, archivedAt: null, variantOfArticleId: null } }); break;
    case "Role": rows = await tx.role.findMany({ where: { id: { in: ids }, circle: { workspaceId }, archivedAt: null } }); break;
    case "Circle": rows = await tx.circle.findMany({ where: { ...where, archivedAt: null } }); break;
    case "Action": rows = await tx.action.findMany({ where: { ...where, archivedAt: null } }); break;
    case "Tension": rows = await tx.tension.findMany({ where: { ...where, archivedAt: null } }); break;
    case "Goal": rows = await tx.goal.findMany({ where: { ...where, archivedAt: null } }); break;
  }
  return rows as CandidateRow[];
}
function sourceProjection(kind: PermittedDerivationSourceKind, row: CandidateRow): PermittedDerivationSource | null {
  const title = typeof row.title === "string" ? row.title : typeof row.name === "string" ? row.name : null;
  const guidance = typeof row.ingestionGuidanceMd === "string" ? row.ingestionGuidanceMd : null;
  const fieldText = (field: string) => typeof row[field] === "string" ? row[field] as string : "";
  let content: string;
  switch (kind) {
    case "BrainSource": content = fieldText("content"); break;
    case "Document": content = fieldText("textContent"); break;
    case "MeetingTranscript": content = fieldText("transcript"); break;
    case "CommunicationMessage": content = fieldText("text"); break;
    case "ConversationPromptInput": case "ConversationIngressInput": content = fieldText("content"); break;
    case "AgentRequestInput": content = fieldText("prompt"); break;
    case "BrainArticle": case "Action": case "Tension": content = fieldText("bodyMd"); break;
    case "Goal": content = fieldText("descriptionMd"); break;
    case "Role": content = JSON.stringify({ purposeMd: row.purposeMd ?? null, accountabilities: row.accountabilities ?? [],
      artifacts: row.artifacts ?? [], metricsMd: row.metricsMd ?? null, coreRoleType: row.coreRoleType ?? null }); break;
    case "Circle": content = JSON.stringify({ purposeMd: row.purposeMd ?? null, domainMd: row.domainMd ?? null, maturityStage: row.maturityStage ?? null }); break;
  }
  if (!content.trim() && (!ORIGINAL_ONLY_KINDS.has(kind) || !title?.trim())) return null;
  return { kind, id: row.id, title, content, ingestionGuidanceMd: guidance,
    ...(kind === "BrainSource" ? { sourceType: String(row.sourceType), tier: Number(row.tier) } : {}) };
}
export async function lockDerivationInputs(tx: Prisma.TransactionClient, workspaceId: string, roots: readonly LineageRoot[]) {
  const identities = new Map<string, { table: string; id: string }>();
  for (const root of roots) {
    const table = INPUT_TABLES[root.kind];
    if (table) identities.set(JSON.stringify([table, root.id]), { table, id: root.id });
  }
  // A version's current access and archive envelope belongs to its article.
  for (const parent of await versionParents(tx, workspaceId, roots)) {
    identities.set(JSON.stringify(["BrainArticle", parent.articleId]), { table: "BrainArticle", id: parent.articleId });
  }
  for (const [, { table, id }] of [...identities].sort(([left], [right]) => left.localeCompare(right))) {
    const archiveEntityType = Object.values(ARCHIVE_ENTITY_TYPES).includes(table) ? table : null;
    if (archiveEntityType === "BrainSource") await lockBrainSourceLink(tx, id);
    else if (archiveEntityType) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace_archive:${archiveEntityType}:${id}`}, 0))`;
    // Identifiers originate only in the static table allowlist; values remain SQL parameters.
    if (table === "Role") {
      await tx.$queryRaw`SELECT r.id FROM "Role" r JOIN "Circle" c ON c.id = r."circleId" WHERE r.id = ${id} AND c."workspaceId" = ${workspaceId} FOR UPDATE OF r`;
    } else {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`);
    }
  }
}


export type DerivationIdentity = { kind: LineageKind; id: string };
export type PreparedDerivationInputs = {
  sources: PermittedDerivationSource[];
  roots: LineageRoot[];
  sourceIdentities: Array<{ kind: PermittedDerivationSourceKind; id: string; fingerprint: string }>;
  archiveStates: Record<string, string>;
  permissionEpochs: PermissionEpochProof;
};

/** Historical identities select candidates; only independently proven current bodies enter a prompt. */
export async function preparePermittedDerivationInputs(tx: Prisma.TransactionClient, actor: AppActor,
  workspaceId: string, identities: readonly DerivationIdentity[], excluded: readonly DerivationIdentity[],
  additionalInputs: readonly DerivationIdentity[] = []): Promise<PreparedDerivationInputs | null> {
  invariant(identities.length <= 5000 && excluded.length <= 5000, 503, "INPUT_SCAN_LIMIT", "Derivation input collection is too large.");
  const forbidden = new Set(excluded.map(input => JSON.stringify([input.kind, input.id])));
  const candidates = new Map<PermittedDerivationSourceKind, Set<string>>();
  for (const input of identities) {
    if (!isSourceKind(input.kind) || forbidden.has(JSON.stringify([input.kind, input.id]))) continue;
    const ids = candidates.get(input.kind) ?? new Set<string>(); ids.add(input.id); candidates.set(input.kind, ids);
  }
  const admitted: Array<{ kind: PermittedDerivationSourceKind; row: CandidateRow; source: PermittedDerivationSource; roots: LineageRoot[] }> = [];
  for (const [kind, ids] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    for (const row of (await loadCandidates(tx, workspaceId, kind, [...ids].sort())).sort((a, b) => a.id.localeCompare(b.id))) {
      if (ORIGINAL_ONLY_KINDS.has(kind)) {
        const receipt = await tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: kind, artifactId: row.id }, orderBy: { revision: "desc" } });
        if (!receipt || receipt.origin !== "HUMAN_ORIGINAL" || receipt.contentHash !== lineageContentFingerprint(kind, row)
          || !Array.isArray(receipt.rootsJson) || receipt.rootsJson.length) continue;
      }
      try {
        const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind, id: row.id, snapshot: row }], tx);
        const ancestry = await inspectStoredArtifactInputDependencies(tx, workspaceId, roots);
        if (!ancestry.complete) continue;
        invariant(ancestry.roots.length <= 5000, 503, "INPUT_SCAN_LIMIT", "Derivation ancestry is too large.");
        const parents = await versionParents(tx, workspaceId, ancestry.roots);
        if (ancestry.roots.some(input => forbidden.has(JSON.stringify([input.kind, input.id])))
          || parents.some(parent => forbidden.has(JSON.stringify(["BrainArticle", parent.articleId])))) continue;
        const source = sourceProjection(kind, row);
        if (source) admitted.push({ kind, row, source, roots });
      } catch (error) {
        if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "PERMISSION_CHANGED", "SOURCE_RESTRICTED"].includes(error.code)) throw error;
      }
    }
  }
  if (!admitted.length) return null;
  const extra = additionalInputs.length ? await captureArtifactInputProof(actor, workspaceId, [...additionalInputs], tx) : [];
  const roots = mergeArtifactInputProofs(...admitted.map(input => input.roots), extra);
  const ancestry = await inspectStoredArtifactInputDependencies(tx, workspaceId, roots);
  invariant(ancestry.complete && ancestry.roots.length <= 5000, 409, "UNKNOWN_LINEAGE", "Derivation ancestry is unproven.");
  await lockDerivationInputs(tx, workspaceId, ancestry.roots);
  await lockActiveArticleSources(tx, workspaceId, admitted.filter(input => input.kind === "BrainSource").map(input => input.row.id));
  await assertArtifactInputWriteFence(tx);
  const current = await captureArtifactInputProof(actor, workspaceId,
    [...admitted.map(input => ({ kind: input.kind, id: input.row.id, snapshot: input.row })), ...additionalInputs], tx);
  invariant(derivationHash(derivationRootSignature(current)) === derivationHash(derivationRootSignature(roots)),
    409, "SOURCE_CHANGED", "Derivation inputs changed while locking.");
  for (const input of admitted.filter(input => ORIGINAL_ONLY_KINDS.has(input.kind))) {
    const receipt = await tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: input.kind, artifactId: input.row.id }, orderBy: { revision: "desc" } });
    invariant(receipt?.origin === "HUMAN_ORIGINAL" && receipt.contentHash === lineageContentFingerprint(input.kind, input.row)
      && Array.isArray(receipt.rootsJson) && receipt.rootsJson.length === 0, 409, "SOURCE_CHANGED", "Source authorship changed.");
  }
  return { sources: admitted.map(input => input.source), roots: current,
    sourceIdentities: admitted.map(input => ({ kind: input.kind, id: input.row.id,
      fingerprint: input.roots.find(root => root.kind === input.kind && root.id === input.row.id)!.fingerprint })),
    archiveStates: await derivationArchiveStates(tx, workspaceId, ancestry.roots),
    permissionEpochs: await captureArtifactPermissionEpochs(actor, workspaceId, current, tx) };
}
