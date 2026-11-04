import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { assertOutsideArtifactNativeCommitPhase, isArtifactNativeCommitPhase, withArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import { savedEnclosingNativeEpochs, savedNativeVectorKey } from "./native-commit-original-vector";
import { lockSourceAuthorityPredicate, sourceAuthorityRowAlreadyLocked } from "./source-commit-row-locks";
import { externalMcpConnectionGrantHash, externalMcpNativeReadRequest, loadExternalMcpNativeConnection,
  readExternalMcpNativeToolResult, assertExternalMcpNativeReadOrigin, type ExternalMcpConnectionRecord } from "./external-mcp";
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent, parsePermissionEpochProof,
  type PermissionEpochProof } from "./source-permission-epochs";
import type { LineageRoot } from "./source-lineage";
import { claimSlackNativeCommitPreflight, inspectSlackNativeCommitClaim,
  discardSlackNativeCommitPreflight,
  lockSlackNativeGoverningRows, lockSlackNativeCommitClaimRows, withClaimedSlackNativeCommitPreflight,
  type SlackNativeCommitPreflight } from "./communication-native-authority";
import { sealArtifactInputActor } from "./source-lineage";

type Db = typeof prisma | Prisma.TransactionClient;
type Mode = "SEARCH" | "FETCH";
export type ExternalMcpResponseInputRecord = { id: string; workspaceId: string; connectionId: string; localUserId: string;
  providerKey: string; serverUrl: string; providerAccountId: string | null; mode: string; toolName: string;
  requestJson: unknown; encryptedResponseJson: string; responseHash: string; connectionGrantHash: string;
  originalLocalEpochsJson: unknown; fetchedAt: Date; createdAt: Date };
