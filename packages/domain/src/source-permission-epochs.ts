import { isCompanyLegacyRecoveryOutcome } from "./legacy-recovery-context";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { isArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import { invariant } from "./errors";
import { assertSourceCommitEpochCaptureCovered, assertSourceCommitPermissionReadCovered,
  assertSourceCommitTransactionCompatible,
  hasActiveSourceCommitLockPlan, sourceCommitPermissionReadIdentities,
  isSourceCommitHeldPermissionUnionCurrent } from "./source-commit-lock-plan";

export const SOURCE_PERMISSION_POLICY_VERSION = "pun68-permissions-v3";
export type PermissionEpochIdentity = { kind: string; id: string };
export type PermissionEpochProof = { version: 1; policyVersion: typeof SOURCE_PERMISSION_POLICY_VERSION;
  entries: Array<PermissionEpochIdentity & { epoch: string }> };
type EpochClient = Prisma.TransactionClient | typeof prisma;
const MAX_EPOCH_IDENTITIES = 10000;

type PermissionReadPass = { db: EpochClient; workspaceId: string; active: boolean;
  observed: Map<string, string>; checked: Map<string, string> };
const permissionReadPass = new AsyncLocalStorage<PermissionReadPass>();
const epochKey = (identity: PermissionEpochIdentity) => JSON.stringify([identity.kind, identity.id]);

async function readCoveredEpochUnion(db: EpochClient, workspaceId: string,
  identities: readonly PermissionEpochIdentity[]) {
  const rows = await db.$queryRaw<Array<{ sourceKind: string; sourceId: string; epoch: bigint }>>(Prisma.sql`
    SELECT "sourceKind", "sourceId", "epoch" FROM "SourcePermissionEpoch" WHERE "workspaceId" = ${workspaceId}
    AND ("sourceKind", "sourceId") IN (${Prisma.join(identities.map(identity => Prisma.sql`(${identity.kind}, ${identity.id})`))})
    ORDER BY "sourceKind" COLLATE "C", "sourceId" COLLATE "C"`);
  return rows.map(row => ({kind: row.sourceKind, id: row.sourceId, epoch: row.epoch.toString()}));
}

/** Internal read-only proof invocation, never a writer callback or serving receipt.
 * Only an exact held source plan may batch checks. Nested pure validators share
 * one map; every new invocation reads afresh. Final SQL catches interleaved DML
 * on this same transaction, including a referenced newborn own epoch. */
export async function withSourceCommitPermissionReadPass(db: EpochClient, workspaceId: string,
  read: () => Promise<boolean>): Promise<boolean> {
  assertSourceCommitTransactionCompatible(db);
  const inherited = permissionReadPass.getStore();
  if (inherited) {
    invariant(inherited.active && inherited.db === db && inherited.workspaceId === workspaceId,
      409, "SOURCE_LOCK_UNCOVERED", "Permission read pass belongs to another client or expired scope.");
    return read();
  }
  if (!hasActiveSourceCommitLockPlan(db)) return read();
  const identities = sourceCommitPermissionReadIdentities(db, workspaceId);
  // The plan budget and reserved outputs bound the union independently of
  // repeated roots. Optional unborn own keys can be absent until construction.
  invariant(identities.length > 0 && identities.length <= MAX_EPOCH_IDENTITIES * 2,
    409, "PERMISSION_PROOF_LIMIT", "Permission read union requires a bounded rebuild.");
  const rows = await readCoveredEpochUnion(db, workspaceId, identities);
  if (!isSourceCommitHeldPermissionUnionCurrent(db, workspaceId, rows)) return false;
  const pass: PermissionReadPass = {db, workspaceId, active: true,
    observed: new Map(rows.map(entry => [epochKey(entry), entry.epoch])), checked: new Map()};
  return permissionReadPass.run(pass, async () => {
    try {
      if (!await read()) return false;
      assertSourceCommitTransactionCompatible(db);
      const currentRows = await readCoveredEpochUnion(db, workspaceId, identities);
      if (!isSourceCommitHeldPermissionUnionCurrent(db, workspaceId, currentRows)) return false;
      const current = new Map(currentRows.map(entry => [epochKey(entry), entry.epoch]));
      return [...pass.checked].every(([key, epoch]) => current.get(key) === epoch);
    } finally { pass.active = false; }
  });
}

type NativePermissionReadPass = { db: EpochClient; workspaceId: string; actor: AppActor;
  mode: "local" | "full"; active: boolean; isCurrent: () => boolean;
  observed: Map<string, PermissionEpochProof["entries"][number]>; bytes: number };
const nativePermissionReadPass = new AsyncLocalStorage<NativePermissionReadPass>();
const MAX_NATIVE_PASS_EPOCHS = 512;
const MAX_NATIVE_PASS_BYTES = 128 * 1024;

function assertNativePermissionReadPass(pass: NativePermissionReadPass, db: EpochClient, workspaceId: string) {
  invariant(pass.active && pass.db === db && pass.workspaceId === workspaceId && pass.isCurrent(),
    409, "SOURCE_CHANGED", "Native permission read pass belongs to another client or expired commit.");
}

/** Only a real claimed provider commit may reuse its physically SHARE-locked
 * epoch observations within one pure validation pass. This is not a source plan
 * or an authority cache. Ordinary readers allocate nothing; overflow stays SQL.
 * Every positive pass freshly compares retained/reused keys before disposal,
 * so own-transaction writes cannot hide behind those observations. Overflow
 * keys are never reused: each check retains the ordinary fresh SQL semantics,
 * without promising a final recheck after the last uncached observation. The
 * production callbacks are pure root validation, never writer callbacks. */
export async function withExternalProviderPermissionReadPass(actor: AppActor, db: EpochClient,
  workspaceId: string, mode: "local" | "full", read: () => Promise<boolean>): Promise<boolean> {
  const inherited = nativePermissionReadPass.getStore();
  if (inherited) {
    assertNativePermissionReadPass(inherited, db, workspaceId);
    invariant(inherited.actor === actor, 409, "SOURCE_CHANGED", "Native permission reader changed.");
    if (inherited.mode === mode) return read();
  }
  if (db === prisma || hasActiveSourceCommitLockPlan(db) || !isArtifactNativeCommitPhase()) return read();
  const { isActiveExternalProviderCommit } = await import("./external-provider-authority");
  const isCurrent = () => isActiveExternalProviderCommit(actor, workspaceId, db);
  if (!isCurrent()) return read();
  const pass: NativePermissionReadPass = { db, workspaceId, actor, mode, active: true,
    isCurrent, observed: new Map(), bytes: 0 };
  return nativePermissionReadPass.run(pass, async () => {
    try {
      if (!await read()) return false;
      assertNativePermissionReadPass(pass, db, workspaceId);
      if (!pass.observed.size) return true;
      const identities = [...pass.observed.values()].sort((a, b) => epochKey(a) < epochKey(b) ? -1 : 1);
      const rows = await readCoveredEpochUnion(db, workspaceId, identities);
      assertNativePermissionReadPass(pass, db, workspaceId);
      const current = new Map(rows.map(entry => [epochKey(entry), entry.epoch]));
      return current.size === identities.length && identities.every(entry => current.get(epochKey(entry)) === entry.epoch);
    } finally { pass.active = false; pass.observed.clear(); }
  });
}

async function readNativePermissionProof(pass: NativePermissionReadPass, db: EpochClient,
  workspaceId: string, proof: PermissionEpochProof): Promise<boolean> {
  assertNativePermissionReadPass(pass, db, workspaceId);
  const unseen = [] as PermissionEpochProof["entries"];
  for (const entry of proof.entries) {
    const prior = pass.observed.get(epochKey(entry));
    if (prior && prior.epoch !== entry.epoch) return false;
    if (!prior) unseen.push(entry);
  }
  if (!unseen.length) return true;
  const rows = await db.$queryRaw<Array<{ sourceKind: string; sourceId: string; epoch: bigint }>>(Prisma.sql`
    SELECT "sourceKind", "sourceId", "epoch" FROM "SourcePermissionEpoch" WHERE "workspaceId" = ${workspaceId}
    AND ("sourceKind", "sourceId") IN (${Prisma.join(unseen.map(entry => Prisma.sql`(${entry.kind}, ${entry.id})`))})
    ORDER BY "sourceKind" COLLATE "C", "sourceId" COLLATE "C" FOR SHARE`);
  assertNativePermissionReadPass(pass, db, workspaceId);
  const current = new Map(rows.map(row => [epochKey({kind: row.sourceKind, id: row.sourceId}), row.epoch.toString()]));
  if (rows.length !== unseen.length || !unseen.every(entry => current.get(epochKey(entry)) === entry.epoch)) return false;
  for (const entry of unseen) {
    const key = epochKey(entry), prior = pass.observed.get(key);
    if (prior) { if (prior.epoch !== entry.epoch) return false; continue; }
    // Conservative UTF-16 strings plus key/object overhead; never retain payloads.
    const bytes = 2 * (entry.kind.length + entry.id.length + entry.epoch.length + key.length) + 128;
    if (pass.observed.size >= MAX_NATIVE_PASS_EPOCHS || pass.bytes + bytes > MAX_NATIVE_PASS_BYTES) continue;
    pass.observed.set(key, { ...entry }); pass.bytes += bytes;
  }
  return true;
}

export function parsePermissionEpochProof(value: unknown): PermissionEpochProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proof = value as PermissionEpochProof;
  if (proof.version !== 1 || proof.policyVersion !== SOURCE_PERMISSION_POLICY_VERSION
    || !Array.isArray(proof.entries) || !proof.entries.length || proof.entries.length > MAX_EPOCH_IDENTITIES) return null;
  let previous = "";
  for (const entry of proof.entries) {
    if (!entry || typeof entry.kind !== "string" || !entry.kind || typeof entry.id !== "string" || !entry.id
      || typeof entry.epoch !== "string" || !/^(0|[1-9][0-9]*)$/.test(entry.epoch)) return null;
    const key = JSON.stringify([entry.kind, entry.id]);
    if (key <= previous) return null;
    previous = key;
  }
  return proof;
}

