import { createHash, randomUUID } from "node:crypto";
import { Prisma, type BrainArticle } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { lockActiveArticleSources } from "./brain-source-links";
import { AppError, invariant } from "./errors";
import { appendEvents } from "./events";
import { ensureWorkspacePermalink, workspaceEntityCanonicalPath } from "./permalinks";
import { mergeArtifactInputProofs } from "./digest-lineage";
import { meetingTranscriptInputProjection } from "./meeting-intelligence-context";
import { parsePermissionEpochProof } from "./source-permission-epochs";
import { lockWorkspaceMembership } from "./workspace-support-access";
import { lockArtifactReadAuthorityRows, prepareArtifactCommitPreflight, withArtifactCommitPreflight,
  type ArtifactCommitPreflight } from "./artifact-commit-preflight";
import {
  assertArtifactInputWriteFence,
  assertArtifactInputClosureLocallyAdmissible,
  captureArtifactInputProof,
  currentArtifactInputRoots,
  inspectStoredArtifactInputDependencies,
  isArtifactInputProofReadable,
  lineageContentFingerprint,
  readableArtifactIds,
  recordArtifactInputLineage,
  type LineageKind,
  type LineageRoot,
} from "./source-lineage";

export const BRAIN_ARTICLE_VARIANT_JOB_TYPE = "agent.brain-article-variant";

/** Explicit current source families; target content and generated variants are never candidates. */
export const BRAIN_ARTICLE_VARIANT_SOURCE_KINDS = ["BrainSource", "Document", "MeetingTranscript", "CommunicationMessage",
  "ConversationPromptInput", "ConversationIngressInput", "AgentRequestInput", "BrainArticle", "Role", "Circle", "Action", "Tension", "Goal"] as const;
export type BrainArticleVariantSourceKind = typeof BRAIN_ARTICLE_VARIANT_SOURCE_KINDS[number];
/** The model receives only independently permitted, explicitly projected source content. */
export type PermittedVariantSource = {
  kind: BrainArticleVariantSourceKind;
  id: string;
  title: string | null;
  content: string;
  ingestionGuidanceMd: string | null;
  sourceType?: string;
  tier?: number;
};

type RecipeIdentity = { articleId: string; memberId: string; userId: string; targetFingerprint: string;
  inputSetHash: string; sourceState: Record<string, string> };
export type BrainArticleVariantRecipeV1 = RecipeIdentity & { version: 1; sources: Array<{ id: string; fingerprint: string }> };
export type BrainArticleVariantRecipeV2 = RecipeIdentity & { version: 2;
  sources: Array<{ kind: BrainArticleVariantSourceKind; id: string; fingerprint: string }> };
type VariantRecipe = BrainArticleVariantRecipeV1 | BrainArticleVariantRecipeV2;
type VariantPayload = VariantRecipe & {
  phase: "REQUESTED" | "GENERATING" | "APPLIED" | "STALE";
  generationToken?: string;
  variantArticleId?: string;
};
type PreparedVariant = { recipe: BrainArticleVariantRecipeV2; roots: LineageRoot[]; sources: PermittedVariantSource[] };
type Preparation = PreparedVariant | { unavailable: true } | { original: true };
type UserActor = Extract<AppActor, { kind: "user" }>;
type CandidateRow = { id: string; [key: string]: unknown };
type NativeVariantScope = { roots: LineageRoot[]; preflight: ArtifactCommitPreflight } | null;
const REMOTE_NATIVE_KINDS = new Set<LineageKind>([
  "CommunicationMessageNativeInput", "ExternalProviderFetchInput", "ExternalMcpResponseInput",
]);

/** Replay only a reader's currently permitted native leaves before opening a
 * variant transaction. Saved roots retain their consumed epoch vectors. */
async function prepareNativeVariantScope(actor: UserActor, workspaceId: string,
  articleId: string, lockPlan: VariantLockPlan | null): Promise<NativeVariantScope> {
  if (!lockPlan) return null;
  const target = await prisma.brainArticle.findFirst({ where: { id: articleId, workspaceId, archivedAt: null } });
  if (!target || target.variantOfArticleId) return null;
  const manifest = await prisma.artifactInputLineage.findFirst({ where: {
    workspaceId, artifactType: "BrainArticle", artifactId: articleId,
  }, orderBy: { revision: "desc" } });
  if (!manifest || manifest.origin !== "DERIVED" || manifest.contentHash !== lineageContentFingerprint("BrainArticle", target)
    || manifest.epochProofVersion !== 1 || !parsePermissionEpochProof(manifest.permissionEpochsJson)) return null;
  const roots = await currentArtifactInputRoots(prisma, workspaceId, { kind: "BrainArticle", id: articleId }, target);
  if (!roots?.length) return null;
  const dependencies = await inspectStoredArtifactInputDependencies(prisma, workspaceId, roots, { maxNodes: 5000 });
  if (!dependencies.complete || dependencies.roots.length > 5000) return null;
  const nativeDependencies = new Map<string, LineageRoot>();
  for (const root of [...dependencies.roots,
    ...lockPlan.lockRoots.filter(root => REMOTE_NATIVE_KINDS.has(root.kind) && root.fingerprint.length === 64)])
    nativeDependencies.set(`${root.kind}:${root.id}:${root.fingerprint}`, root);
  const vectorParents = [...roots, ...lockPlan.currentNativeParents].filter(root => root.permissionEpochs !== undefined);
  if (vectorParents.length > 5000) return null;
  const candidateParents = new Map<string, LineageRoot>();
  const locallyAdmitted = new Map<string, LineageRoot>();
  const enclosingCache = new Map<string, Awaited<ReturnType<typeof inspectStoredArtifactInputDependencies>>>();
  let enclosingNodes = 0;
  let ancestryChecks = 0;
  for (const dependency of [...nativeDependencies.values()].filter(root => REMOTE_NATIVE_KINDS.has(root.kind))) {
    // Traversal can first discover the leaf through a parent's saved manifest,
    // which omits the epoch vector on the canonical's directly consumed root.
    // Keep every independently viable original vector. The first enclosing
    // source can be revoked while another current source remains permitted.
    for (const parent of vectorParents) {
      if (++ancestryChecks > 25_000) return null;
      if (parent.kind === dependency.kind && parent.id === dependency.id
        && parent.fingerprint === dependency.fingerprint) {
        candidateParents.set(JSON.stringify(rootSignature([parent])), parent);
        continue;
      }
      const key = `${parent.kind}:${parent.id}:${parent.fingerprint}`;
      let enclosing = enclosingCache.get(key);
      if (!enclosing) {
        enclosing = await inspectStoredArtifactInputDependencies(prisma, workspaceId, [parent], { maxNodes: 5000 });
        enclosingCache.set(key, enclosing);
        enclosingNodes += enclosing.roots.length;
        if (enclosingNodes > 10_000) return null;
      }
      // The vector belongs to this exact saved, enclosing source revision.
      // A native leaf discovered transitively never receives fresh epochs.
      if (enclosing.complete && enclosing.roots.some(candidate => candidate.kind === dependency.kind
        && candidate.id === dependency.id && candidate.fingerprint === dependency.fingerprint)) {
        candidateParents.set(JSON.stringify(rootSignature([parent])), parent);
      }
    }
  }
  // Admit the entire local candidate set before the first provider replay,
  // including each alternative saved vector for a shared native leaf.
  for (const root of candidateParents.values()) {
    try {
      await assertArtifactInputClosureLocallyAdmissible(actor, workspaceId, [root]);
      locallyAdmitted.set(JSON.stringify(rootSignature([root])), root);
    } catch (error) { if (!isStaleError(error)) throw error; }
  }
  const available: LineageRoot[] = [];
  // Complete local admission finishes before the first provider replay.
  for (const root of locallyAdmitted.values()) {
    try { if (await isArtifactInputProofReadable(actor, workspaceId, [root])) available.push(root); }
    catch (error) { if (!isStaleError(error)) throw error; }
  }
  if (!available.length) return null;
  try { return { roots: available, preflight: await prepareArtifactCommitPreflight(actor, workspaceId, available) }; }
  catch (error) { if (isStaleError(error)) return null; throw error; }
}