export type ExternalMcpCapturedResponse = Readonly<{ input: ExternalMcpResponseInputRecord; payload: unknown }>;
const outputReceipts = new WeakMap<object, { actor: AppActor; workspaceId: string; valueHash: string; roots: LineageRoot[] }>();
const MAX_NATIVE_INPUTS = 128;
const MAX_ROOTS = 10000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const externalMcpResponseHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) freezeJson((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
function principal(actor: AppActor, workspaceId: string) {
  invariant(actor.kind === "user" && !!actor.user.id && !!workspaceId, 403, "SOURCE_RESTRICTED", "External MCP content requires its connection owner.");
  return actor.user.id;
}
function originalEpochIdentities(workspaceId: string, userId: string, connectionId: string) {
  return [{ kind: "Workspace", id: workspaceId }, { kind: "MemberUserPolicy", id: userId },
    { kind: "WorkspaceSupportPolicy", id: userId }, { kind: "ExternalMcpConnection", id: connectionId },
    { kind: "ExternalMcpConnectionSetPolicy", id: userId }];
}
function nativeRequest(input: Pick<ExternalMcpResponseInputRecord, "providerKey" | "mode" | "toolName" | "serverUrl" | "requestJson">) {
  const args = asRecord(input.requestJson);
  if (!args || (input.mode !== "SEARCH" && input.mode !== "FETCH")) return null;
  try {
    const expected = input.mode === "SEARCH"
      ? externalMcpNativeReadRequest(input.providerKey, "SEARCH", { query: args.query as string, limit: args.limit as number })
      : externalMcpNativeReadRequest(input.providerKey, "FETCH", { externalId: input.providerKey === "box"
        ? typeof args.folder_id === "string" ? `folder:${args.folder_id}` : args.file_id as string : args.id as string });
    return input.serverUrl === expected.serverUrl && input.toolName === expected.toolName
      && canonical(args) === canonical(expected.arguments) ? expected : null;
  } catch { return null; }
}
async function currentAuthority(actor: AppActor, workspaceId: string, connectionId: string, db: Db) {
  const userId = principal(actor, workspaceId);
  await assertExternalMcpNativeReadOrigin(actor, workspaceId, db);
  await requireWorkspaceMembership({ actor, workspaceId, tx: db as Prisma.TransactionClient });
  const member = await db.member.findFirst({ where: { workspaceId, userId, isActive: true }, select: { id: true } });
  const connection = await db.externalMcpConnection.findFirst({ where: { id: connectionId, workspaceId, userId,
    status: "ACTIVE", providerKey: { in: ["box", "notion"] } } }) as ExternalMcpConnectionRecord | null;
  invariant(member && connection?.accessTokenEnc && (connection.providerKey !== "box" || connection.providerAccountId),
    403, "SOURCE_RESTRICTED", "External MCP connection authority is unavailable.");
  const expected = externalMcpNativeReadRequest(connection.providerKey, "SEARCH", { query: "authority", limit: 1 });
  invariant(connection.serverUrl === expected.serverUrl, 403, "SOURCE_RESTRICTED", "External MCP server changed.");
  return connection;
}

/** Preparatory local admission only; the safe reader still requires a live provider replay. */
export async function isExternalMcpResponseInputLocallyCurrent(actor: AppActor, workspaceId: string,
  input: ExternalMcpResponseInputRecord, db: Db = prisma) {
  try {
    const userId = principal(actor, workspaceId);
    if (input.workspaceId !== workspaceId || input.localUserId !== userId || !nativeRequest(input)) return false;
    const original = parsePermissionEpochProof(input.originalLocalEpochsJson);
    if (!original || !originalEpochIdentities(workspaceId, userId, input.connectionId).every(identity =>
      original.entries.some(entry => entry.kind === identity.kind && entry.id === identity.id))
      || !await isArtifactPermissionEpochProofCurrent(workspaceId, original, db)) return false;
    if (externalMcpResponseHash(JSON.parse(decryptSecret(input.encryptedResponseJson))) !== input.responseHash) return false;
    const connection = await currentAuthority(actor, workspaceId, input.connectionId, db);
    if (connection.providerKey !== input.providerKey || connection.serverUrl !== input.serverUrl
      || (connection.providerAccountId ?? null) !== input.providerAccountId
      || externalMcpConnectionGrantHash(connection) !== input.connectionGrantHash) return false;
    const stored = await db.externalMcpResponseInput.findFirst({ where: { id: input.id, workspaceId } });
    const { lineageContentFingerprint } = await import("./source-lineage");
    return !!stored && lineageContentFingerprint("ExternalMcpResponseInput", stored)
      === lineageContentFingerprint("ExternalMcpResponseInput", input);
  } catch { return false; }
}

/** Capture authority revisions before the network call; a changed grant can never restamp old bytes. */
export async function captureExternalMcpResponseInput(actor: AppActor, submitted: { workspaceId: string; connectionId: string;
  mode: Mode; query?: string; limit?: number; externalId?: string }): Promise<ExternalMcpCapturedResponse> {
  assertOutsideArtifactNativeCommitPhase();
  sealArtifactInputActor(actor);
  const params = freezeJson(structuredClone(submitted));
  const userId = principal(actor, params.workspaceId);
  const originIdentity = await assertExternalMcpNativeReadOrigin(actor, params.workspaceId);
  const assertPrincipal = () => invariant(principal(actor, params.workspaceId) === userId,
    409, "SOURCE_CHANGED", "External MCP principal changed during capture.");
  const connection = await loadExternalMcpNativeConnection(actor, params.workspaceId, params.connectionId);
  assertPrincipal();
  const request = externalMcpNativeReadRequest(connection.providerKey, params.mode, params);
  const grant = externalMcpConnectionGrantHash(connection);
  const originalEpochs = await prisma.$transaction(async tx => {
    const current = await currentAuthority(actor, params.workspaceId, params.connectionId, tx);
    invariant(externalMcpConnectionGrantHash(current) === grant, 409, "SOURCE_CHANGED", "External MCP grant changed before the read.");
    return capturePermissionEpochs(tx, params.workspaceId, originalEpochIdentities(params.workspaceId, userId, connection.id));
  });
  assertPrincipal();
  const payload = await readExternalMcpNativeToolResult(actor, { workspaceId: params.workspaceId, connectionId: connection.id,
    connectionGrantHash: grant, providerKey: connection.providerKey, serverUrl: connection.serverUrl,
    providerAccountId: connection.providerAccountId ?? null, mode: params.mode, toolName: request.toolName,
    arguments: structuredClone(request.arguments) });
  assertPrincipal();
  invariant(await assertExternalMcpNativeReadOrigin(actor, params.workspaceId) === originIdentity,
    403, "MCP_AUTHORIZATION_REVOKED", "External MCP read consent changed during capture.");
  const responseHash = externalMcpResponseHash(payload);
  const input = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "ExternalMcpConnection" WHERE "id" = ${connection.id} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "userId" = ${userId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
    invariant(await isArtifactPermissionEpochProofCurrent(params.workspaceId, originalEpochs, tx),
      409, "SOURCE_CHANGED", "External MCP authority changed during the read.");
    const current = await currentAuthority(actor, params.workspaceId, connection.id, tx);
    invariant(externalMcpConnectionGrantHash(current) === grant && current.providerAccountId === (connection.providerAccountId ?? null),
      409, "SOURCE_CHANGED", "External MCP grant changed during the read.");
    const saved = await tx.externalMcpResponseInput.create({ data: { workspaceId: params.workspaceId, connectionId: connection.id,
      localUserId: userId, providerKey: connection.providerKey, serverUrl: connection.serverUrl,
      providerAccountId: connection.providerAccountId ?? null, mode: params.mode, toolName: request.toolName,
      requestJson: request.arguments as Prisma.InputJsonObject, encryptedResponseJson: encryptSecret(canonical(payload)),
      responseHash, connectionGrantHash: grant, originalLocalEpochsJson: originalEpochs as unknown as Prisma.InputJsonObject } });
    invariant(await isArtifactPermissionEpochProofCurrent(params.workspaceId, originalEpochs, tx)
      && externalMcpConnectionGrantHash(await currentAuthority(actor, params.workspaceId, connection.id, tx)) === grant,
    409, "SOURCE_CHANGED", "External MCP grant changed while storing the read.");
    return saved;
  });
  assertPrincipal();
  const receipt = Object.freeze({ input: Object.freeze(structuredClone(input)) as ExternalMcpResponseInputRecord,
    payload: freezeJson(structuredClone(payload)) });
  return receipt;
}


type CommitState = { actor: AppActor; actorHash: string; workspaceId: string; userId: string;
  submittedRoots: LineageRoot[]; roots: LineageRoot[];
  inputs: Map<string, { fingerprint: string; originalEpochs: PermissionEpochProof }> };
declare const commitBrand: unique symbol;
export type ExternalMcpResponseCommitPreflight = { readonly [commitBrand]: true };
const preflights = new WeakMap<object, CommitState>();
const commitScope = new AsyncLocalStorage<CommitState & { tx: Prisma.TransactionClient; active: boolean }>();
declare const claimBrand: unique symbol;
export type ExternalMcpResponseCommitClaim = { readonly [claimBrand]: true };
const claims = new WeakMap<object, CommitState & { tx: Prisma.TransactionClient }>();
/** Cancellation confers no authority; an attempted owner commit burns every peer plan. */
export function discardExternalMcpResponseCommitPreflight(token: ExternalMcpResponseCommitPreflight,
  claim?: ExternalMcpResponseCommitClaim) {
  preflights.delete(token);
  if (claim) claims.delete(claim);
}

/** Bounded provider replay happens before the writer transaction, using only original root proofs. */
export async function prepareExternalMcpResponseCommitPreflight(actor: AppActor, workspaceId: string,
  originalRoots: readonly LineageRoot[]): Promise<ExternalMcpResponseCommitPreflight> {
  assertOutsideArtifactNativeCommitPhase();
  const roots = structuredClone([...originalRoots]);
  const submittedRoots = structuredClone(roots);
  const userId = principal(actor, workspaceId);
  const actorHash = externalMcpResponseHash(actor);
  invariant(roots.length > 0 && roots.length <= MAX_ROOTS, 409, "SOURCE_CHANGED", "External MCP commit requires bounded original inputs.");
  const { inspectStoredArtifactInputDependencies, assertArtifactInputClosureLocallyAdmissible,
    isArtifactInputProofReadable, lineageContentFingerprint } = await import("./source-lineage");
  const dependencies = await inspectStoredArtifactInputDependencies(prisma, workspaceId, roots);
  invariant(dependencies.complete && dependencies.roots.length <= MAX_ROOTS,
    409, "UNKNOWN_LINEAGE", "External MCP commit inputs have incomplete ancestry.");
  await assertArtifactInputClosureLocallyAdmissible(actor, workspaceId, roots);
  const native = dependencies.roots.filter(root => root.kind === "ExternalMcpResponseInput");
  invariant(native.length > 0 && native.length <= MAX_NATIVE_INPUTS,
    409, "SOURCE_CHANGED", "External MCP commit needs a bounded native response.");
  let enclosingEpochs: Awaited<ReturnType<typeof savedEnclosingNativeEpochs>> | undefined;
  const inputs: CommitState["inputs"] = new Map();
  for (const root of native) {
    const direct = roots.find(item => item.kind === root.kind && item.id === root.id && item.fingerprint === root.fingerprint);
    let originalProof = parsePermissionEpochProof(direct?.permissionEpochs);
    if (!originalProof) {
      for (const snapshotRoot of dependencies.roots.filter(item => item.kind === "ArtifactInputSnapshot")) {
        const snapshot = await prisma.artifactInputSnapshot.findFirst({ where: { id: snapshotRoot.id, workspaceId },
          select: { sourceKind: true, sourceId: true, sourceFingerprint: true, epochProofVersion: true, permissionEpochsJson: true } });
        if (snapshot?.sourceKind === root.kind && snapshot.sourceId === root.id && snapshot.sourceFingerprint === root.fingerprint
          && snapshot.epochProofVersion === 1) { originalProof = parsePermissionEpochProof(snapshot.permissionEpochsJson); break; }
      }
    }
    if (!originalProof) {
      enclosingEpochs ??= await savedEnclosingNativeEpochs(workspaceId, submittedRoots, "ExternalMcpResponseInput");
      originalProof = enclosingEpochs.get(savedNativeVectorKey(root.kind, root.id, root.fingerprint)) ?? null;
    }
    invariant(originalProof && originalProof.entries.some(entry => entry.kind === root.kind && entry.id === root.id)
      && await isArtifactPermissionEpochProofCurrent(workspaceId, originalProof),
    409, "SOURCE_CHANGED", "External MCP native input is missing its original permission revision.");
    if (!direct?.permissionEpochs) roots.push({ ...root, permissionEpochs: originalProof });
    const input = await prisma.externalMcpResponseInput.findFirst({ where: { id: root.id, workspaceId } });
    invariant(input && lineageContentFingerprint("ExternalMcpResponseInput", input) === root.fingerprint,
      409, "SOURCE_CHANGED", "External MCP native input changed before commit.");
    inputs.set(input.id, { fingerprint: root.fingerprint, originalEpochs: originalProof });
  }
  invariant(roots.length <= MAX_ROOTS && await isArtifactInputProofReadable(actor, workspaceId, roots)
    && principal(actor, workspaceId) === userId && actorHash === externalMcpResponseHash(actor),
  409, "SOURCE_CHANGED", "External MCP original proof changed before commit.");
  const token = Object.freeze({}) as ExternalMcpResponseCommitPreflight;
  preflights.set(token, { actor, actorHash, workspaceId, userId,
    submittedRoots: freezeJson(submittedRoots), roots: freezeJson(roots), inputs });
  return token;
}

/** Internal composite seam: consume an exact capability synchronously, before native row locks. */
export function claimExternalMcpResponseCommitPreflight(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient,
  token: ExternalMcpResponseCommitPreflight, submittedRoots?: readonly LineageRoot[]): ExternalMcpResponseCommitClaim {
  const state = preflights.get(token);
  invariant(state && state.actor === actor && state.workspaceId === workspaceId && tx !== prisma && !commitScope.getStore()
    && state.userId === principal(actor, workspaceId) && state.actorHash === externalMcpResponseHash(actor)
    && (!submittedRoots || isDeepStrictEqual(state.submittedRoots, submittedRoots)),
  409, "SOURCE_CHANGED", "External MCP commit capability is unavailable.");
  preflights.delete(token);
  const claim = Object.freeze({}) as ExternalMcpResponseCommitClaim;
  claims.set(claim, { ...state, tx });
  return claim;
}

export function inspectExternalMcpResponseCommitClaim(claim: ExternalMcpResponseCommitClaim) {
  const state = claims.get(claim);
  invariant(state, 409, "SOURCE_CHANGED", "External MCP commit claim is unavailable.");
  return { inputIds: [...state.inputs.keys()], roots: state.roots, actor: state.actor, workspaceId: state.workspaceId, tx: state.tx };
}

async function runExternalMcpResponseCommitClaim<T>(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient,
  claim: ExternalMcpResponseCommitClaim, work: () => Promise<T>): Promise<T> {
  const state = claims.get(claim);
  invariant(state && state.actor === actor && state.workspaceId === workspaceId && state.tx === tx && !commitScope.getStore()
    && state.userId === principal(actor, workspaceId) && state.actorHash === externalMcpResponseHash(actor),
  409, "SOURCE_CHANGED", "External MCP commit claim is unavailable.");
  claims.delete(claim);
  const scope = { ...state, active: true };
  return commitScope.run(scope, async () => {
    try { return await work(); }
    finally { scope.active = false; }
  });
}

/** Supplied transactions cannot make network calls or adopt a newer grant revision. */
export async function withExternalMcpResponseCommitPreflight<T>(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, token: ExternalMcpResponseCommitPreflight, work: () => Promise<T>,
  beforeSourceEpochs?: () => Promise<void>): Promise<T> {
  const claim = claimExternalMcpResponseCommitPreflight(actor, workspaceId, tx, token);
  const state = claims.get(claim)!;
  for (const id of [...state.inputs.keys()].sort()) {
    if (!sourceAuthorityRowAlreadyLocked(tx, "ExternalMcpResponseInput", id))
      await tx.$queryRaw`SELECT "id" FROM "ExternalMcpResponseInput" WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    const input = await tx.externalMcpResponseInput.findFirst({ where: { id, workspaceId } });
    invariant(input, 409, "SOURCE_CHANGED", "External MCP native input changed during commit.");
    if (!sourceAuthorityRowAlreadyLocked(tx, "ExternalMcpConnection", input.connectionId))
      await tx.$queryRaw`SELECT "id" FROM "ExternalMcpConnection" WHERE "id" = ${input.connectionId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    await lockSourceAuthorityPredicate(tx, "Member", { workspaceId, userId: input.localUserId },
      () => tx.$queryRaw`SELECT "id" FROM "Member" WHERE "userId" = ${input.localUserId} AND "workspaceId" = ${workspaceId} FOR SHARE`);
  }
  if (beforeSourceEpochs) await withArtifactNativeCommitPhase(beforeSourceEpochs);
  const { isArtifactInputProofReadable } = await import("./source-lineage");
  return withArtifactNativeCommitPhase(() => runExternalMcpResponseCommitClaim(actor, workspaceId, tx, claim, async () => {
      invariant(await isArtifactInputProofReadable(actor, workspaceId, state.roots, tx),
        409, "SOURCE_CHANGED", "External MCP original proof changed before writing.");
      const result = await work();
      invariant(await isArtifactInputProofReadable(actor, workspaceId, state.roots, tx),
        409, "SOURCE_CHANGED", "External MCP original proof changed during writing.");
      return result;
  }));
}

/** Safe two-provider executor: consume both plans synchronously, then lock all native rows before governors or epochs. */
export async function withExternalMcpAndSlackCommitPreflights<T>(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, submitted: readonly LineageRoot[], mcpToken: ExternalMcpResponseCommitPreflight,
  slackToken: SlackNativeCommitPreflight, work: () => Promise<T>,
  beforeSourceEpochs?: () => Promise<void>): Promise<T> {
  const mcpClaim = claimExternalMcpResponseCommitPreflight(actor, workspaceId, tx, mcpToken, submitted);
  let slackClaim: ReturnType<typeof claimSlackNativeCommitPreflight>;
  try {
    slackClaim = claimSlackNativeCommitPreflight(actor, workspaceId, tx, slackToken, submitted);
  } catch (error) {
    discardExternalMcpResponseCommitPreflight(mcpToken, mcpClaim);
    discardSlackNativeCommitPreflight(slackToken);
    throw error;
  }
  try {
  const mcp = claims.get(mcpClaim)!;
  const slack = inspectSlackNativeCommitClaim(slackClaim);
  invariant(slack.actor === actor && slack.workspaceId === workspaceId && slack.tx === tx,
    409, "SOURCE_CHANGED", "Native commit principals disagree.");
  const roots = [...submitted, ...mcp.roots.slice(submitted.length), ...slack.roots.slice(submitted.length)];
  invariant(roots.length <= MAX_ROOTS, 409, "UNKNOWN_LINEAGE", "Mixed native proof is unbounded.");
  const native = [
    ...[...mcp.inputs.keys()].map(id => ({ kind: "ExternalMcpResponseInput", id })),
    ...slack.inputIds.map(id => ({ kind: "CommunicationMessageNativeInput", id })),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  for (const row of native) {
    if (row.kind === "ExternalMcpResponseInput") {
      if (!sourceAuthorityRowAlreadyLocked(tx, "ExternalMcpResponseInput", row.id))
        await tx.$queryRaw`SELECT "id" FROM "ExternalMcpResponseInput" WHERE "id" = ${row.id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    } else if (!sourceAuthorityRowAlreadyLocked(tx, "CommunicationMessageNativeInput", row.id))
      await tx.$queryRaw`SELECT "id" FROM "CommunicationMessageNativeInput" WHERE "id" = ${row.id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
  }
  for (const id of [...mcp.inputs.keys()].sort()) {
    const input = await tx.externalMcpResponseInput.findFirst({ where: { id, workspaceId } });
    invariant(input, 409, "SOURCE_CHANGED", "External MCP native input changed during commit.");
    if (!sourceAuthorityRowAlreadyLocked(tx, "ExternalMcpConnection", input.connectionId))
      await tx.$queryRaw`SELECT "id" FROM "ExternalMcpConnection" WHERE "id" = ${input.connectionId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    await lockSourceAuthorityPredicate(tx, "Member", { workspaceId, userId: input.localUserId },
      () => tx.$queryRaw`SELECT "id" FROM "Member" WHERE "userId" = ${input.localUserId} AND "workspaceId" = ${workspaceId} FOR SHARE`);
  }
  await lockSlackNativeGoverningRows(tx, workspaceId, slack.inputIds, actor);
  await lockSlackNativeCommitClaimRows(actor, workspaceId, tx, slackClaim);
  if (beforeSourceEpochs) await withArtifactNativeCommitPhase(beforeSourceEpochs);
  const { isArtifactInputProofReadable } = await import("./source-lineage");
  return await withArtifactNativeCommitPhase(() => runExternalMcpResponseCommitClaim(actor, workspaceId, tx, mcpClaim,
    () => withClaimedSlackNativeCommitPreflight(actor, workspaceId, tx, slackClaim, async () => {
      invariant(await isArtifactInputProofReadable(actor, workspaceId, roots, tx),
        409, "SOURCE_CHANGED", "Mixed native proof changed before publication.");
      const result = await work();
      invariant(await isArtifactInputProofReadable(actor, workspaceId, roots, tx),
        409, "SOURCE_CHANGED", "Mixed native proof changed during publication.");
      return result;
    })));
  } finally {
    discardExternalMcpResponseCommitPreflight(mcpToken, mcpClaim);
    discardSlackNativeCommitPreflight(slackToken, slackClaim);
  }
}

/** Live replay is mandatory outside the exact single-use commit transaction. */
export async function isExternalMcpResponseInputCurrent(actor: AppActor, workspaceId: string,
  input: ExternalMcpResponseInputRecord, db: Db = prisma): Promise<boolean> {
  try {
    if (db === prisma && isArtifactNativeCommitPhase()) return false;
    const userId = principal(actor, workspaceId);
    if (input.workspaceId !== workspaceId || input.localUserId !== userId || !nativeRequest(input)) return false;
    const original = parsePermissionEpochProof(input.originalLocalEpochsJson);
    if (!original || !originalEpochIdentities(workspaceId, userId, input.connectionId).every(identity =>
      original.entries.some(entry => entry.kind === identity.kind && entry.id === identity.id))) return false;
    if (!await isArtifactPermissionEpochProofCurrent(workspaceId, original, db)) return false;
    const consumed = JSON.parse(decryptSecret(input.encryptedResponseJson));
    if (externalMcpResponseHash(consumed) !== input.responseHash) return false;
    const connection = await currentAuthority(actor, workspaceId, input.connectionId, db);
    if (connection.providerKey !== input.providerKey || connection.serverUrl !== input.serverUrl
      || (connection.providerAccountId ?? null) !== input.providerAccountId
      || externalMcpConnectionGrantHash(connection) !== input.connectionGrantHash) return false;
    const stored = await db.externalMcpResponseInput.findFirst({ where: { id: input.id, workspaceId } });
    const { lineageContentFingerprint } = await import("./source-lineage");
    if (!stored || lineageContentFingerprint("ExternalMcpResponseInput", stored)
      !== lineageContentFingerprint("ExternalMcpResponseInput", input)) return false;
    const nativeEpoch = db === prisma ? await prisma.sourcePermissionEpoch.findUnique({ where: {
      workspaceId_sourceKind_sourceId: { workspaceId, sourceKind: "ExternalMcpResponseInput", sourceId: input.id },
    }, select: { epoch: true } }) : null;
    if (db === prisma && !nativeEpoch) return false;
    let scope = commitScope.getStore();
    if (db !== prisma && !scope) {
      const { getActiveExternalMcpPeerClaim } = await import("./external-provider-authority");
      const peerClaim = getActiveExternalMcpPeerClaim(actor, workspaceId, db);
      const peer = peerClaim && claims.get(peerClaim);
      if (peer) scope = { ...peer, tx: db, active: true };
    }
    if (db !== prisma) {
      if (!scope?.active || scope.tx !== db || scope.actor !== actor || scope.workspaceId !== workspaceId
        || scope.userId !== userId || scope.actorHash !== externalMcpResponseHash(actor)
        || scope.inputs.get(input.id)?.fingerprint !== lineageContentFingerprint("ExternalMcpResponseInput", input)) return false;
      for (const root of scope.roots) if (root.permissionEpochs
        && !await isArtifactPermissionEpochProofCurrent(workspaceId, root.permissionEpochs, db)) return false;
      return true;
    }
    if (scope) return false;
    await assertExternalMcpNativeReadOrigin(actor, workspaceId);
    const request = nativeRequest(input)!;
    const live = await readExternalMcpNativeToolResult(actor, { workspaceId, connectionId: input.connectionId,
      connectionGrantHash: input.connectionGrantHash, providerKey: input.providerKey, serverUrl: input.serverUrl,
      providerAccountId: input.providerAccountId, mode: input.mode as Mode, toolName: input.toolName,
      arguments: structuredClone(request.arguments) });
    if (externalMcpResponseHash(live) !== input.responseHash) return false;
    const finalInput = await prisma.externalMcpResponseInput.findFirst({ where: { id: input.id, workspaceId } });
    const finalEpoch = await prisma.sourcePermissionEpoch.findUnique({ where: {
      workspaceId_sourceKind_sourceId: { workspaceId, sourceKind: "ExternalMcpResponseInput", sourceId: input.id },
    }, select: { epoch: true } });
    if (!finalInput || !finalEpoch || finalEpoch.epoch !== nativeEpoch!.epoch
      || lineageContentFingerprint("ExternalMcpResponseInput", finalInput)
        !== lineageContentFingerprint("ExternalMcpResponseInput", input)) return false;
    if (!await isArtifactPermissionEpochProofCurrent(workspaceId, original)
      || externalMcpConnectionGrantHash(await currentAuthority(actor, workspaceId, input.connectionId, prisma)) !== input.connectionGrantHash) return false;
    return principal(actor, workspaceId) === userId;
  } catch { return false; }
}

/** DTO identity cannot be replaced, edited, or replayed by another principal. */
export function registerExternalMcpResponseOutput<T extends object>(actor: AppActor, workspaceId: string, value: T, roots: readonly LineageRoot[]): T {
  invariant(roots.length > 0 && roots.some(root => root.kind === "ExternalMcpResponseInput" || root.kind === "ExternalMcpConnectionSet"),
    409, "UNKNOWN_LINEAGE", "External MCP output has no native response receipt.");
  outputReceipts.set(value, { actor, workspaceId, valueHash: externalMcpResponseHash(value), roots: structuredClone([...roots]) });
  return value;
}
export async function getExternalMcpResponseInputRoots(actor: AppActor, workspaceId: string, value: object) {
  const receipt = outputReceipts.get(value);
  invariant(receipt && receipt.actor === actor && receipt.workspaceId === workspaceId
    && receipt.valueHash === externalMcpResponseHash(value),
  409, "UNKNOWN_LINEAGE", "External MCP output is not its registered result.");
  const { isArtifactInputProofReadable } = await import("./source-lineage");
  invariant(await isArtifactInputProofReadable(actor, workspaceId, receipt.roots),
    409, "SOURCE_CHANGED", "External MCP output inputs changed.");
  return structuredClone(receipt.roots);
}
