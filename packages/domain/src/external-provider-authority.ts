import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { assertOutsideArtifactNativeCommitPhase, isArtifactNativeCommitPhase, withArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import { savedEnclosingNativeEpochs, savedNativeVectorKey } from "./native-commit-original-vector";
import { lockSourceAuthorityPredicate, sourceAuthorityRowAlreadyLocked } from "./source-commit-row-locks";
import type { LineageRoot } from "./source-lineage";
import { isArtifactPermissionEpochProofCurrent, parsePermissionEpochProof } from "./source-permission-epochs";
import { getExternalProviderPrincipalUserId, getExternalProviderWorkerPurpose, registerExternalProviderWorkerPrincipal,
  revokeExternalProviderWorkerPrincipal } from "./external-provider-principal";
export { getExternalProviderPrincipalUserId } from "./external-provider-principal";
import { externalMcpConnectionGrantHash, isBoxNativeContentRequest, readBoxExternalMcpNativeResponse,
  type ExternalMcpConnectionRecord } from "./external-mcp";
import { claimExternalMcpResponseCommitPreflight, inspectExternalMcpResponseCommitClaim,
  discardExternalMcpResponseCommitPreflight,
  type ExternalMcpResponseCommitClaim, type ExternalMcpResponseCommitPreflight } from "./external-mcp-response-input";
import { claimSlackNativeCommitPreflight, inspectSlackNativeCommitClaim,
  discardSlackNativeCommitPreflight,
  lockSlackNativeGoverningRows, lockSlackNativeCommitClaimRows, withClaimedSlackNativeCommitPreflight,
  type SlackNativeCommitPreflight } from "./communication-native-authority";

type AuthorityDb = Prisma.TransactionClient | typeof prisma;
export type ExternalProviderFetchInputRecord = {
  id: string; workspaceId: string; externalContentSourceId: string; connectionId: string; localUserId: string;
  providerKey: string; serverUrl: string; providerAccountId: string | null; sourceKind: string; externalId: string;
  toolName: string; requestJson: unknown; encryptedResponseJson: string; responseHash: string;
  connectionGrantHash: string; fetchedAt: Date;
};
type Selection = { id: string; workspaceId: string; connectionId: string | null; selectedByUserId: string | null;
  providerKey: string; sourceKind: string; externalId: string; archivedAt?: Date | null; status?: string; metadata?: unknown };
const receipts = new WeakSet<object>();
declare const commitPreflightBrand: unique symbol;
/** Process-local, single-use authority for the immediately following DB-only copy. */
export type ExternalProviderCommitPreflight = { readonly [commitPreflightBrand]: true };
type CommitState = {
  actor: AppActor; actorHash: string; workspaceId: string; principal: string; purposeHash: string;
  submittedRoots: LineageRoot[]; roots: LineageRoot[];
  inputs: Map<string, { fingerprint: string; binding: string }>;
};
const commitPreflights = new WeakMap<object, CommitState>();
const commitScope = new AsyncLocalStorage<CommitState & { tx: Prisma.TransactionClient; active: boolean;
  mcpPeer?: ExternalMcpResponseCommitClaim }>();
declare const commitClaimBrand: unique symbol;
type ExternalProviderCommitClaim = { readonly [commitClaimBrand]: true };
const commitClaims = new WeakMap<object, CommitState & { tx: Prisma.TransactionClient }>();
/** Cancellation confers no authority; an attempted owner commit burns every peer plan. */
export function discardExternalProviderCommitPreflight(token: ExternalProviderCommitPreflight) {
  commitPreflights.delete(token);
}
const MAX_COMMIT_INPUTS = 128;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const externalProviderResponseHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function bindingHash(source: Selection) {
  return externalProviderResponseHash({ id: source.id, workspaceId: source.workspaceId, connectionId: source.connectionId,
    selectedByUserId: source.selectedByUserId, providerKey: source.providerKey, sourceKind: source.sourceKind, externalId: source.externalId });
}
function leaseHash(job: { id: string; workspaceId: string | null; type: string; payload: unknown; status: string;
  attempts: number; lockedBy: string | null; lockedAt: Date | null; startedAt: Date | null }) {
  return externalProviderResponseHash({ id: job.id, workspaceId: job.workspaceId, type: job.type, payload: job.payload,
    status: job.status, attempts: job.attempts, lockedBy: job.lockedBy, lockedAt: job.lockedAt?.toISOString(), startedAt: job.startedAt?.toISOString() });
}
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

async function currentAuthority(actor: AppActor, workspaceId: string, connectionId: string, db: AuthorityDb) {
  await requireWorkspaceMembership({ actor, workspaceId, tx: db as Prisma.TransactionClient });
  const userId = getExternalProviderPrincipalUserId(actor, workspaceId);
  invariant(userId, 403, "SOURCE_RESTRICTED", "External provider content requires its bound principal.");
  const member = await db.member.findFirst({ where: { workspaceId, userId, isActive: true }, select: { id: true } });
  const connection = await db.externalMcpConnection.findFirst({ where: { id: connectionId, workspaceId, userId,
    providerKey: "box", status: "ACTIVE" } }) as ExternalMcpConnectionRecord | null;
  invariant(member && connection?.accessTokenEnc && connection.providerAccountId && connection.serverUrl === "https://mcp.box.com",
    403, "SOURCE_RESTRICTED", "External provider authority is unavailable.");
  const purpose = getExternalProviderWorkerPurpose(actor);
  if (purpose) {
    const source = await db.externalContentSource.findFirst({ where: { id: purpose.sourceId, workspaceId, archivedAt: null, status: { not: "ARCHIVED" } } });
    const job = await db.workflowJob.findFirst({ where: { id: purpose.workflowJobId, workspaceId } });
    invariant(source && bindingHash(source) === purpose.bindingHash && job && job.status === "RUNNING"
      && job.lockedAt && job.lockedBy && leaseHash(job) === purpose.jobLeaseHash && connectionId === purpose.connectionId
      && externalMcpConnectionGrantHash(connection) === purpose.connectionGrantHash,
    409, "SOURCE_CHANGED", "External provider worker authority changed.");
  }
  return connection;
}
export async function assertExternalProviderActorCurrent(actor: AppActor, workspaceId: string, connectionId: string, db: AuthorityDb = prisma) {
  await currentAuthority(actor, workspaceId, connectionId, db);
}
export async function isExternalProviderSelectionCurrent(actor: AppActor, workspaceId: string, source: Selection, db: AuthorityDb = prisma) {
  try {
    if (source.workspaceId !== workspaceId || source.archivedAt || source.status === "ARCHIVED" || !source.connectionId
      || source.providerKey !== "box" || source.selectedByUserId !== getExternalProviderPrincipalUserId(actor, workspaceId)
      || (getExternalProviderWorkerPurpose(actor) && getExternalProviderWorkerPurpose(actor)!.sourceId !== source.id)) return false;
    const connection = await currentAuthority(actor, workspaceId, source.connectionId, db);
    return connection.userId === source.selectedByUserId;
  } catch { return false; }
}

/** Preparatory local admission only; this does not establish current remote bytes. */
export async function isExternalProviderFetchInputLocallyCurrent(actor: AppActor, workspaceId: string,
  input: ExternalProviderFetchInputRecord, db: AuthorityDb = prisma) {
  try {
    if (input.workspaceId !== workspaceId || input.localUserId !== getExternalProviderPrincipalUserId(actor, workspaceId)
      || input.providerKey !== "box" || input.serverUrl !== "https://mcp.box.com"
      || (getExternalProviderWorkerPurpose(actor) && getExternalProviderWorkerPurpose(actor)!.sourceId !== input.externalContentSourceId)) return false;
    const args = record(input.requestJson);
    if (!args || !isBoxNativeContentRequest(input.sourceKind, input.externalId, input.toolName, args)
      || externalProviderResponseHash(JSON.parse(decryptSecret(input.encryptedResponseJson))) !== input.responseHash) return false;
    const connection = await currentAuthority(actor, workspaceId, input.connectionId, db);
    const source = await db.externalContentSource.findFirst({ where: { id: input.externalContentSourceId, workspaceId, archivedAt: null } });
    if (!source || source.status === "ARCHIVED" || source.connectionId !== input.connectionId
      || source.selectedByUserId !== input.localUserId || source.sourceKind !== input.sourceKind
      || source.externalId !== input.externalId || connection.providerAccountId !== input.providerAccountId
      || externalMcpConnectionGrantHash(connection) !== input.connectionGrantHash
      || !await isExternalProviderSelectionCurrent(actor, workspaceId, source, db)) return false;
    const stored = await db.externalProviderFetchInput.findFirst({ where: { id: input.id, workspaceId } });
    const { lineageContentFingerprint } = await import("./source-lineage");
    return !!stored && lineageContentFingerprint("ExternalProviderFetchInput", stored)
      === lineageContentFingerprint("ExternalProviderFetchInput", input);
  } catch { return false; }
}

/** Only the server sync entry point supplies this validation callback; no serialized actor is trusted. */
export async function createExternalProviderSyncActor(params: { workspaceId: string; sourceId: string; workflowJobId: string;
  validateInputs: (actor: AppActor, db: AuthorityDb, source: Selection, job: Record<string, unknown>) => Promise<boolean> }, db: AuthorityDb = prisma) {
  const source = await db.externalContentSource.findFirst({ where: { id: params.sourceId, workspaceId: params.workspaceId, archivedAt: null, status: { not: "ARCHIVED" } } });
  const job = await db.workflowJob.findFirst({ where: { id: params.workflowJobId, workspaceId: params.workspaceId } });
  invariant(source?.connectionId && source.selectedByUserId && source.providerKey === "box" && job?.status === "RUNNING"
    && job.type === "knowledge.sync.external-content" && job.lockedAt && job.lockedBy && record(job.payload)?.sourceId === source.id,
  403, "SOURCE_RESTRICTED", "External provider sync needs its exact active job and user selection.");
  const connection = await db.externalMcpConnection.findFirst({ where: { id: source.connectionId, workspaceId: params.workspaceId,
    userId: source.selectedByUserId, providerKey: "box", status: "ACTIVE" } }) as ExternalMcpConnectionRecord | null;
  invariant(connection?.accessTokenEnc && connection.providerAccountId, 403, "SOURCE_RESTRICTED", "External provider sync connection is unavailable.");
  const actor: AppActor = Object.freeze({ kind: "agent", authProvider: "bootstrap", label: "external-content-sync",
    workspaceIds: Object.freeze([params.workspaceId]) as unknown as string[] });
  registerExternalProviderWorkerPrincipal(actor, Object.freeze({ workspaceId: params.workspaceId, sourceId: source.id, workflowJobId: job.id,
    userId: source.selectedByUserId, connectionId: source.connectionId, bindingHash: bindingHash(source),
    jobLeaseHash: leaseHash(job), connectionGrantHash: externalMcpConnectionGrantHash(connection) }));
  try {
    await currentAuthority(actor, params.workspaceId, source.connectionId, db);
    invariant(await params.validateInputs(actor, db, source, job), 409, "UNKNOWN_LINEAGE", "External provider sync inputs have incomplete lineage.");
    await currentAuthority(actor, params.workspaceId, source.connectionId, db);
    return actor;
  } catch (error) { revokeExternalProviderWorkerPrincipal(actor); throw error; }
}

function freezeExact<T>(value: T, frozen = new WeakMap<object, unknown>()): T {
  if (value && typeof value === "object" && frozen.has(value)) return frozen.get(value) as T;
  if (value instanceof Date) {
    const fixed = new Date(value.getTime());
    const immutable = new Proxy(Object.freeze(fixed), { get(target, key) {
      if (typeof key === "string" && key.startsWith("set")) return () => { throw new TypeError("Receipt dates are immutable."); };
      const entry = Reflect.get(target, key, target);
      return typeof entry === "function" ? entry.bind(target) : entry;
    } }) as T;
    frozen.set(value, immutable);
    return immutable;
  }
  if (value && typeof value === "object") {
    frozen.set(value, value);
    for (const key of Object.keys(value)) (value as Record<string, unknown>)[key] = freezeExact((value as Record<string, unknown>)[key], frozen);
    return Object.freeze(value);
  }
  return value;
}
function freezeComparable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) freezeComparable((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
export async function assertExternalProviderCapturedResponseCurrent(receipt: ExternalProviderCapturedResponse) {
  invariant(receipts.has(receipt) && externalProviderResponseHash(receipt.payload) === receipt.input.responseHash
    && externalProviderResponseHash(JSON.parse(decryptSecret(receipt.input.encryptedResponseJson))) === receipt.input.responseHash,
    409, "SOURCE_CHANGED", "External provider receipt bytes changed before use.");
  const persisted = await prisma.externalProviderFetchInput.findFirst({ where: { id: receipt.input.id, workspaceId: receipt.input.workspaceId } });
  const keys: Array<keyof ExternalProviderFetchInputRecord> = ["id", "workspaceId", "externalContentSourceId", "connectionId", "localUserId", "providerKey",
    "serverUrl", "providerAccountId", "sourceKind", "externalId", "toolName", "requestJson", "encryptedResponseJson", "responseHash", "connectionGrantHash"];
  invariant(persisted && keys.every(key => canonical(persisted[key]) === canonical(receipt.input[key]))
    && persisted.fetchedAt.toISOString() === receipt.input.fetchedAt.toISOString(),
    409, "SOURCE_CHANGED", "External provider stored receipt changed before use.");
}

export type ExternalProviderCapturedResponse = Readonly<{ input: ExternalProviderFetchInputRecord; payload: unknown }>;
export async function captureExternalProviderFetchInput(actor: AppActor, params: { workspaceId: string; externalContentSourceId: string;
  connectionId: string; sourceKind: string; externalId: string; toolName: string; arguments: Record<string, unknown> }): Promise<ExternalProviderCapturedResponse> {
  assertOutsideArtifactNativeCommitPhase();
  params = Object.freeze(structuredClone(params));
  const principal = getExternalProviderPrincipalUserId(actor, params.workspaceId);
  const assertPrincipal = () => invariant(principal && getExternalProviderPrincipalUserId(actor, params.workspaceId) === principal,
    409, "SOURCE_CHANGED", "External provider principal changed during capture.");
  const stable = async <T>(operation: Promise<T>) => { const result = await operation; assertPrincipal(); return result; };
  assertPrincipal();
  const request = freezeExact(structuredClone(params.arguments));
  invariant(isBoxNativeContentRequest(params.sourceKind, params.externalId, params.toolName, request),
    400, "INVALID_INPUT", "External provider request is not a bound native content read.");
  const selected = await stable(prisma.externalContentSource.findFirst({ where: { id: params.externalContentSourceId, workspaceId: params.workspaceId, archivedAt: null } }));
  invariant(selected && selected.connectionId === params.connectionId && selected.sourceKind === params.sourceKind
    && selected.externalId === params.externalId && await stable(isExternalProviderSelectionCurrent(actor, params.workspaceId, selected)),
    403, "SOURCE_RESTRICTED", "External provider read is outside its selected purpose.");
  const connection = await stable(currentAuthority(actor, params.workspaceId, params.connectionId, prisma));
  const grant = externalMcpConnectionGrantHash(connection);
  const payload = await stable(readBoxExternalMcpNativeResponse({ actor, connectionId: connection.id, workspaceId: params.workspaceId,
    connectionGrantHash: grant, toolName: params.toolName, arguments: request }));
  const responseHash = externalProviderResponseHash(payload);
  const input = await stable(prisma.$transaction(async tx => {
    await stable(tx.$queryRaw`SELECT "id" FROM "ExternalContentSource" WHERE "id" = ${params.externalContentSourceId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`);
    const after = await stable(currentAuthority(actor, params.workspaceId, connection.id, tx));
    const source = await stable(tx.externalContentSource.findFirst({ where: { id: params.externalContentSourceId, workspaceId: params.workspaceId, archivedAt: null } }));
    invariant(source && source.connectionId === connection.id && source.selectedByUserId === connection.userId
      && source.sourceKind === params.sourceKind && source.externalId === params.externalId && source.status !== "ARCHIVED"
      && externalMcpConnectionGrantHash(after) === grant,
    409, "SOURCE_CHANGED", "External provider selection changed during capture.");
    const saved = await stable(tx.externalProviderFetchInput.create({ data: { workspaceId: params.workspaceId, externalContentSourceId: source.id,
      connectionId: connection.id, localUserId: connection.userId, providerKey: "box", serverUrl: connection.serverUrl,
      providerAccountId: connection.providerAccountId!, sourceKind: params.sourceKind, externalId: params.externalId,
      toolName: params.toolName, requestJson: request as Prisma.InputJsonObject,
      encryptedResponseJson: encryptSecret(canonical(payload)), responseHash, connectionGrantHash: grant } }));
    await stable(currentAuthority(actor, params.workspaceId, connection.id, tx));
    return saved;
  }));
  const receipt = freezeExact({ input: structuredClone(input), payload: structuredClone(payload) });
  receipts.add(receipt);
  return receipt;
}
export function isExternalProviderCapturedResponse(value: unknown): value is ExternalProviderCapturedResponse {
  return !!value && typeof value === "object" && receipts.has(value);
}

/** Internal producer seam: every consumed original proof is checked live before opening the transaction. */
export async function prepareExternalProviderCommitPreflight(actor: AppActor, workspaceId: string,
  params: { roots: readonly LineageRoot[]; receipts: readonly ExternalProviderCapturedResponse[] }): Promise<ExternalProviderCommitPreflight> {
  const roots: LineageRoot[] = structuredClone([...params.roots]);
  const submittedRoots = structuredClone(roots);
  const captured = [...params.receipts];
  const principal = getExternalProviderPrincipalUserId(actor, workspaceId);
  const actorHash = externalProviderResponseHash(actor);
  const purpose = getExternalProviderWorkerPurpose(actor);
  const purposeHash = externalProviderResponseHash(purpose);
  invariant(principal && captured.length > 0 && captured.length <= MAX_COMMIT_INPUTS && roots.length <= 10000,
    409, "SOURCE_CHANGED", "External provider commit requires bounded native inputs.");
  invariant(!purpose || roots.some(root => root.kind === "WorkflowJobInput" && root.id === purpose.workflowJobId && root.permissionEpochs),
    409, "SOURCE_CHANGED", "External provider commit lacks the original workflow input proof.");
  const { isArtifactInputProofReadable, lineageContentFingerprint, inspectStoredArtifactInputDependencies } = await import("./source-lineage");
  const dependencies = await inspectStoredArtifactInputDependencies(prisma, workspaceId, roots);
  invariant(dependencies.complete && dependencies.roots.length <= 10000
    && !dependencies.roots.some(root => root.kind === "CommunicationMessageNativeInput"),
  409, "UNSUPPORTED_PROVIDER_INPUT", "External provider copy needs a bounded commit adapter for every native provider input.");
  const inputs: CommitState["inputs"] = new Map();
  for (const receipt of captured) {
    await assertExternalProviderCapturedResponseCurrent(receipt);
    invariant(principal === getExternalProviderPrincipalUserId(actor, workspaceId) && actorHash === externalProviderResponseHash(actor),
      409, "SOURCE_CHANGED", "External provider principal changed before commit.");
    const fingerprint = lineageContentFingerprint("ExternalProviderFetchInput", receipt.input);
    const root = roots.find(candidate => candidate.kind === "ExternalProviderFetchInput" && candidate.id === receipt.input.id);
    invariant(root && root.fingerprint === fingerprint && root.permissionEpochs && receipt.input.workspaceId === workspaceId,
      409, "SOURCE_CHANGED", "External provider commit lacks the original native input proof.");
    const selected = await prisma.externalContentSource.findFirst({ where: { id: receipt.input.externalContentSourceId, workspaceId, archivedAt: null } });
    invariant(selected, 409, "SOURCE_CHANGED", "External provider selection changed before commit.");
    inputs.set(receipt.input.id, { fingerprint, binding: bindingHash(selected) });
  }
  invariant(dependencies.roots.every(root => root.kind !== "ExternalProviderFetchInput"
    || inputs.get(root.id)?.fingerprint === root.fingerprint),
  409, "SOURCE_CHANGED", "External provider commit is missing a consumed native receipt.");
  invariant(await isArtifactInputProofReadable(actor, workspaceId, roots)
    && principal === getExternalProviderPrincipalUserId(actor, workspaceId) && actorHash === externalProviderResponseHash(actor)
    && purposeHash === externalProviderResponseHash(getExternalProviderWorkerPurpose(actor)),
  409, "SOURCE_CHANGED", "External provider inputs changed before commit.");
  for (const receipt of captured) await assertExternalProviderCapturedResponseCurrent(receipt);
  const opaque = Object.freeze({}) as ExternalProviderCommitPreflight;
  commitPreflights.set(opaque, { actor, actorHash, workspaceId, principal, purposeHash,
    submittedRoots: freezeComparable(submittedRoots), roots: freezeExact(roots), inputs });
  return opaque;
}

/** Existing stored native inputs are verified live through their complete original source proofs. */
export async function prepareExternalProviderRootCommitPreflight(actor: AppActor, workspaceId: string,
  originalRoots: readonly LineageRoot[]): Promise<ExternalProviderCommitPreflight> {
  assertOutsideArtifactNativeCommitPhase();
  const roots: LineageRoot[] = structuredClone([...originalRoots]);
  const submittedRoots = structuredClone(roots);
  const principal = getExternalProviderPrincipalUserId(actor, workspaceId);
  const actorHash = externalProviderResponseHash(actor);
  const purpose = getExternalProviderWorkerPurpose(actor);
  const purposeHash = externalProviderResponseHash(purpose);
  invariant(principal && roots.length > 0 && roots.length <= 10000
    && (!purpose || roots.some(root => root.kind === "WorkflowJobInput" && root.id === purpose.workflowJobId && root.permissionEpochs)),
  409, "SOURCE_CHANGED", "External provider commit lacks its original input proof.");
  const { inspectStoredArtifactInputDependencies, isArtifactInputProofReadable, lineageContentFingerprint } = await import("./source-lineage");
  const dependencies = await inspectStoredArtifactInputDependencies(prisma, workspaceId, roots);
  invariant(dependencies.complete && dependencies.roots.length <= 10000,
  409, "UNSUPPORTED_PROVIDER_INPUT", "Every native provider input needs its bounded commit adapter.");
  const { assertArtifactInputClosureLocallyAdmissible } = await import("./source-lineage");
  await assertArtifactInputClosureLocallyAdmissible(actor, workspaceId, roots);
  const native = dependencies.roots.filter(root => root.kind === "ExternalProviderFetchInput");
  invariant(native.length <= MAX_COMMIT_INPUTS, 409, "SOURCE_CHANGED", "External provider commit requires bounded native inputs.");
  let enclosingEpochs: Awaited<ReturnType<typeof savedEnclosingNativeEpochs>> | undefined;
  const inputs: CommitState["inputs"] = new Map();
  for (const root of native) {
    const direct = roots.find(input => input.kind === root.kind && input.id === root.id && input.fingerprint === root.fingerprint);
    let originalEpochs = direct?.permissionEpochs;
    if (!originalEpochs) {
      for (const snapshotRoot of dependencies.roots.filter(input => input.kind === "ArtifactInputSnapshot")) {
        const snapshot = await prisma.artifactInputSnapshot.findFirst({ where: { id: snapshotRoot.id, workspaceId }, select: {
          sourceKind: true, sourceId: true, sourceFingerprint: true, epochProofVersion: true, permissionEpochsJson: true } });
        if (snapshot?.sourceKind === root.kind && snapshot.sourceId === root.id && snapshot.sourceFingerprint === root.fingerprint
          && snapshot.epochProofVersion === 1) { originalEpochs = parsePermissionEpochProof(snapshot.permissionEpochsJson) ?? undefined; break; }
      }
    }
    if (!originalEpochs) {
      enclosingEpochs ??= await savedEnclosingNativeEpochs(workspaceId, submittedRoots, "ExternalProviderFetchInput");
      originalEpochs = enclosingEpochs.get(savedNativeVectorKey(root.kind, root.id, root.fingerprint));
    }
    const originalProof = parsePermissionEpochProof(originalEpochs);
    invariant(originalProof, 409, "SOURCE_CHANGED", "The original native permission proof is missing or changed.");
    invariant(originalProof.entries.some(entry => entry.kind === root.kind && entry.id === root.id)
      && await isArtifactPermissionEpochProofCurrent(workspaceId, originalProof),
    409, "SOURCE_CHANGED", "The original native permission proof is missing or changed.");
    // Retain the exact stored snapshot vector; never mint new permission epochs here.
    if (!direct?.permissionEpochs) roots.push({ ...root, permissionEpochs: originalProof });
    const input = await prisma.externalProviderFetchInput.findFirst({ where: { id: root.id, workspaceId } });
    invariant(input && lineageContentFingerprint("ExternalProviderFetchInput", input) === root.fingerprint,
      409, "SOURCE_CHANGED", "The original stored native input changed.");
    const source = await prisma.externalContentSource.findFirst({ where: { id: input.externalContentSourceId, workspaceId, archivedAt: null } });
    invariant(source, 409, "SOURCE_CHANGED", "External provider selection changed before commit.");
    inputs.set(input.id, { fingerprint: root.fingerprint, binding: bindingHash(source) });
  }
  invariant(roots.length <= 10000, 409, "SOURCE_CHANGED", "External provider commit requires a bounded original proof.");
  invariant(await isArtifactInputProofReadable(actor, workspaceId, roots)
    && principal === getExternalProviderPrincipalUserId(actor, workspaceId) && actorHash === externalProviderResponseHash(actor)
    && purposeHash === externalProviderResponseHash(getExternalProviderWorkerPurpose(actor)),
  409, "SOURCE_CHANGED", "The original input proof changed before commit.");
  const opaque = Object.freeze({}) as ExternalProviderCommitPreflight;
  commitPreflights.set(opaque, { actor, actorHash, workspaceId, principal, purposeHash,
    submittedRoots: freezeComparable(submittedRoots), roots: freezeExact(roots), inputs });
  return opaque;
}

/** Internal composite seam: claims are opaque, exact and consumed before any commit await. */
function claimExternalProviderCommitPreflight(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient,
  preflight: ExternalProviderCommitPreflight, submittedRoots?: readonly LineageRoot[]): ExternalProviderCommitClaim {
  const state = commitPreflights.get(preflight);
  invariant(state && state.actor === actor && state.workspaceId === workspaceId && tx !== prisma && !commitScope.getStore()
    && state.principal === getExternalProviderPrincipalUserId(actor, workspaceId) && state.actorHash === externalProviderResponseHash(actor)
    && state.purposeHash === externalProviderResponseHash(getExternalProviderWorkerPurpose(actor))
    && (!submittedRoots || isDeepStrictEqual(state.submittedRoots, submittedRoots)),
  409, "SOURCE_CHANGED", "External provider commit capability is unavailable.");
  commitPreflights.delete(preflight);
  const claim = Object.freeze({}) as ExternalProviderCommitClaim;
  commitClaims.set(claim, { ...state, tx });
  return claim;
}

/** Eligibility only: no authority/token escapes the active, exact native commit. */
export function isActiveExternalProviderCommit(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient) {
  const scope = commitScope.getStore();
  return Boolean(scope?.active && scope.actor === actor && scope.workspaceId === workspaceId && scope.tx === tx
    && scope.principal === getExternalProviderPrincipalUserId(actor, workspaceId)
    && scope.actorHash === externalProviderResponseHash(actor)
    && scope.purposeHash === externalProviderResponseHash(getExternalProviderWorkerPurpose(actor)));
}

/** Read-only peer lookup; a claimed plan is inert unless the safe provider wrapper is active. */
export function getActiveExternalMcpPeerClaim(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient) {
  const scope = commitScope.getStore();
  return scope?.active && scope.actor === actor && scope.workspaceId === workspaceId && scope.tx === tx
    && scope.principal === getExternalProviderPrincipalUserId(actor, workspaceId)
    && scope.actorHash === externalProviderResponseHash(actor) ? scope.mcpPeer ?? null : null;
}

async function runExternalProviderCommitClaim<T>(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient,
  claim: ExternalProviderCommitClaim, work: () => Promise<T>, mcpPeer?: ExternalMcpResponseCommitClaim): Promise<T> {
  const state = commitClaims.get(claim);
  invariant(state && state.actor === actor && state.workspaceId === workspaceId && state.tx === tx && !commitScope.getStore()
    && state.principal === getExternalProviderPrincipalUserId(actor, workspaceId) && state.actorHash === externalProviderResponseHash(actor)
    && state.purposeHash === externalProviderResponseHash(getExternalProviderWorkerPurpose(actor)),
  409, "SOURCE_CHANGED", "External provider commit claim is unavailable.");
  commitClaims.delete(claim);
  const scope = { ...state, active: true, mcpPeer };
  return commitScope.run(scope, async () => {
    try { return await work(); }
    finally { scope.active = false; }
  });
}

/** No model or provider operations belong in this bounded callback. This capability is never serialized. */
export async function withExternalProviderCommitPreflight<T>(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, preflight: ExternalProviderCommitPreflight, work: () => Promise<T>,
  beforeSourceEpochs?: () => Promise<void>): Promise<T> {
  const claim = claimExternalProviderCommitPreflight(actor, workspaceId, tx, preflight);
  const state = commitClaims.get(claim)!;
  for (const inputId of [...state.inputs.keys()].sort()) {
    if (!sourceAuthorityRowAlreadyLocked(tx, "ExternalProviderFetchInput", inputId))
      await tx.$queryRaw`SELECT "id" FROM "ExternalProviderFetchInput" WHERE "id" = ${inputId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    const input = await tx.externalProviderFetchInput.findFirst({ where: { id: inputId, workspaceId } });
    invariant(input, 409, "SOURCE_CHANGED", "External provider native input changed before commit.");
    if (!sourceAuthorityRowAlreadyLocked(tx, "ExternalMcpConnection", input.connectionId))
      await tx.$queryRaw`SELECT "id" FROM "ExternalMcpConnection" WHERE "id" = ${input.connectionId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    await lockSourceAuthorityPredicate(tx, "Member", { workspaceId, userId: input.localUserId },
      () => tx.$queryRaw`SELECT "id" FROM "Member" WHERE "userId" = ${input.localUserId} AND "workspaceId" = ${workspaceId} FOR SHARE`);
    if (!sourceAuthorityRowAlreadyLocked(tx, "ExternalContentSource", input.externalContentSourceId, "UPDATE"))
      await tx.$queryRaw`SELECT "id" FROM "ExternalContentSource" WHERE "id" = ${input.externalContentSourceId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  }
  const purpose = getExternalProviderWorkerPurpose(actor);
  if (purpose && !sourceAuthorityRowAlreadyLocked(tx, "WorkflowJob", purpose.workflowJobId))
    await tx.$queryRaw`SELECT "id" FROM "WorkflowJob" WHERE "id" = ${purpose.workflowJobId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
  if (beforeSourceEpochs) await withArtifactNativeCommitPhase(beforeSourceEpochs);
  const { isArtifactInputProofReadable } = await import("./source-lineage");
  return withArtifactNativeCommitPhase(() => runExternalProviderCommitClaim(actor, workspaceId, tx, claim, async () => {
      invariant(await isArtifactInputProofReadable(actor, workspaceId, state.roots, tx)
        && state.principal === getExternalProviderPrincipalUserId(actor, workspaceId) && state.actorHash === externalProviderResponseHash(actor),
      409, "SOURCE_CHANGED", "External provider original proof changed before copying.");
      const result = await work();
      invariant(await isArtifactInputProofReadable(actor, workspaceId, state.roots, tx)
        && state.principal === getExternalProviderPrincipalUserId(actor, workspaceId) && state.actorHash === externalProviderResponseHash(actor),
      409, "SOURCE_CHANGED", "External provider original proof changed during copying.");
      return result;
  }));
}

/** Mixed commits acquire both native row sets before any governing row, avoiding cross-kind lock inversions. */
async function lockMixedNativeRows(tx: Prisma.TransactionClient, workspaceId: string,
  providerIds: readonly string[], mcpIds: readonly string[], slackIds: readonly string[], actor: AppActor) {
  const providers = [] as Array<{ connectionId: string; localUserId: string; externalContentSourceId: string }>;
  const mcps = [] as Array<{ connectionId: string; localUserId: string }>;
  const native = [
    ...mcpIds.map(id => ({ kind: "ExternalMcpResponseInput" as const, id })),
    ...providerIds.map(id => ({ kind: "ExternalProviderFetchInput" as const, id })),
    ...slackIds.map(id => ({ kind: "CommunicationMessageNativeInput" as const, id })),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  for (const row of native) {
    if (row.kind === "CommunicationMessageNativeInput") {
      if (!sourceAuthorityRowAlreadyLocked(tx, "CommunicationMessageNativeInput", row.id))
        await tx.$queryRaw`SELECT "id" FROM "CommunicationMessageNativeInput" WHERE "id" = ${row.id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    } else if (row.kind === "ExternalMcpResponseInput") {
      if (!sourceAuthorityRowAlreadyLocked(tx, "ExternalMcpResponseInput", row.id))
        await tx.$queryRaw`SELECT "id" FROM "ExternalMcpResponseInput" WHERE "id" = ${row.id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
      const input = await tx.externalMcpResponseInput.findFirst({ where: { id: row.id, workspaceId } });
      invariant(input, 409, "SOURCE_CHANGED", "External MCP native input changed during mixed commit.");
      mcps.push(input);
    } else {
      if (!sourceAuthorityRowAlreadyLocked(tx, "ExternalProviderFetchInput", row.id))
        await tx.$queryRaw`SELECT "id" FROM "ExternalProviderFetchInput" WHERE "id" = ${row.id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
      const input = await tx.externalProviderFetchInput.findFirst({ where: { id: row.id, workspaceId } });
      invariant(input, 409, "SOURCE_CHANGED", "External provider native input changed during mixed commit.");
      providers.push(input);
    }
  }
  const connections = [...new Set([...providers, ...mcps].map(row => row.connectionId))].sort();
  const members = [...new Set([...providers, ...mcps].map(row => row.localUserId))].sort();
  const sources = [...new Set(providers.map(row => row.externalContentSourceId))].sort();
  for (const id of connections) if (!sourceAuthorityRowAlreadyLocked(tx, "ExternalMcpConnection", id))
    await tx.$queryRaw`SELECT "id" FROM "ExternalMcpConnection" WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
  for (const userId of members) await lockSourceAuthorityPredicate(tx, "Member", { workspaceId, userId },
    () => tx.$queryRaw`SELECT "id" FROM "Member" WHERE "userId" = ${userId} AND "workspaceId" = ${workspaceId} FOR SHARE`);
  for (const id of sources) if (!sourceAuthorityRowAlreadyLocked(tx, "ExternalContentSource", id, "UPDATE"))
    await tx.$queryRaw`SELECT "id" FROM "ExternalContentSource" WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  const purpose = getExternalProviderWorkerPurpose(actor);
  if (purpose && !sourceAuthorityRowAlreadyLocked(tx, "WorkflowJob", purpose.workflowJobId))
    await tx.$queryRaw`SELECT "id" FROM "WorkflowJob" WHERE "id" = ${purpose.workflowJobId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
  if (slackIds.length) await lockSlackNativeGoverningRows(tx, workspaceId, slackIds, actor);
}

/** Executable mixed scope: both plans are consumed before the first await and the whole proof is checked twice. */
export async function withExternalProviderNativeCommitPreflights<T>(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, submittedRoots: readonly LineageRoot[], providerToken: ExternalProviderCommitPreflight,
  mcpToken: ExternalMcpResponseCommitPreflight | undefined, slackToken: SlackNativeCommitPreflight | undefined,
  work: () => Promise<T>, beforeSourceEpochs?: () => Promise<void>): Promise<T> {
  const submitted = freezeComparable(structuredClone([...submittedRoots]));
  const providerClaim = claimExternalProviderCommitPreflight(actor, workspaceId, tx, providerToken, submitted);
  let mcpClaim: ExternalMcpResponseCommitClaim | undefined;
  let slackClaim: ReturnType<typeof claimSlackNativeCommitPreflight> | undefined;
  try {
    mcpClaim = mcpToken ? claimExternalMcpResponseCommitPreflight(actor, workspaceId, tx, mcpToken, submitted) : undefined;
    slackClaim = slackToken ? claimSlackNativeCommitPreflight(actor, workspaceId, tx, slackToken, submitted) : undefined;
  } catch (error) {
    commitClaims.delete(providerClaim);
    if (mcpToken) discardExternalMcpResponseCommitPreflight(mcpToken, mcpClaim);
    if (slackToken) discardSlackNativeCommitPreflight(slackToken, slackClaim);
    throw error;
  }
  try {
  const provider = commitClaims.get(providerClaim)!;
  const mcp = mcpClaim ? inspectExternalMcpResponseCommitClaim(mcpClaim) : undefined;
  const slack = slackClaim ? inspectSlackNativeCommitClaim(slackClaim) : undefined;
  invariant((!mcp || (mcp.actor === actor && mcp.workspaceId === workspaceId && mcp.tx === tx))
    && (!slack || (slack.actor === actor && slack.workspaceId === workspaceId && slack.tx === tx))
    && provider.roots.length >= submitted.length && (!mcp || mcp.roots.length >= submitted.length)
    && (!slack || slack.roots.length >= submitted.length),
  409, "SOURCE_CHANGED", "Mixed native commit plans disagree.");
  const roots = [...submitted, ...provider.roots.slice(submitted.length), ...(mcp?.roots.slice(submitted.length) ?? []),
    ...(slack?.roots.slice(submitted.length) ?? [])];
  invariant(roots.length <= 10000, 409, "SOURCE_CHANGED", "Mixed native proof is unbounded.");
  await lockMixedNativeRows(tx, workspaceId, [...provider.inputs.keys()], mcp?.inputIds ?? [], slack?.inputIds ?? [], actor);
  if (slackClaim) await lockSlackNativeCommitClaimRows(actor, workspaceId, tx, slackClaim);
  if (beforeSourceEpochs) await withArtifactNativeCommitPhase(beforeSourceEpochs);
  const { isArtifactInputProofReadable } = await import("./source-lineage");
  return await withArtifactNativeCommitPhase(() => runExternalProviderCommitClaim(actor, workspaceId, tx, providerClaim, async () => {
    const verified = async () => {
    invariant(await isArtifactInputProofReadable(actor, workspaceId, roots, tx),
      409, "SOURCE_CHANGED", "Mixed native original proof changed before writing.");
    const result = await work();
    invariant(await isArtifactInputProofReadable(actor, workspaceId, roots, tx),
      409, "SOURCE_CHANGED", "Mixed native original proof changed during writing.");
    return result;
    };
    if (slackClaim) return withClaimedSlackNativeCommitPreflight(actor, workspaceId, tx, slackClaim, verified);
    return verified();
  }, mcpClaim));
  } finally {
    commitClaims.delete(providerClaim);
    if (mcpToken) discardExternalMcpResponseCommitPreflight(mcpToken, mcpClaim);
    if (slackToken) discardSlackNativeCommitPreflight(slackToken, slackClaim);
  }
}

type RefetchCallback = (request: { actor: AppActor; workspaceId: string; sourceId: string; consumedResponseHash: string }) => Promise<void>;
let requestRefetch: RefetchCallback | undefined;
export function registerExternalProviderRefetchCallback(callback: RefetchCallback) { requestRefetch = callback; }

/** Every invocation checks the provider. Errors, rate limits and changes never become a cached success. */
export async function isExternalProviderFetchInputCurrent(actor: AppActor, workspaceId: string, input: ExternalProviderFetchInputRecord, db: AuthorityDb = prisma) {
  try {
    if (db === prisma && isArtifactNativeCommitPhase()) return false;
    // A supplied writer transaction must never fall through to the Box transport.
    if (db !== prisma && !commitScope.getStore()) return false;
    input = { ...input, requestJson: structuredClone(input.requestJson) };
    const principal = getExternalProviderPrincipalUserId(actor, workspaceId);
    const assertPrincipal = () => invariant(principal && principal === getExternalProviderPrincipalUserId(actor, workspaceId),
      409, "SOURCE_CHANGED", "External provider principal changed during verification.");
    if (!input.providerAccountId || input.workspaceId !== workspaceId || input.localUserId !== getExternalProviderPrincipalUserId(actor, workspaceId)
      || input.providerKey !== "box" || input.serverUrl !== "https://mcp.box.com"
      || (getExternalProviderWorkerPurpose(actor) && getExternalProviderWorkerPurpose(actor)!.sourceId !== input.externalContentSourceId)) return false;
    const args = record(input.requestJson);
    if (!args || !isBoxNativeContentRequest(input.sourceKind, input.externalId, input.toolName, args)) return false;
    const consumed = JSON.parse(decryptSecret(input.encryptedResponseJson));
    if (externalProviderResponseHash(consumed) !== input.responseHash) return false;
    const connection = await currentAuthority(actor, workspaceId, input.connectionId, db);
    const source = await db.externalContentSource.findFirst({ where: { id: input.externalContentSourceId, workspaceId, archivedAt: null } });
    if (!source || source.status === "ARCHIVED" || source.connectionId !== input.connectionId || source.selectedByUserId !== input.localUserId
      || source.sourceKind !== input.sourceKind || source.externalId !== input.externalId || connection.providerAccountId !== input.providerAccountId
      || externalMcpConnectionGrantHash(connection) !== input.connectionGrantHash) return false;
    const scope = commitScope.getStore();
    if (scope) {
      // A mismatched call inside a bounded commit never falls back to network access.
      if (!scope.active || db === prisma || db !== scope.tx || actor !== scope.actor || workspaceId !== scope.workspaceId
        || principal !== scope.principal || scope.actorHash !== externalProviderResponseHash(actor)
        || scope.purposeHash !== externalProviderResponseHash(getExternalProviderWorkerPurpose(actor))) return false;
      const expected = scope.inputs.get(input.id);
      if (!expected || expected.binding !== bindingHash(source)) return false;
      const persisted = await db.externalProviderFetchInput.findFirst({ where: { id: input.id, workspaceId } });
      const { lineageContentFingerprint } = await import("./source-lineage");
      if (!persisted || lineageContentFingerprint("ExternalProviderFetchInput", input) !== expected.fingerprint
        || lineageContentFingerprint("ExternalProviderFetchInput", persisted) !== expected.fingerprint) return false;
      for (const root of scope.roots) {
        if (root.permissionEpochs && !await isArtifactPermissionEpochProofCurrent(workspaceId, root.permissionEpochs, db)) return false;
      }
      assertPrincipal();
      return true;
    }
    const live = await readBoxExternalMcpNativeResponse({ actor, connectionId: input.connectionId, workspaceId,
      connectionGrantHash: input.connectionGrantHash, toolName: input.toolName, arguments: structuredClone(args) });
    await currentAuthority(actor, workspaceId, input.connectionId, db);
    assertPrincipal();
    const finalSource = await db.externalContentSource.findFirst({ where: { id: input.externalContentSourceId, workspaceId, archivedAt: null } });
    if (!finalSource || finalSource.sourceKind !== input.sourceKind || finalSource.externalId !== input.externalId
      || finalSource.connectionId !== input.connectionId || finalSource.selectedByUserId !== input.localUserId
      || !await isExternalProviderSelectionCurrent(actor, workspaceId, finalSource, db)) return false;
    assertPrincipal();
    const unchanged = externalProviderResponseHash(live) === input.responseHash;
    if (!unchanged && requestRefetch && !getExternalProviderWorkerPurpose(actor)) {
      try { await requestRefetch({ actor, workspaceId, sourceId: input.externalContentSourceId, consumedResponseHash: input.responseHash }); }
      catch { /* A failed refetch enqueue never permits the stale input. */ }
    }
    return unchanged;
  } catch { return false; }
}
