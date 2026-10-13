import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";
import { assertSourceCommitEpochCaptureCovered, assertSourceCommitPermissionReadCovered,
  assertSourceCommitTransactionCompatible,
  hasActiveSourceCommitLockPlan } from "./source-commit-lock-plan";

export const SOURCE_PERMISSION_POLICY_VERSION = "pun68-permissions-v3";
export type PermissionEpochIdentity = { kind: string; id: string };
export type PermissionEpochProof = { version: 1; policyVersion: typeof SOURCE_PERMISSION_POLICY_VERSION;
  entries: Array<PermissionEpochIdentity & { epoch: string }> };
type EpochClient = Prisma.TransactionClient | typeof prisma;
const MAX_EPOCH_IDENTITIES = 10000;

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
  if (kind === "BrainArticleVersion") add("BrainArticle", row.articleId);
  if (kind === "WorkflowJobInput") add("WorkflowJobInput", row.id);
  add("Workspace", row.workspaceId);
  for (const key of ["ownerMemberId", "memberId", "authorMemberId", "recipientMemberId"]) add("Member", row[key]);
  for (const key of ["userId", "authorUserId", "createdByUserId", "submittedByUserId", "requesterUserId", "requestedByUserId", "localUserId", "selectedByUserId", "uploadedByUserId"]) {
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