/** Stable absence-sensitive policy keys survive delete/recreate and resource moves. */
export function artifactPermissionEpochIdentities(kind: string, row: Record<string, unknown>): PermissionEpochIdentity[] {
  const identities: PermissionEpochIdentity[] = [];
  const add = (permissionKind: string, id: unknown) => {
    if (typeof id === "string" && id) identities.push({ kind: permissionKind, id });
  };
  const sourceKind = ["MeetingTranscript", "MeetingAgenda"].includes(kind) ? "Meeting" : kind;
  add(sourceKind, row.id);
  if (kind === "FinanceReportFactRevision") {
    add("FinanceReportFactLifecycle", row.factId);
    for (const id of [row.appliedByUserId, row.approvedByUserId]) { add("MemberUserPolicy", id); add("WorkspaceSupportPolicy", id); }
  }
  if (kind === "BrainArticleVersion") add("BrainArticle", row.articleId);
  if (kind === "WorkflowJobInput") add("WorkflowJobInput", row.id);
  add("Workspace", row.workspaceId);
  if (["ExternalDataSource", "BrainSource", "Document", "Meeting", "MeetingTranscript", "MeetingAgenda"].includes(kind)) {
    add("InformationCategoryPolicy", row.informationCategory);
    if (row.isRestricted === true) {
      for (const id of Array.isArray(row.allowedRoleIds) ? row.allowedRoleIds : []) add("Role", id);
      for (const id of Array.isArray(row.allowedCircleIds) ? row.allowedCircleIds : []) add("Circle", id);
    }
  }
  if (kind === "NativeTranscriptInput" && row.mode === "PROVIDER_IMPORT") {
    add("TranscriptTransportArchive", row.transportArchiveId); add("TranscriptConnectionPolicy", row.connectionId); add("TranscriptSourceRecordPolicy", row.sourceRecordId);
    add("FeaturePolicy", "MEETING_TRANSCRIPT_SOURCES"); add("FeaturePolicy", "MEETING_RECORDERS");
  }
  if (kind === "NativeTranscriptInput" && row.mode === "RECORDER") {
    add("Meeting", row.recorderMeetingId); add("MeetingRecording", row.recordingId);
    // One stable absence-sensitive policy key; binding IDs and worker leases are not reader epochs.
    add("RecorderProviderPolicy", row.recorderProvider);
    add("FeaturePolicy", "MEETING_RECORDERS");
  }
  if (kind === "SqlNativeRunInput") add("ExternalDataSource", row.sourceId);
  for (const key of ["ownerMemberId", "memberId", "authorMemberId", "recipientMemberId"]) {
    if (!(kind === "NativeTranscriptInput" && row.mode === "COMPANY_MEMBER_UPLOAD" && key === "ownerMemberId")) add("Member", row[key]);
  }
  for (const key of ["userId", "authorUserId", "createdByUserId", "submittedByUserId", "requesterUserId", "requestedByUserId", "localUserId", "selectedByUserId", "uploadedByUserId"]) {
    if (kind === "NativeTranscriptInput" && row.mode === "COMPANY_MEMBER_UPLOAD" && key === "submittedByUserId"
      || key === "userId" && isCompanyLegacyRecoveryOutcome(kind,row)) continue;
    add("MemberUserPolicy", row[key]);
    add("WorkspaceSupportPolicy", row[key]);
  }
  if (kind === "Member") add("MemberUserPolicy", row.userId);
  if (kind === "User") add("MemberUserPolicy", row.id);
  if (kind === "CrmProspectWorkspace") add("CrmProspectTargetAccessPolicy", row.targetWorkspaceId);
  if (kind === "RoleAssignment") { add("Member", row.memberId); add("MemberRolePolicy", row.memberId); add("Role", row.roleId); }
  for (const key of ["circleId", "parentCircleId", "targetCircleId"]) add("Circle", row[key]);
  if (kind === "AdviceRequest") {
    add("AdviceRequestRecipientsPolicy", row.id);
    if (row.audienceType === "CIRCLE") add("CircleRolePolicy", row.targetCircleId);
  }
  if (kind === "CircleAgentAssignment") add("AgentIdentity", row.agentIdentityId);
  for (const key of ["credentialId", "agentCredentialId"]) add("AgentCredential", row[key]);
  if (kind.startsWith("Finance") || row.accessDomain === "FINANCE") {
    add("ModulePolicy", "finance"); add("FeaturePolicy", "FINANCE");
  }
  if (kind.startsWith("Communication")) {
    add("CommunicationInstallation", row.installationId);
    add("CommunicationMessage", row.communicationMessageId);
    if (kind === "CommunicationEntityLink") add("CommunicationMessage", row.messageId);
    add("IntegrationPolicy", "SLACK");
    if (typeof row.installationId === "string" && typeof row.externalChannelId === "string") {
      add("CommunicationChannelPolicy", JSON.stringify([row.installationId, row.externalChannelId]));
    }
  }
  if (kind === "ExternalContentSource" || kind === "ExternalProviderFetchInput") {
    add("ExternalMcpConnection", row.connectionId); add("ExternalContentSource", row.externalContentSourceId);
  }
  if (kind === "OAuthProviderFetchInput") add("OAuthConnectionPolicy", row.connectionId);
  if (kind === "ExternalMcpResponseInput") add("ExternalMcpConnection", row.connectionId);
  if (kind === "ExternalMcpResponseInput" || kind === "ExternalMcpConnectionSet") add("ExternalMcpConnectionSetPolicy", row.localUserId);
  if (kind === "BrainArticle" && typeof row.variantOfArticleId === "string") add("BrainArticle", row.variantOfArticleId);
  if (kind === "GenericDerivedArtifactVariant" && typeof row.targetKind === "string") add(row.targetKind, row.targetId);
  return identities;
}

