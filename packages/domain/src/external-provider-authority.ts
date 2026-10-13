import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import type { LineageRoot } from "./source-lineage";
import { isArtifactPermissionEpochProofCurrent } from "./source-permission-epochs";
import { getExternalProviderPrincipalUserId, getExternalProviderWorkerPurpose, registerExternalProviderWorkerPrincipal,
  revokeExternalProviderWorkerPrincipal } from "./external-provider-principal";
export { getExternalProviderPrincipalUserId } from "./external-provider-principal";
import { externalMcpConnectionGrantHash, isBoxNativeContentRequest, readBoxExternalMcpNativeResponse,
  type ExternalMcpConnectionRecord } from "./external-mcp";

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
  actor: AppActor; actorHash: string; workspaceId: string; principal: string; purposeHash: string; roots: LineageRoot[];
  inputs: Map<string, { fingerprint: string; binding: string }>;
};
const commitPreflights = new WeakMap<object, CommitState>();
const commitScope = new AsyncLocalStorage<CommitState & { tx: Prisma.TransactionClient; active: boolean }>();
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

function freezeExact<T>(value: T): T {
  if (value instanceof Date) {
    const fixed = new Date(value.getTime());
    return new Proxy(Object.freeze(fixed), { get(target, key) {
      if (typeof key === "string" && key.startsWith("set")) return () => { throw new TypeError("Receipt dates are immutable."); };
      const entry = Reflect.get(target, key, target);
      return typeof entry === "function" ? entry.bind(target) : entry;
    } }) as T;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) (value as Record<string, unknown>)[key] = freezeExact((value as Record<string, unknown>)[key]);
    return Object.freeze(value);
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
  commitPreflights.set(opaque, { actor, actorHash, workspaceId, principal, purposeHash, roots: freezeExact(roots), inputs });
  return opaque;
}

/** No model or provider operations belong in this bounded callback. This capability is never serialized. */
export async function withExternalProviderCommitPreflight<T>(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, preflight: ExternalProviderCommitPreflight, work: () => Promise<T>): Promise<T> {
  const state = commitPreflights.get(preflight);
  invariant(state && state.actor === actor && state.workspaceId === workspaceId && tx !== prisma && !commitScope.getStore()
    && state.principal === getExternalProviderPrincipalUserId(actor, workspaceId) && state.actorHash === externalProviderResponseHash(actor)
    && state.purposeHash === externalProviderResponseHash(getExternalProviderWorkerPurpose(actor)),
  409, "SOURCE_CHANGED", "External provider commit capability is unavailable.");
  // Consume before the first await; retries must perform a fresh live preflight.
  commitPreflights.delete(preflight);
  for (const inputId of [...state.inputs.keys()].sort()) {
    await tx.$queryRaw`SELECT "id" FROM "ExternalProviderFetchInput" WHERE "id" = ${inputId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    const input = await tx.externalProviderFetchInput.findFirst({ where: { id: inputId, workspaceId } });
    invariant(input, 409, "SOURCE_CHANGED", "External provider native input changed before commit.");
    await tx.$queryRaw`SELECT "id" FROM "ExternalMcpConnection" WHERE "id" = ${input.connectionId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "userId" = ${input.localUserId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "ExternalContentSource" WHERE "id" = ${input.externalContentSourceId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  }
  const purpose = getExternalProviderWorkerPurpose(actor);
  if (purpose) await tx.$queryRaw`SELECT "id" FROM "WorkflowJob" WHERE "id" = ${purpose.workflowJobId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
  const { isArtifactInputProofReadable } = await import("./source-lineage");
  const scope = { ...state, tx, active: true };
  return commitScope.run(scope, async () => {
    try {
      invariant(await isArtifactInputProofReadable(actor, workspaceId, state.roots, tx)
        && state.principal === getExternalProviderPrincipalUserId(actor, workspaceId) && state.actorHash === externalProviderResponseHash(actor),
      409, "SOURCE_CHANGED", "External provider original proof changed before copying.");
      const result = await work();
      invariant(await isArtifactInputProofReadable(actor, workspaceId, state.roots, tx)
        && state.principal === getExternalProviderPrincipalUserId(actor, workspaceId) && state.actorHash === externalProviderResponseHash(actor),
      409, "SOURCE_CHANGED", "External provider original proof changed during copying.");
      return result;
    } finally { scope.active = false; }
  });
}

type RefetchCallback = (request: { actor: AppActor; workspaceId: string; sourceId: string; consumedResponseHash: string }) => Promise<void>;
let requestRefetch: RefetchCallback | undefined;
export function registerExternalProviderRefetchCallback(callback: RefetchCallback) { requestRefetch = callback; }

/** Every invocation checks the provider. Errors, rate limits and changes never become a cached success. */
export async function isExternalProviderFetchInputCurrent(actor: AppActor, workspaceId: string, input: ExternalProviderFetchInputRecord, db: AuthorityDb = prisma) {
  try {
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