async function withNativeVariantScope<T>(actor: UserActor, workspaceId: string, tx: Prisma.TransactionClient,
  scope: NativeVariantScope, plan: VariantLockPlan | null, beforeSourceEpochs: () => Promise<void>, work: () => Promise<T>): Promise<T> {
  invariant(plan, 409, "SOURCE_CHANGED", "Article input locks could not be planned.");
  // Canonical plans reserve archive heads before physical rows. Reserve the
  // complete local union before native adapters or Workspace/authority locks.
  await reserveVariantArchiveLocks(tx, plan.lockRoots);
  return scope ? withArtifactCommitPreflight(actor, workspaceId, tx, scope.roots, scope.preflight, work, { beforeSourceEpochs })
    : beforeSourceEpochs().then(work);
}
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
  ConversationIngressInput: "ConversationIngressInput", ConversationSession: "ConversationSession",
  AgentRequestInput: "AgentRequestInput", ArtifactInputSnapshot: "ArtifactInputSnapshot", MeetingAudioAsset: "MeetingAudioAsset",
  // Immutable native custody still requires existing member and source proof.
  NativeTranscriptInput: "NativeTranscriptInput", BrainArticleVersion: "BrainArticleVersion",
};
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function rootSignature(roots: readonly LineageRoot[]) {
  // Restored permissions require a fresh recipe even when source bytes match.
  return roots.map(({ kind, id, fingerprint, permissionEpochs }) => [kind, id, fingerprint, permissionEpochs ?? null]).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
function stateSignature(states: Record<string, string>) {
  return Object.entries(states).sort(([left], [right]) => left.localeCompare(right));
}
function isSourceKind(kind: unknown): kind is BrainArticleVariantSourceKind {
  return typeof kind === "string" && (BRAIN_ARTICLE_VARIANT_SOURCE_KINDS as readonly string[]).includes(kind);
}
function readPayload(value: Prisma.JsonValue): VariantPayload {
  const payload = value as Partial<VariantPayload> | null;
  invariant((payload?.version === 1 || payload?.version === 2) && typeof payload.articleId === "string" && typeof payload.memberId === "string"
    && typeof payload.userId === "string" && /^[a-f0-9]{64}$/.test(payload.targetFingerprint ?? "")
    && /^[a-f0-9]{64}$/.test(payload.inputSetHash ?? "") && Array.isArray(payload.sources)
    && payload.sources.length > 0 && payload.sources.every((source) => source && typeof source.id === "string"
      && /^[a-f0-9]{64}$/.test(source.fingerprint)
      && (payload.version === 1 || ("kind" in source && isSourceKind(source.kind))))
    && payload.sourceState && typeof payload.sourceState === "object" && !Array.isArray(payload.sourceState)
    && Object.values(payload.sourceState).every((state) => typeof state === "string" && /^[a-f0-9]{64}$/.test(state))
    && ["REQUESTED", "GENERATING", "APPLIED", "STALE"].includes(payload.phase ?? ""),
  409, "INVALID_VARIANT_REQUEST", "The article variant recipe is invalid.");
  return payload as VariantPayload;
}
function sameRecipe(left: VariantRecipe, right: VariantRecipe) {
  return left.version === right.version && left.articleId === right.articleId && left.memberId === right.memberId && left.userId === right.userId
    && left.targetFingerprint === right.targetFingerprint && left.inputSetHash === right.inputSetHash
    && hash(left.sources.map((source) => ["kind" in source ? source.kind : "BrainSource", source.id, source.fingerprint]))
      === hash(right.sources.map((source) => ["kind" in source ? source.kind : "BrainSource", source.id, source.fingerprint]))
    && hash(stateSignature(left.sourceState)) === hash(stateSignature(right.sourceState));
}
/** Version bodies remain historical evidence; only their parent identity is needed for exclusion/epochs. */
async function versionParents(tx: Prisma.TransactionClient, workspaceId: string, roots: readonly LineageRoot[]) {
  const ids = [...new Set(roots.filter((root) => root.kind === "BrainArticleVersion").map((root) => root.id))].sort();
  return ids.length ? tx.brainArticleVersion.findMany({ where: { article: { workspaceId }, id: { in: ids } }, select: { id: true, articleId: true } }) : [];
}

async function sourceArchiveStates(tx: Prisma.TransactionClient, workspaceId: string, roots: readonly LineageRoot[]) {
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
    states[key] = hash(history);
  }
  return states;
}
async function loadCandidates(tx: Prisma.TransactionClient, workspaceId: string, kind: BrainArticleVariantSourceKind,
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
function sourceProjection(kind: BrainArticleVariantSourceKind, row: CandidateRow): PermittedVariantSource | null {
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
async function reserveVariantArchiveLocks(tx: Prisma.TransactionClient, roots: readonly LineageRoot[]) {
  const archiveTables = new Set(Object.values(ARCHIVE_ENTITY_TYPES));
  const keys = new Set<string>();
  for (const root of roots) {
    const table = INPUT_TABLES[root.kind];
    if (table && archiveTables.has(table)) keys.add(`workspace_archive:${table}:${root.id}`);
  }
  for (const key of [...keys].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
async function lockVariantInputs(tx: Prisma.TransactionClient, workspaceId: string, roots: readonly LineageRoot[]) {
  const identities = new Map<string, { table: string; id: string }>();
  for (const root of roots) {
    const table = INPUT_TABLES[root.kind];
    if (table) identities.set(JSON.stringify([table, root.id]), { table, id: root.id });
  }
  // Source removal owns Source -> Document -> Article. Immutable native
  // custody precedes those rows, matching canonical source-plan ordering.
  const phase = (table: string) => table === "NativeTranscriptInput" ? -1 : table === "BrainSource" ? 0 : table === "Document" ? 1
    : table === "BrainArticle" ? 3 : 2;
  for (const { table, id } of [...identities.values()].sort((left, right) =>
    phase(left.table) - phase(right.table) || left.table.localeCompare(right.table) || left.id.localeCompare(right.id))) {
    // Identifiers originate only in the static table allowlist; values remain SQL parameters.
    if (table === "Role") {
      await tx.$queryRaw`SELECT r.id FROM "Role" r JOIN "Circle" c ON c.id = r."circleId" WHERE r.id = ${id} AND c."workspaceId" = ${workspaceId} FOR UPDATE OF r`;
    } else if (table === "BrainArticleVersion") {
      await tx.$queryRaw`SELECT v.id FROM "BrainArticleVersion" v JOIN "BrainArticle" a ON a.id = v."articleId" WHERE v.id = ${id} AND a."workspaceId" = ${workspaceId} FOR UPDATE OF v`;
    } else {
      // Match native input SHARE locks; upgrading a held read lock could
      // deadlock concurrent permitted readers of the same immutable custody.
      const mode = table === "CommunicationMessage" || table === "NativeTranscriptInput" ? "FOR SHARE" : "FOR UPDATE";
      await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id} AND "workspaceId" = ${workspaceId} ${Prisma.raw(mode)}`);
    }
  }
}

type VariantLockPlan = { manifestId: string; targetFingerprint: string; dependencySignature: string;
  candidateSignature: string; lockSignature: string; lockRoots: LineageRoot[]; currentNativeParents: LineageRoot[] };
const LOCK_PLAN_NATIVE_KINDS = new Set<LineageKind>(["CommunicationMessageNativeInput",
  "ExternalProviderFetchInput", "ExternalMcpResponseInput", "ExternalMcpConnectionSet"]);

/** Identity-only plan; it grants no read and performs no native replay. */
async function planVariantLocks(db: Prisma.TransactionClient | typeof prisma, workspaceId: string,
  articleId: string): Promise<VariantLockPlan | null> {
  const target = await db.brainArticle.findFirst({ where: { id: articleId, workspaceId, archivedAt: null } });
  if (!target || target.variantOfArticleId) return null;
  const targetFingerprint = lineageContentFingerprint("BrainArticle", target);
  const manifest = await db.artifactInputLineage.findFirst({ where: {
    workspaceId, artifactType: "BrainArticle", artifactId: articleId,
  }, orderBy: { revision: "desc" } });
  if (!manifest || manifest.contentHash !== targetFingerprint
    || (manifest.origin === "DERIVED" && (manifest.epochProofVersion !== 1
      || !parsePermissionEpochProof(manifest.permissionEpochsJson)))
    || !["DERIVED", "HUMAN_ORIGINAL"].includes(manifest.origin)) return null;
  const roots = await currentArtifactInputRoots(db, workspaceId, { kind: "BrainArticle", id: articleId }, target);
  if (!roots || (manifest.origin === "DERIVED" && !roots.length)) return null;
  if (manifest.origin === "HUMAN_ORIGINAL" && (manifest.epochProofVersion !== 1
    || !parsePermissionEpochProof(manifest.permissionEpochsJson) || roots.length !== 0
    || !Array.isArray(manifest.inputsJson) || manifest.inputsJson.length !== 0)) return null;
  if (manifest.origin === "HUMAN_ORIGINAL" && roots.length === 0
    && Array.isArray(manifest.inputsJson) && manifest.inputsJson.length === 0) return {
    manifestId: manifest.id, targetFingerprint, dependencySignature: "[]", candidateSignature: "[]",
    lockSignature: JSON.stringify([JSON.stringify(["BrainArticle", articleId])]),
    lockRoots: [{ kind: "BrainArticle", id: articleId, fingerprint: targetFingerprint }], currentNativeParents: [],
  };
  const dependencies = await inspectStoredArtifactInputDependencies(db, workspaceId, roots, { maxNodes: 5000 });
  if (!dependencies.complete || dependencies.roots.length > 5000) return null;
  const storedIdentities = new Set(dependencies.roots.map(root => `${root.kind}:${root.id}:${root.fingerprint}`));
  const candidateRoots: LineageRoot[] = [];
  const currentNativeParents: LineageRoot[] = [];
  const candidateStates: unknown[] = [];
  for (const kind of BRAIN_ARTICLE_VARIANT_SOURCE_KINDS) {
    const ids = [...new Set(dependencies.roots.filter(root => root.kind === kind).map(root => root.id))].sort();
    if (!ids.length) continue;
    const rows = await loadCandidates(db as Prisma.TransactionClient, workspaceId, kind, ids);
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) { candidateStates.push([kind, id, null]); continue; }
      const fingerprint = lineageContentFingerprint(kind, row);
      const identity = `${kind}:${id}:${fingerprint}`;
      // A current candidate can append a different native-derived manifest
      // while retaining its content fingerprint. Its latest saved roots and
      // physical ancestors therefore belong in the plan even if the canonical
      // only contains an immutable snapshot of an older original.
      const currentRoots = await currentArtifactInputRoots(db, workspaceId, { kind, id }, row);
      candidateStates.push([kind, id, fingerprint, storedIdentities.has(identity) ? "stored" : "changed",
        currentRoots === null ? null : rootSignature(currentRoots)]);
      if (currentRoots) currentNativeParents.push(...currentRoots.filter(root => root.permissionEpochs !== undefined));
      candidateRoots.push({ kind, id, fingerprint });
    }
  }
  const candidateDependencies = await inspectStoredArtifactInputDependencies(db, workspaceId, candidateRoots, { maxNodes: 5000 });
  // An unreadable candidate still has an identity to lock. Its incomplete
  // ancestry is rejected by admission, not allowed to expand under our locks.
  const allDependencies = new Map<string, LineageRoot>();
  for (const root of [...dependencies.roots, ...candidateDependencies.roots])
    allDependencies.set(`${root.kind}:${root.id}:${root.fingerprint}`, root);
  if (allDependencies.size > 5000) return null;
  const lockRoots: LineageRoot[] = [...allDependencies.values(),
    { kind: "BrainArticle", id: articleId, fingerprint: targetFingerprint }];
  for (const root of lockRoots) {
    if (!INPUT_TABLES[root.kind] && !LOCK_PLAN_NATIVE_KINDS.has(root.kind)) return null;
    if (root.kind === "BrainSource") {
      const row = await db.brainSource.findFirst({ where: { id: root.id, workspaceId }, select: { metadata: true } });
      if (!row) return null;
      const metadata = row.metadata;
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)
        && typeof (metadata as Record<string, unknown>).documentId === "string")
        lockRoots.push({ kind: "Document", id: (metadata as Record<string, string>).documentId, fingerprint: "" });
    } else if (root.kind === "Role") {
      const role = await db.role.findFirst({ where: { id: root.id, circle: { workspaceId } }, select: { circleId: true } });
      if (!role) return null;
      lockRoots.push({ kind: "Circle", id: role.circleId, fingerprint: "" });
    } else if (root.kind === "BrainArticleVersion") {
      const version = await db.brainArticleVersion.findFirst({ where: { id: root.id, article: { workspaceId } }, select: { articleId: true } });
      if (!version) return null;
      lockRoots.push({ kind: "BrainArticle", id: version.articleId, fingerprint: "" });
    } else if (root.kind === "ArtifactInputSnapshot") {
      const snapshot = await db.artifactInputSnapshot.findFirst({ where: { id: root.id, workspaceId },
        select: { sourceKind: true, sourceId: true } });
      if (!snapshot || !(snapshot.sourceKind in INPUT_TABLES || LOCK_PLAN_NATIVE_KINDS.has(snapshot.sourceKind as LineageKind))) return null;
      if (snapshot.sourceKind in INPUT_TABLES) lockRoots.push({ kind: snapshot.sourceKind as LineageKind,
        id: snapshot.sourceId, fingerprint: "" });
    } else if (root.kind === "ConversationPromptInput") {
      const prompt = await db.conversationPromptInput.findFirst({ where: { id: root.id, workspaceId }, select: { sessionId: true } });
      if (!prompt) return null;
      lockRoots.push({ kind: "ConversationSession", id: prompt.sessionId, fingerprint: "" });
    }
  }
  const lockSignature = JSON.stringify([...new Set(lockRoots.filter(root => INPUT_TABLES[root.kind])
    .map(root => JSON.stringify([INPUT_TABLES[root.kind], root.id])))].sort());
  return { manifestId: manifest.id, targetFingerprint, dependencySignature: JSON.stringify(rootSignature([...allDependencies.values()])),
    candidateSignature: JSON.stringify(candidateStates), lockSignature, lockRoots, currentNativeParents };
}

async function lockPlannedVariantInputs(tx: Prisma.TransactionClient, workspaceId: string,
  articleId: string, plan: VariantLockPlan | null) {
  invariant(plan, 409, "SOURCE_CHANGED", "Article input locks could not be planned.");
  await lockVariantInputs(tx, workspaceId, plan.lockRoots);
  const current = await planVariantLocks(tx, workspaceId, articleId);
  invariant(current && current.manifestId === plan.manifestId && current.targetFingerprint === plan.targetFingerprint
    && current.dependencySignature === plan.dependencySignature && current.candidateSignature === plan.candidateSignature
    && current.lockSignature === plan.lockSignature,
  409, "SOURCE_CHANGED", "Article input links changed before their locks were acquired.");
}

async function lockVariantAuthorityBeforeEpochs(tx: Prisma.TransactionClient, actor: UserActor,
  workspaceId: string, articleId: string, plan: VariantLockPlan | null) {
  await lockArtifactReadAuthorityRows(actor, workspaceId, tx);
  await lockWorkspaceMembership(tx, workspaceId);
  await lockPlannedVariantInputs(tx, workspaceId, articleId, plan);
}

/** Internal ancestry inspection supplies identities, never canonical content to the model. */
async function prepareVariant(tx: Prisma.TransactionClient, actor: UserActor, workspaceId: string,
  articleId: string, lockPlan: VariantLockPlan): Promise<Preparation> {
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
  invariant(membership?.isActive, 403, "NOT_A_MEMBER", "Active membership is required.");
  const target = await tx.brainArticle.findFirst({ where: { id: articleId, workspaceId, archivedAt: null } });
  if (!target || target.variantOfArticleId || (target.isPrivate && target.ownerMemberId !== membership.id
    && membership.role !== "ADMIN")) return { unavailable: true };
  const targetFingerprint = lineageContentFingerprint("BrainArticle", target);
  const manifest = await tx.artifactInputLineage.findFirst({ where: {
    workspaceId, artifactType: "BrainArticle", artifactId: articleId,
  }, orderBy: { revision: "desc" } });
  // Empty legacy/UNKNOWN receipts do not establish original authorship.
  if (!manifest || manifest.contentHash !== targetFingerprint || !Array.isArray(manifest.rootsJson)) return { unavailable: true };
  if (manifest.origin === "HUMAN_ORIGINAL" && manifest.rootsJson.length === 0
    && Array.isArray(manifest.inputsJson) && manifest.inputsJson.length === 0
    && manifest.epochProofVersion === 1 && parsePermissionEpochProof(manifest.permissionEpochsJson))
    return (await readableArtifactIds(actor, workspaceId, "BrainArticle", [target], tx)).has(target.id)
      ? { original: true } : { unavailable: true };
  if (manifest.origin !== "DERIVED" || !manifest.rootsJson.length || manifest.epochProofVersion !== 1
    || !parsePermissionEpochProof(manifest.permissionEpochsJson)) return { unavailable: true };
  const priorRoots = await currentArtifactInputRoots(tx, workspaceId, { kind: "BrainArticle", id: articleId }, target);
  if (!priorRoots?.length) return { unavailable: true };
  if ((await readableArtifactIds(actor, workspaceId, "BrainArticle", [target], tx)).has(target.id)) return { original: true };
  const dependencies = await inspectStoredArtifactInputDependencies(tx, workspaceId, priorRoots);
  if (!dependencies.complete) return { unavailable: true };
  invariant(dependencies.roots.length <= 5000, 503, "INPUT_SCAN_LIMIT", "Article variant dependency collection exceeds its supported size.");
  const candidates = new Map<BrainArticleVariantSourceKind, Set<string>>();
  for (const root of dependencies.roots) {
    if (!isSourceKind(root.kind) || (root.kind === "BrainArticle" && root.id === articleId)) continue;
    const ids = candidates.get(root.kind) ?? new Set<string>(); ids.add(root.id); candidates.set(root.kind, ids);
  }
  const admitted: Array<{ kind: BrainArticleVariantSourceKind; row: CandidateRow; source: PermittedVariantSource; roots: LineageRoot[] }> = [];
  for (const [kind, ids] of [...candidates].sort(([left], [right]) => left.localeCompare(right))) {
    const rows = await loadCandidates(tx, workspaceId, kind, [...ids].sort());
    for (const row of rows.sort((left, right) => left.id.localeCompare(right.id))) {
      if (ORIGINAL_ONLY_KINDS.has(kind)) {
        const receipt = await tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: kind, artifactId: row.id }, orderBy: { revision: "desc" } });
        if (!receipt || receipt.origin !== "HUMAN_ORIGINAL" || receipt.contentHash !== lineageContentFingerprint(kind, row)
          || !Array.isArray(receipt.rootsJson) || receipt.rootsJson.length) continue;
      }
      try {
        const proof = await captureArtifactInputProof(actor, workspaceId, [{ kind, id: row.id, snapshot: row }], tx);
        const inputDependencies = await inspectStoredArtifactInputDependencies(tx, workspaceId, proof);
        invariant(inputDependencies.complete, 409, "UNKNOWN_LINEAGE", "A current source has incomplete ancestry.");
        invariant(inputDependencies.roots.length <= 5000, 503, "INPUT_SCAN_LIMIT", "Current source ancestry exceeds its supported size.");
        const parents = await versionParents(tx, workspaceId, inputDependencies.roots);
        // A copied wrapper must not smuggle an older canonical body back into its rebuild.
        if (inputDependencies.roots.some((root) => root.kind === "BrainArticle" && root.id === articleId)
          || parents.some((parent) => parent.articleId === articleId)) continue;
        const source = sourceProjection(kind, row);
        if (source) admitted.push({ kind, row, source, roots: proof });
      } catch (error) { if (!(error instanceof AppError) || !["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(error.code)) throw error; }
    }
  }
  if (!admitted.length) return { unavailable: true };
  const roots = mergeArtifactInputProofs(...admitted.map((input) => input.roots));
  const sourceDependencies = await inspectStoredArtifactInputDependencies(tx, workspaceId, roots);
  invariant(sourceDependencies.complete, 409, "UNKNOWN_LINEAGE", "A permitted source has incomplete ancestry.");
  invariant(roots.length <= 5000 && sourceDependencies.roots.length <= 5000, 503, "INPUT_SCAN_LIMIT",
    "Current article variant ancestry exceeds its supported size.");
  // The exact physical source union was locked before the first epoch read.
  // A newly discovered source is never locked late after proof acquisition.
  const planned = new Set(lockPlan.lockRoots.map(root => `${INPUT_TABLES[root.kind] ?? root.kind}:${root.id}`));
  invariant(sourceDependencies.roots.every(root => planned.has(`${INPUT_TABLES[root.kind] ?? root.kind}:${root.id}`)),
    409, "SOURCE_CHANGED", "Article source ancestry expanded after its locks were planned.");
  await lockActiveArticleSources(tx, workspaceId, admitted.filter((input) => input.kind === "BrainSource").map((input) => input.row.id));
  await tx.$queryRaw`SELECT id FROM "BrainArticle" WHERE id = ${articleId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  await assertArtifactInputWriteFence(tx);
  // Re-capture after native locks and the write fence: neither identical body
  // hashes nor previously readable ancestors can substitute for the current manifest.
  // Re-capture each admitted source separately, as in the initial admission.
  // A single combined capture can replace an overlapping saved native vector
  // with the current reader's narrower vector before comparing the union.
  const lockedProofs: LineageRoot[][] = [];
  for (const input of admitted) lockedProofs.push(await captureArtifactInputProof(actor, workspaceId,
    [{ kind: input.kind, id: input.row.id, snapshot: input.row }], tx));
  const lockedRoots = mergeArtifactInputProofs(...lockedProofs);
  invariant(hash(rootSignature(lockedRoots)) === hash(rootSignature(roots)),
    409, "SOURCE_CHANGED", "Article source ancestry changed while locking its inputs.");
  for (const input of admitted.filter((input) => ORIGINAL_ONLY_KINDS.has(input.kind))) {
    const receipt = await tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: input.kind, artifactId: input.row.id }, orderBy: { revision: "desc" } });
    invariant(receipt?.origin === "HUMAN_ORIGINAL" && receipt.contentHash === lineageContentFingerprint(input.kind, input.row)
      && Array.isArray(receipt.rootsJson) && receipt.rootsJson.length === 0,
    409, "SOURCE_CHANGED", "An independently authored source changed while locking its inputs.");
  }
  const lockedTarget = await tx.brainArticle.findFirst({ where: { id: articleId, workspaceId, archivedAt: null } });
  const lockedManifest = await tx.artifactInputLineage.findFirst({ where: { workspaceId, artifactType: "BrainArticle", artifactId: articleId }, orderBy: { revision: "desc" } });
  invariant(lockedTarget && lineageContentFingerprint("BrainArticle", lockedTarget) === targetFingerprint
    && lockedManifest?.id === manifest.id && lockedManifest.origin === "DERIVED"
    && await isArtifactInputProofReadable(actor, workspaceId, roots, tx),
  409, "SOURCE_CHANGED", "Article variant inputs changed during preparation.");
  const sourceState = await sourceArchiveStates(tx, workspaceId, sourceDependencies.roots);
  const inputSetHash = hash([2, rootSignature(roots), stateSignature(sourceState)]);
  return { recipe: { version: 2, articleId, memberId: membership.id, userId: actor.user.id, targetFingerprint, inputSetHash, sourceState,
    sources: admitted.map((input) => ({ kind: input.kind, id: input.row.id,
      fingerprint: input.roots.find((root) => root.kind === input.kind && root.id === input.row.id)!.fingerprint })),
  }, roots, sources: admitted.map((input) => input.source) };
}

async function existingVariant(tx: Prisma.TransactionClient, actor: UserActor, workspaceId: string,
  recipe: VariantRecipe): Promise<{ article: BrainArticle; readable: boolean } | null> {
  const article = await tx.brainArticle.findFirst({ where: { workspaceId, variantOfArticleId: recipe.articleId,
    ownerMemberId: recipe.memberId, variantTargetFingerprint: recipe.targetFingerprint, variantInputSetHash: recipe.inputSetHash,
  } });
  if (!article) return null;
  const readable = article.isPrivate && !article.archivedAt && article.ownerMemberId === recipe.memberId
    && article.variantSourceStateJson !== null && typeof article.variantSourceStateJson === "object" && !Array.isArray(article.variantSourceStateJson)
    && hash(stateSignature(article.variantSourceStateJson as Record<string, string>)) === hash(stateSignature(recipe.sourceState))
    && (await readableArtifactIds(actor, workspaceId, "BrainArticle", [article], tx)).has(article.id);
  return { article, readable };
}

function isStaleError(error: unknown) {
  return error instanceof AppError && ["SOURCE_CHANGED", "UNKNOWN_LINEAGE", "SOURCE_RESTRICTED", "NOT_A_MEMBER", "FORBIDDEN",
    "SUPPORT_CONTENT_RESTRICTED", "SUPPORT_AUTHORIZATION_REVOKED", "WORKSPACE_SCOPE_MISMATCH"].includes(error.code);
}

/** Read fallback can enqueue this without revealing any canonical title, body, source count, or path. */
export async function requestBrainArticleVariant(actor: AppActor, params: { workspaceId: string; articleId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  if (actor.kind !== "user") return { status: "unavailable" as const };
  const lockPlan = await planVariantLocks(prisma, params.workspaceId, params.articleId);
  const nativeScope = await prepareNativeVariantScope(actor, params.workspaceId, params.articleId, lockPlan);
  try { return await prisma.$transaction(async (tx) => {
    return withNativeVariantScope(actor, params.workspaceId, tx, nativeScope, lockPlan,
      () => lockVariantAuthorityBeforeEpochs(tx, actor, params.workspaceId, params.articleId, lockPlan), async () => {
    let prepared: Preparation;
    try { prepared = await prepareVariant(tx, actor, params.workspaceId, params.articleId, lockPlan!); }
    catch (error) { if (isStaleError(error)) return { status: "unavailable" as const }; throw error; }
    if ("unavailable" in prepared) return { status: "unavailable" as const };
    if ("original" in prepared) return { status: "original" as const };
    const prior = await existingVariant(tx, actor, params.workspaceId, prepared.recipe);
    // An archived/unproven variant is preserved, never overwritten or automatically restored.
    if (prior) return prior.readable ? { status: "available" as const, articleId: prior.article.id } : { status: "unavailable" as const };
    const dedupeKey = `brain-article-variant:v2:${params.workspaceId}:${prepared.recipe.memberId}:${params.articleId}:${prepared.recipe.targetFingerprint}:${prepared.recipe.inputSetHash}`;
    const existing = await tx.workflowJob.findUnique({ where: { dedupeKey } });
    if (existing) {
      if (existing.status === "FAILED" || existing.status === "COMPLETED" || readPayload(existing.payload).phase === "STALE") {
        await tx.workflowJob.update({ where: { id: existing.id }, data: { status: "PENDING",
          payload: { ...prepared.recipe, phase: "REQUESTED" } as Prisma.InputJsonObject,
          lockedAt: null, lockedBy: null, completedAt: null, error: null, runAfter: new Date() } });
      }
      return { status: "pending" as const, jobId: existing.id };
    }
    const job = await tx.workflowJob.create({ data: { workspaceId: params.workspaceId,
      type: BRAIN_ARTICLE_VARIANT_JOB_TYPE, dedupeKey,
      payload: { ...prepared.recipe, phase: "REQUESTED" } as Prisma.InputJsonObject } });
    return { status: "pending" as const, jobId: job.id };
    });
  }, { maxWait: 5_000, timeout: 120_000 }); }
  catch (error) { if (isStaleError(error)) return { status: "unavailable" as const }; throw error; }
}

export async function getReadableBrainArticleVariant(actor: AppActor, params: { workspaceId: string; articleId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  if (actor.kind !== "user") return null;
  const lockPlan = await planVariantLocks(prisma, params.workspaceId, params.articleId);
  const nativeScope = await prepareNativeVariantScope(actor, params.workspaceId, params.articleId, lockPlan);
  try { return await prisma.$transaction(async (tx) => {
    return withNativeVariantScope(actor, params.workspaceId, tx, nativeScope, lockPlan,
      () => lockVariantAuthorityBeforeEpochs(tx, actor, params.workspaceId, params.articleId, lockPlan), async () => {
    try {
      const prepared = await prepareVariant(tx, actor, params.workspaceId, params.articleId, lockPlan!);
      if (!("recipe" in prepared)) return null;
      const prior = await existingVariant(tx, actor, params.workspaceId, prepared.recipe);
      return prior?.readable ? prior.article : null;
    } catch (error) { if (isStaleError(error)) return null; throw error; }
    });
  }, { maxWait: 5_000, timeout: 120_000 }); }
  catch (error) { if (isStaleError(error)) return null; throw error; }
}

async function ownerActor(tx: Prisma.TransactionClient | typeof prisma, workspaceId: string, recipe: VariantRecipe): Promise<UserActor> {
  const member = await tx.member.findFirst({ where: { id: recipe.memberId, workspaceId, userId: recipe.userId, isActive: true },
    include: { user: { select: { id: true, email: true, displayName: true, globalRole: true } } } });
  invariant(member?.user && member.id === recipe.memberId && member.userId === recipe.userId,
    403, "NOT_A_MEMBER", "The requesting member is no longer active.");
  const actor: UserActor = { kind: "user", user: member.user };
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
  invariant(membership?.id === recipe.memberId && membership.isActive, 403, "NOT_A_MEMBER", "The requesting member changed.");
  return actor;
}

async function jobNativeVariantContext(params: { workspaceId: string; jobId: string;
  expectedAttempt: number; expectedOwner: string }) {
  const job = await prisma.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId,
    type: BRAIN_ARTICLE_VARIANT_JOB_TYPE, status: "RUNNING", attempts: params.expectedAttempt,
    lockedBy: params.expectedOwner } });
  if (!job) return null;
  const payload = readPayload(job.payload);
  if (payload.version !== 2 || payload.phase === "STALE") return null;
  try {
    const actor = await ownerActor(prisma, params.workspaceId, payload);
    const lockPlan = await planVariantLocks(prisma, params.workspaceId, payload.articleId);
    const scope = await prepareNativeVariantScope(actor, params.workspaceId, payload.articleId, lockPlan);
    return { actor, scope, lockPlan, payloadHash: hash(payload) };
  } catch (error) { if (isStaleError(error)) return null; throw error; }
}

async function markGeneratingVariantStale(params: { workspaceId: string; jobId: string;
  expectedAttempt: number; expectedOwner: string }, generationToken: string) {
  return prisma.$transaction(async (tx) => {
    await lockWorkspaceMembership(tx, params.workspaceId);
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const job = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId,
      type: BRAIN_ARTICLE_VARIANT_JOB_TYPE } });
    invariant(job, 404, "NOT_FOUND", "Article variant job not found.");
    const payload = readPayload(job.payload);
    if (job.status !== "RUNNING" || job.attempts !== params.expectedAttempt || job.lockedBy !== params.expectedOwner
      || payload.phase !== "GENERATING" || payload.generationToken !== generationToken) return { phase: "SUPERSEDED" as const };
    await tx.workflowJob.update({ where: { id: job.id }, data: {
      payload: { ...payload, phase: "STALE" } as Prisma.InputJsonObject } });
    return { phase: "STALE" as const };
  });
}