export async function capturePermissionEpochs(tx: Prisma.TransactionClient, workspaceId: string,
  identities: readonly PermissionEpochIdentity[]): Promise<PermissionEpochProof> {
  assertSourceCommitTransactionCompatible(tx);
  invariant(!permissionReadPass.getStore() && !nativePermissionReadPass.getStore() && !batchPermissionRead.getStore(), 409, "SOURCE_LOCK_UNCOVERED",
    "Epoch capture cannot mutate a read-only permission proof pass.");
  const sorted = [...new Map(identities.map((identity) => [JSON.stringify([identity.kind, identity.id]), identity])).entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, identity]) => identity);
  invariant(sorted.length > 0 && sorted.length <= MAX_EPOCH_IDENTITIES, 409, "PERMISSION_PROOF_LIMIT", "Source permission proof requires a bounded rebuild.");
  const planned = hasActiveSourceCommitLockPlan(tx);
  const insert = planned ? assertSourceCommitEpochCaptureCovered(tx, workspaceId, sorted) : sorted;
  if (insert.length) await tx.$executeRaw(Prisma.sql`INSERT INTO "SourcePermissionEpoch" ("id", "workspaceId", "sourceKind", "sourceId", "epoch")
    VALUES ${Prisma.join(insert.map((identity) => Prisma.sql`(${randomUUID()}, ${workspaceId}, ${identity.kind}, ${identity.id}, 0)`))}
    ON CONFLICT ("workspaceId", "sourceKind", "sourceId") DO NOTHING`);
  const rows = await tx.$queryRaw<Array<{ sourceKind: string; sourceId: string; epoch: bigint }>>(Prisma.sql`
    SELECT "sourceKind", "sourceId", "epoch" FROM "SourcePermissionEpoch" WHERE "workspaceId" = ${workspaceId}
    AND ("sourceKind", "sourceId") IN (${Prisma.join(sorted.map((identity) => Prisma.sql`(${identity.kind}, ${identity.id})`))})
    ORDER BY "sourceKind" COLLATE "C", "sourceId" COLLATE "C" ${planned ? Prisma.empty : Prisma.raw("FOR SHARE")}`);
  const epochs = new Map(rows.map((row) => [JSON.stringify([row.sourceKind, row.sourceId]), row.epoch.toString()]));
  invariant(rows.length === sorted.length, 409, "PERMISSION_CHANGED", "A source permission epoch is unavailable.");
  return { version: 1, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
    entries: sorted.map((identity) => ({...identity, epoch: epochs.get(JSON.stringify([identity.kind, identity.id]))!})) };
}

