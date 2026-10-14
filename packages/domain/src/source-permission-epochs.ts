import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
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
    if (kind === "NativeTranscriptInput" && row.mode === "COMPANY_MEMBER_UPLOAD" && key === "submittedByUserId") continue;
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
  if (kind === "ExternalMcpResponseInput") add("ExternalMcpConnection", row.connectionId);
  if (kind === "ExternalMcpResponseInput" || kind === "ExternalMcpConnectionSet") add("ExternalMcpConnectionSetPolicy", row.localUserId);
  if (kind === "BrainArticle" && typeof row.variantOfArticleId === "string") add("BrainArticle", row.variantOfArticleId);
  if (kind === "GenericDerivedArtifactVariant" && typeof row.targetKind === "string") add(row.targetKind, row.targetId);
  return identities;
}

export async function capturePermissionEpochs(tx: Prisma.TransactionClient, workspaceId: string,
  identities: readonly PermissionEpochIdentity[]): Promise<PermissionEpochProof> {
  assertSourceCommitTransactionCompatible(tx);
  invariant(!permissionReadPass.getStore(), 409, "SOURCE_LOCK_UNCOVERED",
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

export async function isArtifactPermissionEpochProofCurrent(workspaceId: string, value: unknown,
  db: EpochClient = prisma): Promise<boolean> {
  assertSourceCommitTransactionCompatible(db);
  const proof = parsePermissionEpochProof(value);
  if (!proof) return false;
  const planned = hasActiveSourceCommitLockPlan(db);
  if (planned) assertSourceCommitPermissionReadCovered(db, workspaceId, proof);
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