/** Claim and acceptance both validate the actual worker lease and the requesting member's current proof. */
export async function generateBrainArticleVariant(params: {
  workspaceId: string; jobId: string; expectedAttempt: number; expectedOwner: string;
  generate: (sources: PermittedVariantSource[]) => Promise<{ title: string; bodyMd: string }>;
}) {
  invariant(Number.isInteger(params.expectedAttempt) && params.expectedAttempt > 0
    && typeof params.expectedOwner === "string" && params.expectedOwner.trim().length > 0,
  400, "INVALID_INPUT", "An active worker lease is required.");
  const nativeContext = await jobNativeVariantContext(params);
  const claim = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const job = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: BRAIN_ARTICLE_VARIANT_JOB_TYPE } });
    invariant(job, 404, "NOT_FOUND", "Article variant job not found.");
    if (job.status !== "RUNNING" || job.attempts !== params.expectedAttempt || job.lockedBy !== params.expectedOwner) return { phase: "SUPERSEDED" as const };
    const payload = readPayload(job.payload);
    if (payload.phase === "STALE") return { phase: "STALE" as const };
    // A v1 job cannot silently expand its old BrainSource-only generation inputs.
    if (payload.version === 1) {
      await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "STALE" } as Prisma.InputJsonObject } });
      return { phase: "STALE" as const };
    }
    const stale = async () => {
      await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "STALE" } as Prisma.InputJsonObject } });
      return { phase: "STALE" as const };
    };
    try {
      if (!nativeContext || nativeContext.payloadHash !== hash(payload)) return stale();
      const actor = nativeContext.actor;
      return await withNativeVariantScope(actor, params.workspaceId, tx, nativeContext?.scope ?? null, nativeContext.lockPlan,
        () => lockVariantAuthorityBeforeEpochs(tx, actor, params.workspaceId, payload.articleId, nativeContext.lockPlan), async () => {
      const currentOwner = await ownerActor(tx, params.workspaceId, payload);
      invariant(actor.user.id === currentOwner.user.id && hash(actor) === hash(currentOwner),
        409, "SOURCE_CHANGED", "The requesting member changed during native replay.");
      const prepared = await prepareVariant(tx, actor, params.workspaceId, payload.articleId, nativeContext!.lockPlan!);
      if (!("recipe" in prepared) || !sameRecipe(prepared.recipe, payload)) return stale();
      const prior = await existingVariant(tx, actor, params.workspaceId, payload);
      if (prior) {
        if (!prior.readable) return stale();
        await tx.workflowJob.update({ where: { id: job.id }, data: {
          payload: { ...payload, phase: "APPLIED", variantArticleId: prior.article.id } as Prisma.InputJsonObject } });
        return { phase: "APPLIED" as const, articleId: prior.article.id };
      }
      if (payload.phase === "APPLIED") return stale();
      const token = randomUUID();
      await tx.workflowJob.update({ where: { id: job.id }, data: {
        payload: { ...payload, phase: "GENERATING", generationToken: token } as Prisma.InputJsonObject } });
      return { actor, prepared, token };
      });
    } catch (error) { if (isStaleError(error)) return stale(); throw error; }
  }, { maxWait: 5_000, timeout: 120_000 });
  if ("phase" in claim) return claim;
  // Neither the old body nor its title, type, slug, frontmatter, or index enters this callback.
  // Claim already captured the exact source bodies under locks; recheck the
  // owner's current grant immediately before handing that projection to a model.
  let inputsReadable = false;
  try { inputsReadable = await isArtifactInputProofReadable(claim.actor, params.workspaceId, claim.prepared.roots); }
  catch (error) { if (!isStaleError(error)) throw error; }
  if (!inputsReadable) return markGeneratingVariantStale(params, claim.token);
  const candidate = await params.generate(claim.prepared.sources);
  const title = typeof candidate?.title === "string" ? candidate.title.trim() : "";
  const bodyMd = typeof candidate?.bodyMd === "string" ? candidate.bodyMd.trim() : "";
  invariant(title.length > 0 && title.length <= 300 && bodyMd.length > 0 && bodyMd.length <= 100_000,
    422, "INVALID_CANDIDATE", "The article variant candidate is invalid.");
  const finalLockPlan = await planVariantLocks(prisma, params.workspaceId, claim.prepared.recipe.articleId);
  const finalNativeScope = await prepareNativeVariantScope(claim.actor, params.workspaceId, claim.prepared.recipe.articleId, finalLockPlan);
  try { return await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.jobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
    const job = await tx.workflowJob.findFirst({ where: { id: params.jobId, workspaceId: params.workspaceId, type: BRAIN_ARTICLE_VARIANT_JOB_TYPE } });
    invariant(job, 404, "NOT_FOUND", "Article variant job not found.");
    const payload = readPayload(job.payload);
    if (job.status !== "RUNNING" || job.attempts !== params.expectedAttempt || job.lockedBy !== params.expectedOwner
      || payload.phase !== "GENERATING" || payload.generationToken !== claim.token) return { phase: "SUPERSEDED" as const };
    const stale = async () => {
      await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "STALE" } as Prisma.InputJsonObject } });
      return { phase: "STALE" as const };
    };
    return withNativeVariantScope(claim.actor, params.workspaceId, tx, finalNativeScope, finalLockPlan,
      () => lockVariantAuthorityBeforeEpochs(tx, claim.actor, params.workspaceId, payload.articleId, finalLockPlan), async () => {
    let actor: UserActor;
    let current: Preparation;
    try {
      const currentOwner = await ownerActor(tx, params.workspaceId, payload);
      actor = claim.actor;
      invariant(actor.user.id === currentOwner.user.id && hash(actor) === hash(currentOwner),
        409, "SOURCE_CHANGED", "The requesting member changed during native replay.");
      current = await prepareVariant(tx, actor, params.workspaceId, payload.articleId, finalLockPlan!);
      if (!("recipe" in current) || !sameRecipe(current.recipe, claim.prepared.recipe)
        || !sameRecipe(current.recipe, payload)
        || !await isArtifactInputProofReadable(actor, params.workspaceId, claim.prepared.roots, tx)) return stale();
    } catch (error) { if (isStaleError(error)) return stale(); throw error; }
    const prior = await existingVariant(tx, actor, params.workspaceId, payload);
    if (prior) {
      if (!prior.readable) return stale();
      await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "APPLIED", variantArticleId: prior.article.id } as Prisma.InputJsonObject } });
      return { phase: "APPLIED" as const, articleId: prior.article.id };
    }
    const article = await tx.brainArticle.create({ data: {
      workspaceId: params.workspaceId, slug: `member-variant-${randomUUID()}`, title, bodyMd, type: "PROJECT", authority: "DRAFT",
      isPrivate: true, ownerMemberId: payload.memberId, publishedAt: null, lastVerifiedAt: new Date(),
      sourceIds: claim.prepared.recipe.sources.filter((source) => source.kind === "BrainSource").map((source) => source.id), frontmatterJson: Prisma.DbNull,
      variantOfArticleId: payload.articleId, variantTargetFingerprint: payload.targetFingerprint,
      variantInputSetHash: payload.inputSetHash, variantSourceStateJson: payload.sourceState,
      variantGenerationJobId: job.id,
    } });
    await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "DERIVED",
      inputs: [], inheritedRoots: claim.prepared.roots });
    await ensureWorkspacePermalink(tx, actor, { workspaceId: params.workspaceId, entityType: "BrainArticle", entityId: article.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "BrainArticle", article) });
    await tx.auditLog.create({ data: { workspaceId: params.workspaceId, actorUserId: actor.user.id,
      action: "brain-article.variant.created", entityType: "BrainArticle", entityId: article.id,
      meta: { jobId: job.id } } });
    await appendEvents(tx, [{ workspaceId: params.workspaceId, type: "brain-article.created",
      aggregateType: "BrainArticle", aggregateId: article.id, payload: { articleId: article.id } }]);
    await tx.workflowJob.update({ where: { id: job.id }, data: { payload: { ...payload, phase: "APPLIED", variantArticleId: article.id } as Prisma.InputJsonObject } });
    return { phase: "APPLIED" as const, articleId: article.id };
    });
  }, { maxWait: 5_000, timeout: 120_000 }); }
  catch (error) { if (isStaleError(error)) return markGeneratingVariantStale(params, claim.token); throw error; }
}