type BatchPermissionRead = {db: EpochClient; workspaceId: string; active: boolean; epochs: Map<string, string>};
const batchPermissionRead = new AsyncLocalStorage<BatchPermissionRead>();

/** A bounded pure validation callback. These are raw epoch observations, never
 * authority decisions. Unknown keys stay fresh; every retained key is compared
 * again before success, including writes made on the same transaction. */
export async function withArtifactPermissionBatchRead(db: EpochClient, workspaceId: string,
  proofs: readonly PermissionEpochProof[], read: () => Promise<boolean>): Promise<boolean> {
  const keys = new Set<string>();
  for (const value of proofs) for (const entry of value.entries) {
    keys.add(epochKey(entry));
    if (keys.size > MAX_EPOCH_IDENTITIES) return read();
  }
  const proof = mergePermissionEpochProofs(...proofs);
  if (!proof || proof.entries.length > MAX_EPOCH_IDENTITIES || hasActiveSourceCommitLockPlan(db)
    || permissionReadPass.getStore() || nativePermissionReadPass.getStore()) return read();
  if (!await isArtifactPermissionEpochProofCurrent(workspaceId, proof, db)) return false;
  const pass: BatchPermissionRead = {db, workspaceId, active: true,
    epochs: new Map(proof.entries.map(entry => [epochKey(entry), entry.epoch]))};
  const result = await batchPermissionRead.run(pass, async () => {
    try { return await read(); } finally { pass.active = false; pass.epochs.clear(); }
  });
  return result && await isArtifactPermissionEpochProofCurrent(workspaceId, proof, db);
}

export async function isArtifactPermissionEpochProofCurrent(workspaceId: string, value: unknown,
  db: EpochClient = prisma): Promise<boolean> {
  assertSourceCommitTransactionCompatible(db);
  const proof = parsePermissionEpochProof(value);
  if (!proof) return false;
  const planned = hasActiveSourceCommitLockPlan(db);
  if (planned) assertSourceCommitPermissionReadCovered(db, workspaceId, proof);
  const batch = batchPermissionRead.getStore();
  if (batch) {
    invariant(batch.active && batch.db === db && batch.workspaceId === workspaceId,
      409, "SOURCE_CHANGED", "Permission batch belongs to another or expired read.");
    if (proof.entries.every(entry => batch.epochs.has(epochKey(entry)))) {
      return proof.entries.every(entry => batch.epochs.get(epochKey(entry)) === entry.epoch);
    }
  }
  const pass = permissionReadPass.getStore();
  if (pass) {
    invariant(pass.active && planned && pass.db === db && pass.workspaceId === workspaceId,
      409, "SOURCE_LOCK_UNCOVERED", "Permission read pass belongs to another client or expired scope.");
    for (const entry of proof.entries) {
      const key = epochKey(entry);
      if (pass.observed.get(key) !== entry.epoch) return false;
      pass.checked.set(key, entry.epoch);
    }
    return true;
  }
  const nativePass = nativePermissionReadPass.getStore();
  if (nativePass) return readNativePermissionProof(nativePass, db, workspaceId, proof);
  const query = Prisma.sql`SELECT "sourceKind", "sourceId", "epoch" FROM "SourcePermissionEpoch" WHERE "workspaceId" = ${workspaceId}
    AND ("sourceKind", "sourceId") IN (${Prisma.join(proof.entries.map((entry) => Prisma.sql`(${entry.kind}, ${entry.id})`))})
    ORDER BY "sourceKind" COLLATE "C", "sourceId" COLLATE "C"`;
  const rows = await db.$queryRaw<Array<{ sourceKind: string; sourceId: string; epoch: bigint }>>(
    db === prisma || planned ? query : Prisma.sql`${query} FOR SHARE`);
  const epochs = new Map(rows.map((row) => [JSON.stringify([row.sourceKind, row.sourceId]), row.epoch.toString()]));
  return rows.length === proof.entries.length && proof.entries.every((entry) => epochs.get(JSON.stringify([entry.kind, entry.id])) === entry.epoch);
}

export function permissionEpochProofHash(proof: PermissionEpochProof) {
  return createHash("sha256").update(JSON.stringify(proof)).digest("hex");
}

/** Combining read receipts must retain the permission revision consumed before generation. */
export function mergePermissionEpochProofs(...values: Array<PermissionEpochProof | undefined>): PermissionEpochProof | undefined {
  const entries = new Map<string, PermissionEpochProof["entries"][number]>();
  for (const value of values) {
    if (value === undefined) continue;
    const proof = parsePermissionEpochProof(value);
    invariant(proof, 409, "UNKNOWN_LINEAGE", "A source permission receipt is malformed.");
    for (const entry of proof.entries) {
      const key = JSON.stringify([entry.kind, entry.id]);
      const earlier = entries.get(key);
      invariant(!earlier || earlier.epoch === entry.epoch, 409, "SOURCE_CHANGED", "Input permissions changed during collection.");
      entries.set(key, { ...entry });
    }
  }
  if (!entries.size) return undefined;
  invariant(entries.size <= MAX_EPOCH_IDENTITIES, 409, "PERMISSION_PROOF_LIMIT", "Source permission proof requires a bounded rebuild.");
  return { version: 1, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
    entries: [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, entry]) => entry) };
}
