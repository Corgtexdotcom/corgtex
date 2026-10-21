import { WebClient } from "@slack/web-api";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { Prisma, CommunicationInstallation } from "@prisma/client";
import { decryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { assertOutsideArtifactNativeCommitPhase, isArtifactNativeCommitPhase, withArtifactNativeCommitPhase } from "./artifact-native-commit-phase";
import { communicationCanonicalJson, communicationNativeHash, freezeCommunicationPayload, isStoredSlackIngressSignatureCurrent } from "./communication-native-ingress";
import { isArtifactPermissionEpochProofCurrent, parsePermissionEpochProof } from "./source-permission-epochs";
import { savedEnclosingNativeEpochs, savedNativeVectorKey } from "./native-commit-original-vector";
import { lockSourceAuthorityPredicate, sourceAuthorityRowAlreadyLocked } from "./source-commit-row-locks";
import { getMcpOrigin } from "../../shared/src/mcp-context";
import type { LineageRoot } from "./source-lineage";
import { sealArtifactInputActor } from "./artifact-input-actor";

type NativeDb = Prisma.TransactionClient | typeof prisma;
export type CommunicationMessageNativeInputRecord = {
  id: string; workspaceId: string; installationId: string; communicationMessageId: string; provider: string;
  externalWorkspaceId: string; appId: string | null; providerPrincipalId: string;
  externalChannelId: string; externalMessageId: string; externalUserId: string | null; threadExternalId: string | null;
  mode: string; ingressInputId: string | null; requestJson: unknown; encryptedPayloadJson: string;
  projectedContentJson: unknown; projectionHash: string; installationGrantHash: string; channelGrantHash: string;
  permissionEpochsJson: unknown; epochProofVersion: number; expiresRawAt: Date; fetchedAt: Date;
};
export type CommunicationIngressInputRecord = {
  id: string; workspaceId: string; installationId: string; provider: string; externalWorkspaceId: string; appId: string | null;
  ingressKind: string; externalEventId: string | null; requestTimestamp: string; signature: string; signingBindingHash: string;
  installationGrantHash: string; encryptedRawBody: string; bodyHash: string; permissionEpochsJson: unknown;
  epochProofVersion: number; expiresRawAt: Date;
};
type MessageTarget = Readonly<{ workspaceId: string; installationId: string; channelId: string; messageTs: string; threadTs?: string | null }>;
export type SlackNativeFetchReceipt = Readonly<{ target: MessageTarget; payload: Readonly<Record<string, unknown>>;
  projected: Readonly<Record<string, unknown>>; installationGrantHash: string; channelGrantHash: string;
  providerPrincipalId: string; request: Readonly<Record<string, unknown>>; capturedAtMs: number }>;
const fetched = new WeakSet<object>();
const consumedFetches = new WeakSet<object>();
const commitReceipt = new AsyncLocalStorage<{ actor: AppActor; actorHash: string; workspaceId: string;
  tx: Prisma.TransactionClient; receipts: ReadonlyMap<string, SlackNativeFetchReceipt>;
  expected?: ReadonlyMap<string, { fingerprint: string; storedHash: string }>; active: boolean }>();
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const hash = (value: unknown) => communicationNativeHash(communicationCanonicalJson(value));
export function communicationInstallationGrantHash(installation: CommunicationInstallation) {
  return hash({ id: installation.id, workspaceId: installation.workspaceId, provider: installation.provider,
    externalWorkspaceId: installation.externalWorkspaceId, appId: installation.appId, botUserId: installation.botUserId,
    status: installation.status, disconnectedAt: installation.disconnectedAt?.toISOString(), scopes: [...installation.scopes].sort(),
    optionalScopes: [...installation.optionalScopes].sort(), settings: installation.settings,
    tokenHash: installation.botTokenEnc ? communicationNativeHash(installation.botTokenEnc) : null });
}
export function slackNativeMessageProjection(value: unknown, target: MessageTarget): Readonly<Record<string, unknown>> {
  const message = record(value);
  invariant(message && message.ts === target.messageTs && typeof message.user === "string" && message.user
    && typeof message.text === "string" && !message.hidden && !message.bot_id && !message.is_bot
    && (!message.channel || message.channel === target.channelId)
    && (!message.subtype || message.subtype === "thread_broadcast")
    && (!message.type || ["message", "app_mention"].includes(String(message.type)))
    && (!message.files || (Array.isArray(message.files) && !message.files.length))
    && (!message.attachments || (Array.isArray(message.attachments) && !message.attachments.length))
    && (!message.blocks || Array.isArray(message.blocks))
    && (!target.threadTs || (message.thread_ts || message.ts) === target.threadTs),
  409, "SOURCE_RESTRICTED", "The Slack message cannot be admitted as a complete native input.");
  // Provider-only envelope/counter fields are preserved encrypted, never copied into the served body.
  return freezeCommunicationPayload(JSON.parse(communicationCanonicalJson({ type: "message", ts: message.ts, user: message.user,
    text: message.text, thread_ts: message.thread_ts ?? null, subtype: message.subtype ?? null, blocks: message.blocks ?? null })) as Record<string, unknown>);
}
async function currentSlackAuthority(target: MessageTarget, db: NativeDb) {
  const installation = await db.communicationInstallation.findFirst({ where: { id: target.installationId,
    workspaceId: target.workspaceId, provider: "SLACK", status: "ACTIVE", disconnectedAt: null } });
  const channel = await db.communicationChannel.findFirst({ where: { workspaceId: target.workspaceId, installationId: target.installationId,
    provider: "SLACK", externalChannelId: target.channelId, kind: "PUBLIC", isIngestEnabled: true, isArchived: false } });
  invariant(installation?.botTokenEnc && installation.botUserId && installation.externalWorkspaceId && channel
    && record(installation.settings)?.publicIngestionEnabled !== false,
  409, "SOURCE_RESTRICTED", "The current admitted Slack source is unavailable.");
  const binding = await db.workspaceIntegrationBinding.findUnique({ where: { workspaceId_provider: { workspaceId: target.workspaceId, provider: "SLACK" } } });
  invariant(!binding || binding.externalWorkspaceId === installation.externalWorkspaceId,
    409, "SOURCE_RESTRICTED", "The Slack workspace routing binding changed.");
  return { installation, channel, installationGrantHash: communicationInstallationGrantHash(installation),
    channelGrantHash: hash({ id: channel.id, workspaceId: channel.workspaceId, installationId: channel.installationId,
      externalChannelId: channel.externalChannelId, provider: channel.provider, kind: channel.kind,
      isIngestEnabled: channel.isIngestEnabled, isArchived: channel.isArchived }) };
}
/** Actual authenticated transport; no caller-supplied response/verification boolean can mint this receipt. */
export async function captureSlackNativeMessageFetch(params: MessageTarget, db: NativeDb = prisma): Promise<SlackNativeFetchReceipt> {
  assertOutsideArtifactNativeCommitPhase();
  invariant(db === prisma, 409, "SOURCE_CHANGED", "Slack transport cannot run inside a supplied transaction.");
  const target = freezeCommunicationPayload(structuredClone(params));
  invariant(/^\d+\.\d+$/.test(target.messageTs), 400, "INVALID_INPUT", "An exact Slack message timestamp is required.");
  const before = await currentSlackAuthority(target, db);
  const client = new WebClient(decryptSecret(before.installation.botTokenEnc!));
  let auth, info, response;
  let providerPrincipalId = "";
  const request = target.threadTs && target.threadTs !== target.messageTs
    ? { toolName: "conversations.replies", channel: target.channelId, ts: target.threadTs, oldest: target.messageTs, latest: target.messageTs, inclusive: true, limit: 2 }
    : { toolName: "conversations.history", channel: target.channelId, oldest: target.messageTs, latest: target.messageTs, inclusive: true, limit: 2 };
  try {
    auth = await client.auth.test();
    invariant(auth?.ok === true && auth.team_id === before.installation.externalWorkspaceId && auth.user_id === before.installation.botUserId,
      409, "SOURCE_RESTRICTED", "The Slack provider principal changed.");
    providerPrincipalId = auth.user_id!;
    info = await client.conversations.info({ channel: target.channelId });
    const remote = record(info.channel);
    invariant(info?.ok === true && remote?.id === target.channelId && remote.is_private === false
      && remote.is_archived === false && remote.is_member === true, 409, "SOURCE_RESTRICTED", "The Slack channel is no longer public and available.");
    const { toolName, ...args } = request;
    response = toolName === "conversations.replies" ? await client.conversations.replies(args as Parameters<WebClient["conversations"]["replies"]>[0])
      : await client.conversations.history(args);
    response = JSON.parse(communicationCanonicalJson(response)) as typeof response;
  } catch { throw Object.assign(new Error("The current Slack message could not be verified."), { code: "SOURCE_RESTRICTED" }); }
  invariant(response?.ok === true && Array.isArray(response.messages) && !response.has_more,
    409, "SOURCE_RESTRICTED", "The exact Slack message response is incomplete.");
  const matches = response.messages.filter(message => record(message)?.ts === target.messageTs);
  invariant(matches.length === 1, 409, "SOURCE_RESTRICTED", "The original Slack message is unavailable.");
  const projected = slackNativeMessageProjection(matches[0], target);
  invariant(projected.user !== before.installation.botUserId, 409, "SOURCE_RESTRICTED", "Generated Slack messages require their own complete receipt.");
  const after = await currentSlackAuthority(target, db);
  invariant(after.installationGrantHash === before.installationGrantHash && after.channelGrantHash === before.channelGrantHash,
    409, "SOURCE_CHANGED", "Slack source permissions changed during the provider read.");
  const receipt = freezeCommunicationPayload({ target, payload: JSON.parse(communicationCanonicalJson(response)) as Record<string, unknown>, projected,
    installationGrantHash: before.installationGrantHash, channelGrantHash: before.channelGrantHash,
    providerPrincipalId, request, capturedAtMs: Date.now() });
  fetched.add(receipt);
  return receipt;
}
function assertSlackNativeFetchReceipt(receipt: SlackNativeFetchReceipt) {
  invariant(fetched.has(receipt), 409, "UNKNOWN_LINEAGE", "An actual authenticated Slack fetch is required.");
}
/** Internal DB-only atomic writer scope. Normal reads never use this preflight capability. */
export async function withSlackNativeCommitReceipt<T>(actor: AppActor, workspaceId: string, inputId: string,
  tx: Prisma.TransactionClient, receipt: SlackNativeFetchReceipt, work: () => Promise<T>): Promise<T> {
  assertSlackNativeFetchReceipt(receipt);
  invariant(receipt.target.workspaceId === workspaceId && tx !== prisma && !consumedFetches.has(receipt),
    409, "SOURCE_CHANGED", "The native write requires its exact unused transaction fetch.");
  consumedFetches.add(receipt);
  const scope = { actor, actorHash: hash(actor), workspaceId, tx,
    receipts: new Map([[inputId, receipt]]), active: true };
  return withArtifactNativeCommitPhase(() => commitReceipt.run(scope, async () => {
    try { return await work(); }
    finally { scope.active = false; }
  }));
}
/** Preparatory local admission only. It does not prove that Slack still serves the bytes. */
export async function isCommunicationMessageNativeInputLocallyCurrent(actor: AppActor, workspaceId: string,
  input: CommunicationMessageNativeInputRecord, db: NativeDb = prisma): Promise<boolean> {
  try {
    if (input.provider !== "SLACK" || input.mode !== "AUTHENTICATED_FETCH" || input.workspaceId !== workspaceId
      || input.epochProofVersion !== 1 || !(input.expiresRawAt instanceof Date)
      || input.expiresRawAt.getTime() <= Date.now()) return false;
    await requireWorkspaceMembership({ actor, workspaceId, tx: db as Prisma.TransactionClient });
    if (!await isArtifactPermissionEpochProofCurrent(workspaceId, input.permissionEpochsJson, db)) return false;
    const message = await db.communicationMessage.findFirst({ where: { id: input.communicationMessageId, workspaceId,
      installationId: input.installationId, externalChannelId: input.externalChannelId,
      externalMessageId: input.externalMessageId } });
    if (!message || message.provider !== "SLACK" || message.isBot || message.isHidden || message.isDeleted || message.textRedactedAt
      || !message.expiresRawAt || message.expiresRawAt.getTime() <= Date.now()) return false;
    const projected = record(input.projectedContentJson);
    if (!projected || hash(projected) !== input.projectionHash || projected.user !== input.externalUserId
      || (projected.thread_ts ?? null) !== input.threadExternalId || hash(message.raw) !== input.projectionHash
      || message.text !== projected.text || message.externalUserId !== projected.user
      || message.threadExternalId !== input.threadExternalId || message.permalink !== null
      || message.messageTs?.getTime() !== Math.trunc(Number(input.externalMessageId) * 1000)
      || message.receivedAt.getTime() !== message.messageTs.getTime()) return false;
    const { lineageContentFingerprint } = await import("./source-lineage");
    const request = record(input.requestJson);
    if (!request || request.messageContentFingerprint !== lineageContentFingerprint("CommunicationMessage", message)) return false;
    const payload = JSON.parse(decryptSecret(input.encryptedPayloadJson)) as unknown;
    const preservedMessages = record(payload)?.messages;
    if (!Array.isArray(preservedMessages)) return false;
    const originals = preservedMessages.filter(item => record(item)?.ts === input.externalMessageId);
    if (originals.length !== 1 || hash(slackNativeMessageProjection(originals[0], { workspaceId,
      installationId: input.installationId, channelId: input.externalChannelId, messageTs: input.externalMessageId,
      threadTs: input.threadExternalId })) !== input.projectionHash) return false;
    const stored = await db.communicationMessageNativeInput.findFirst({ where: { id: input.id, workspaceId } });
    const authority = await currentSlackAuthority({ workspaceId, installationId: input.installationId,
      channelId: input.externalChannelId, messageTs: input.externalMessageId, threadTs: input.threadExternalId }, db);
    return !!stored && communicationCanonicalJson(stored) === communicationCanonicalJson(input)
      && authority.installation.externalWorkspaceId === input.externalWorkspaceId
      && authority.installation.appId === input.appId
      && authority.installation.botUserId === input.providerPrincipalId
      && authority.installationGrantHash === input.installationGrantHash
      && authority.channelGrantHash === input.channelGrantHash;
  } catch { return false; }
}
export async function isCommunicationIngressInputCurrent(actor: AppActor, workspaceId: string,
  input: CommunicationIngressInputRecord, db: NativeDb = prisma): Promise<boolean> {
  try {
    if (input.workspaceId !== workspaceId || input.provider !== "SLACK" || input.epochProofVersion !== 1
      || !(input.expiresRawAt instanceof Date) || input.expiresRawAt.getTime() <= Date.now()) return false;
    await requireWorkspaceMembership({ actor, workspaceId, tx: db as Prisma.TransactionClient });
    if (!await isArtifactPermissionEpochProofCurrent(workspaceId, input.permissionEpochsJson, db)) return false;
    const installation = await db.communicationInstallation.findFirst({ where: { id: input.installationId,
      workspaceId, provider: "SLACK", status: "ACTIVE", disconnectedAt: null } });
    if (!installation || !input.appId || input.externalWorkspaceId !== installation.externalWorkspaceId || input.appId !== installation.appId
      || input.installationGrantHash !== communicationInstallationGrantHash(installation)) return false;
    const binding = await db.workspaceIntegrationBinding.findUnique({ where: { workspaceId_provider: {workspaceId,provider:"SLACK"} } });
    if (binding && binding.externalWorkspaceId !== input.externalWorkspaceId) return false;
    const raw = decryptSecret(input.encryptedRawBody);
    if (communicationNativeHash(raw) !== input.bodyHash || !isStoredSlackIngressSignatureCurrent(input, raw)) return false;
    const form = new URLSearchParams(raw);
    const payload = record(raw.trimStart().startsWith("{") ? JSON.parse(raw) : form.has("payload") ? JSON.parse(form.get("payload")!) : Object.fromEntries(form));
    return !!payload && (payload.team_id ?? record(payload.team)?.id) === input.externalWorkspaceId
      && payload.api_app_id === input.appId && input.expiresRawAt.getTime() > Date.now();
  } catch { return false; }
}
export async function isCommunicationMessageNativeInputCurrent(actor: AppActor, workspaceId: string,
  input: CommunicationMessageNativeInputRecord, db: NativeDb = prisma): Promise<boolean> {
  try {
    if (db === prisma && isArtifactNativeCommitPhase()) return false;
    if (input.provider !== "SLACK" || input.mode !== "AUTHENTICATED_FETCH" || input.workspaceId !== workspaceId || input.epochProofVersion !== 1
      || !(input.expiresRawAt instanceof Date) || input.expiresRawAt.getTime() <= Date.now()) return false;
    await requireWorkspaceMembership({ actor, workspaceId, tx: db as Prisma.TransactionClient });
    if (!await isArtifactPermissionEpochProofCurrent(workspaceId, input.permissionEpochsJson, db)) return false;
    const message = await db.communicationMessage.findFirst({ where: { id: input.communicationMessageId, workspaceId,
      installationId: input.installationId, externalChannelId: input.externalChannelId, externalMessageId: input.externalMessageId } });
    if (!message || message.provider !== "SLACK" || message.isBot || message.isHidden || message.isDeleted || message.textRedactedAt
      || !message.expiresRawAt || message.expiresRawAt.getTime() <= Date.now()) return false;
    const projected = record(input.projectedContentJson);
    if (!projected || hash(projected) !== input.projectionHash || projected.user !== input.externalUserId
      || (projected.thread_ts ?? null) !== input.threadExternalId || hash(message.raw) !== input.projectionHash
      || message.text !== projected.text || message.externalUserId !== projected.user || message.threadExternalId !== input.threadExternalId
      || message.permalink !== null || message.messageTs?.getTime() !== Math.trunc(Number(input.externalMessageId) * 1000)
      || message.receivedAt.getTime() !== message.messageTs.getTime()) return false;
    const { lineageContentFingerprint } = await import("./source-lineage");
    const storedRequest = record(input.requestJson);
    if (!storedRequest || storedRequest.messageContentFingerprint !== lineageContentFingerprint("CommunicationMessage", message)) return false;
    const fetchRequest = Object.fromEntries(Object.entries(storedRequest).filter(([key]) => key !== "messageContentFingerprint"));
    // Retention and local retirement are checked before decrypting preserved native payload bytes.
    const payload = JSON.parse(decryptSecret(input.encryptedPayloadJson)) as unknown;
    const preservedMessages = record(payload)?.messages;
    if (!Array.isArray(preservedMessages)) return false;
    const original = preservedMessages.filter(item => record(item)?.ts === input.externalMessageId);
    if (original.length !== 1 || hash(slackNativeMessageProjection(original[0], { workspaceId,
      installationId: input.installationId, channelId: input.externalChannelId, messageTs: input.externalMessageId,
      threadTs: input.threadExternalId })) !== input.projectionHash) return false;
    const capability = commitReceipt.getStore();
    const admittedCommit = capability?.active && db !== prisma && capability.actor === actor && capability.workspaceId === workspaceId
      && capability.actorHash === hash(actor) && capability.receipts.has(input.id) && capability.tx === db;
    if ((capability && !admittedCommit) || (db !== prisma && !admittedCommit)) return false;
    if (admittedCommit) {
      const storedInput = await db.communicationMessageNativeInput.findFirst({ where: {id:input.id,workspaceId} });
      if (!storedInput || communicationCanonicalJson(storedInput) !== communicationCanonicalJson(input)) return false;
      const expected = capability.expected?.get(input.id);
      if (capability.expected && (!expected || hash(storedInput) !== expected.storedHash
        || lineageContentFingerprint("CommunicationMessageNativeInput", storedInput) !== expected.fingerprint)) return false;
    }
    const current = admittedCommit ? capability.receipts.get(input.id)!
      : await captureSlackNativeMessageFetch({ workspaceId, installationId: input.installationId,
        channelId: input.externalChannelId, messageTs: input.externalMessageId, threadTs: input.threadExternalId }, db);
    if (current.target.installationId !== input.installationId || current.target.channelId !== input.externalChannelId
      || current.target.messageTs !== input.externalMessageId || hash(current.payload) !== hash(payload)
      || hash(current.request) !== hash(fetchRequest)) return false;
    const authority = await currentSlackAuthority(current.target, db);
    return current.providerPrincipalId === input.providerPrincipalId && current.installationGrantHash === input.installationGrantHash
      && current.channelGrantHash === input.channelGrantHash && hash(current.projected) === input.projectionHash
      && authority.installation.externalWorkspaceId === input.externalWorkspaceId && authority.installation.appId === input.appId
      && authority.installationGrantHash === input.installationGrantHash && authority.channelGrantHash === input.channelGrantHash
      && input.expiresRawAt.getTime() > Date.now() && message.expiresRawAt.getTime() > Date.now()
      && await isArtifactPermissionEpochProofCurrent(workspaceId, input.permissionEpochsJson, db);
  } catch { return false; }
}

declare const slackCommitBrand: unique symbol;
export type SlackNativeCommitPreflight = { readonly [slackCommitBrand]: true };
declare const slackClaimBrand: unique symbol;
export type SlackNativeCommitClaim = { readonly [slackClaimBrand]: true };
type SlackCommitState = { actor: AppActor; actorHash: string; workspaceId: string;
  submittedRoots: LineageRoot[]; roots: LineageRoot[];
  inputs: Map<string, { fingerprint: string; storedHash: string; receipt: SlackNativeFetchReceipt }> };
const slackPreflights = new WeakMap<object, SlackCommitState>();
const slackClaims = new WeakMap<object, SlackCommitState & { tx: Prisma.TransactionClient; rowLocks?: Promise<void> }>();
/** Cancellation confers no authority; an attempted owner commit burns every peer plan. */
export function discardSlackNativeCommitPreflight(token: SlackNativeCommitPreflight,
  claim?: SlackNativeCommitClaim) {
  slackPreflights.delete(token);
  if (claim) slackClaims.delete(claim);
}
const MAX_NATIVE_INPUTS = 128;
function freezeRootProof<T>(value: T): T {
  if (value && typeof value === "object") {
    invariant(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype,
      409, "SOURCE_CHANGED", "Commit proof must contain only immutable JSON values.");
    for (const key of Object.keys(value)) freezeRootProof((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** Fresh public-channel replays are bound to every stored native leaf, before a writer opens its transaction. */
export async function prepareSlackNativeCommitPreflight(actor: AppActor, workspaceId: string,
  submitted: readonly LineageRoot[]): Promise<SlackNativeCommitPreflight> {
  assertOutsideArtifactNativeCommitPhase();
  sealArtifactInputActor(actor);
  const actorHash = hash(actor);
  const submittedRoots = freezeRootProof(structuredClone([...submitted]));
  const roots = structuredClone(submittedRoots);
  invariant(roots.length > 0 && roots.length <= 10000, 409, "UNKNOWN_LINEAGE", "Slack commit roots are unbounded.");
  const lineage = await import("./source-lineage");
  const dependencies = await lineage.inspectStoredArtifactInputDependencies(prisma, workspaceId, roots, { maxNodes: 10000 });
  invariant(dependencies.complete && dependencies.roots.length <= 10000, 409, "UNKNOWN_LINEAGE", "Slack ancestry is incomplete.");
  await lineage.assertArtifactInputClosureLocallyAdmissible(actor, workspaceId, roots);
  const native = dependencies.roots.filter(root => root.kind === "CommunicationMessageNativeInput");
  invariant(native.length > 0 && native.length <= MAX_NATIVE_INPUTS,
    409, "UNKNOWN_LINEAGE", "Slack commit needs bounded native message inputs.");
  let enclosingEpochs: Awaited<ReturnType<typeof savedEnclosingNativeEpochs>> | undefined;
  const inputs: SlackCommitState["inputs"] = new Map();
  for (const root of native) {
    const direct = roots.find(item => item.kind === root.kind && item.id === root.id && item.fingerprint === root.fingerprint);
    let original = parsePermissionEpochProof(direct?.permissionEpochs);
    if (!original) for (const snapshotRoot of dependencies.roots.filter(item => item.kind === "ArtifactInputSnapshot")) {
      const snapshot = await prisma.artifactInputSnapshot.findFirst({ where: { id: snapshotRoot.id, workspaceId },
        select: { sourceKind: true, sourceId: true, sourceFingerprint: true, epochProofVersion: true, permissionEpochsJson: true } });
      if (snapshot?.sourceKind === root.kind && snapshot.sourceId === root.id && snapshot.sourceFingerprint === root.fingerprint
        && snapshot.epochProofVersion === 1) { original = parsePermissionEpochProof(snapshot.permissionEpochsJson); break; }
    }
    if (!original) {
      enclosingEpochs ??= await savedEnclosingNativeEpochs(workspaceId, submittedRoots, "CommunicationMessageNativeInput");
      original = enclosingEpochs.get(savedNativeVectorKey(root.kind, root.id, root.fingerprint)) ?? null;
    }
    invariant(original && original.entries.some(entry => entry.kind === root.kind && entry.id === root.id)
      && await isArtifactPermissionEpochProofCurrent(workspaceId, original),
    409, "SOURCE_CHANGED", "Slack input lost its originally consumed permission revision.");
    if (!direct?.permissionEpochs) roots.push({ ...root, permissionEpochs: original });
    const input = await prisma.communicationMessageNativeInput.findFirst({ where: { id: root.id, workspaceId } });
    invariant(input && lineage.lineageContentFingerprint("CommunicationMessageNativeInput", input) === root.fingerprint
      && await isCommunicationMessageNativeInputLocallyCurrent(actor, workspaceId, input),
    409, "SOURCE_CHANGED", "Slack input changed before its live replay.");
    const receipt = await captureSlackNativeMessageFetch({ workspaceId, installationId: input.installationId,
      channelId: input.externalChannelId, messageTs: input.externalMessageId, threadTs: input.threadExternalId });
    const payload = JSON.parse(decryptSecret(input.encryptedPayloadJson));
    const request = record(input.requestJson);
    const { messageContentFingerprint: _messageFingerprint, ...fetchRequest } = request ?? {};
    invariant(hash(receipt.payload) === hash(payload) && hash(receipt.projected) === input.projectionHash
      && hash(receipt.request) === hash(fetchRequest) && receipt.providerPrincipalId === input.providerPrincipalId
      && receipt.installationGrantHash === input.installationGrantHash && receipt.channelGrantHash === input.channelGrantHash,
    409, "SOURCE_CHANGED", "Slack response or current public-channel grant changed.");
    inputs.set(input.id, { fingerprint: root.fingerprint, storedHash: hash(input), receipt });
  }
  invariant(roots.length <= 10000 && await lineage.isArtifactInputProofReadable(actor, workspaceId, roots),
    409, "SOURCE_CHANGED", "Slack complete source proof changed before commit.");
  invariant(hash(actor) === actorHash, 409, "SOURCE_CHANGED", "Slack principal changed during replay.");
  const token = Object.freeze({}) as SlackNativeCommitPreflight;
  slackPreflights.set(token, { actor, actorHash, workspaceId, submittedRoots,
    roots: freezeRootProof(roots), inputs });
  return token;
}

/** Claim is inert. Only the safe executor below may activate its receipts. */
export function claimSlackNativeCommitPreflight(actor: AppActor, workspaceId: string, tx: Prisma.TransactionClient,
  token: SlackNativeCommitPreflight, submitted: readonly LineageRoot[]): SlackNativeCommitClaim {
  const state = slackPreflights.get(token);
  invariant(state && state.actor === actor && state.actorHash === hash(actor) && state.workspaceId === workspaceId
    && tx !== prisma && !commitReceipt.getStore() && isDeepStrictEqual(state.submittedRoots, submitted),
  409, "SOURCE_CHANGED", "Slack commit capability is unavailable.");
  slackPreflights.delete(token);
  const claim = Object.freeze({}) as SlackNativeCommitClaim;
  slackClaims.set(claim, { ...state, tx });
  return claim;
}

export function inspectSlackNativeCommitClaim(claim: SlackNativeCommitClaim) {
  const state = slackClaims.get(claim);
  invariant(state, 409, "SOURCE_CHANGED", "Slack commit claim is unavailable.");
  return { actor: state.actor, workspaceId: state.workspaceId, tx: state.tx,
    roots: freezeRootProof(structuredClone(state.roots)),
    inputIds: [...state.inputs.keys()] };
}

/** Native and governing row locks precede every full-proof epoch read. */
async function lockSlackNativeInputRows(tx: Prisma.TransactionClient, workspaceId: string,
  inputIds: readonly string[]) {
  for (const id of [...new Set(inputIds)].sort()) {
    if (!sourceAuthorityRowAlreadyLocked(tx, "CommunicationMessageNativeInput", id))
      await tx.$queryRaw`SELECT "id" FROM "CommunicationMessageNativeInput" WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
  }
}

export async function lockSlackNativeGoverningRows(tx: Prisma.TransactionClient, workspaceId: string,
  inputIds: readonly string[], actor: AppActor) {
  const rows = [] as Array<{ installationId: string; channelId: string; messageId: string }>;
  for (const id of [...new Set(inputIds)].sort()) {
    const input = await tx.communicationMessageNativeInput.findFirst({ where: { id, workspaceId } });
    invariant(input, 409, "SOURCE_CHANGED", "Slack native input changed before publication.");
    rows.push({ installationId: input.installationId, channelId: input.externalChannelId,
      messageId: input.communicationMessageId });
  }
  for (const id of [...new Set(rows.map(row => row.installationId))].sort())
    if (!sourceAuthorityRowAlreadyLocked(tx, "CommunicationInstallation", id))
      await tx.$queryRaw`SELECT "id" FROM "CommunicationInstallation" WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
  for (const key of [...new Set(rows.map(row => JSON.stringify([row.installationId, row.channelId])))].sort()) {
    const [installationId, channelId] = JSON.parse(key) as [string, string];
    await lockSourceAuthorityPredicate(tx, "CommunicationChannel", { workspaceId, installationId, externalChannelId: channelId },
      () => tx.$queryRaw`SELECT "id" FROM "CommunicationChannel" WHERE "installationId" = ${installationId} AND "externalChannelId" = ${channelId} AND "workspaceId" = ${workspaceId} FOR SHARE`);
  }
  for (const id of [...new Set(rows.map(row => row.messageId))].sort())
    if (!sourceAuthorityRowAlreadyLocked(tx, "CommunicationMessage", id))
      await tx.$queryRaw`SELECT "id" FROM "CommunicationMessage" WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
  await lockSourceAuthorityPredicate(tx, "WorkspaceIntegrationBinding", { workspaceId, provider: "SLACK" },
    () => tx.$queryRaw`SELECT "workspaceId" FROM "WorkspaceIntegrationBinding" WHERE "workspaceId" = ${workspaceId} AND "provider" = 'SLACK' FOR SHARE`);
  if (actor.kind === "user") {
    await lockSourceAuthorityPredicate(tx, "Member", { workspaceId, userId: actor.user.id },
      () => tx.$queryRaw`SELECT "id" FROM "Member" WHERE "workspaceId" = ${workspaceId} AND "userId" = ${actor.user.id} FOR SHARE`);
    if (!sourceAuthorityRowAlreadyLocked(tx, "User", actor.user.id))
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.user.id} FOR SHARE`;
  } else {
    if (actor.credentialId && !sourceAuthorityRowAlreadyLocked(tx, "AgentCredential", actor.credentialId))
      await tx.$queryRaw`SELECT "id" FROM "AgentCredential" WHERE "id" = ${actor.credentialId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    if (actor.agentIdentityId && !sourceAuthorityRowAlreadyLocked(tx, "AgentIdentity", actor.agentIdentityId))
      await tx.$queryRaw`SELECT "id" FROM "AgentIdentity" WHERE "id" = ${actor.agentIdentityId} AND "workspaceId" = ${workspaceId} FOR SHARE`;
  }
  const origin = getMcpOrigin();
  if (origin?.workspaceId === workspaceId && origin.kind === "oauth") {
    if (!sourceAuthorityRowAlreadyLocked(tx, "McpOAuthAccessToken", origin.id))
      await tx.$queryRaw`SELECT "id" FROM "McpOAuthAccessToken" WHERE "id" = ${origin.id} AND "workspaceId" = ${workspaceId} FOR SHARE`;
    const token = await tx.mcpOAuthAccessToken.findFirst({ where: { id: origin.id, workspaceId }, select: { clientId: true } });
    invariant(token, 409, "SOURCE_CHANGED", "The serving OAuth grant changed.");
    if (!sourceAuthorityRowAlreadyLocked(tx, "McpOAuthClient", token.clientId))
      await tx.$queryRaw`SELECT "id" FROM "McpOAuthClient" WHERE "id" = ${token.clientId} FOR SHARE`;
  }
}

async function lockSlackNativeCommitRows(tx: Prisma.TransactionClient, workspaceId: string,
  inputIds: readonly string[], actor: AppActor) {
  await lockSlackNativeInputRows(tx, workspaceId, inputIds);
  await lockSlackNativeGoverningRows(tx, workspaceId, inputIds, actor);
}

/** Reserve the exact opaque claim's physical rows without activating source
 * authority. Mixed executors use this before their source-row reservation. */
export async function lockSlackNativeCommitClaimRows(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, claim: SlackNativeCommitClaim): Promise<void> {
  const state = slackClaims.get(claim);
  invariant(state && state.actor === actor && state.actorHash === hash(actor)
    && state.workspaceId === workspaceId && state.tx === tx && !commitReceipt.getStore(),
  409, "SOURCE_CHANGED", "Slack commit claim is unavailable.");
  await (state.rowLocks ??= lockSlackNativeCommitRows(tx, workspaceId, [...state.inputs.keys()], actor));
}

/** Safe even when called directly: all Slack locks and the entire proof are unavoidable. */
export async function withClaimedSlackNativeCommitPreflight<T>(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, claim: SlackNativeCommitClaim, work: () => Promise<T>,
  beforeSourceEpochs?: () => Promise<void>): Promise<T> {
  const state = slackClaims.get(claim);
  invariant(state && state.actor === actor && state.actorHash === hash(actor)
    && state.workspaceId === workspaceId && state.tx === tx && !commitReceipt.getStore(),
  409, "SOURCE_CHANGED", "Slack commit claim is unavailable.");
  slackClaims.delete(claim);
  await (state.rowLocks ??= lockSlackNativeCommitRows(tx, workspaceId, [...state.inputs.keys()], actor));
  if (beforeSourceEpochs) await withArtifactNativeCommitPhase(beforeSourceEpochs);
  const receipts = new Map([...state.inputs].map(([id, value]) => [id, value.receipt]));
  const scope = { actor, actorHash: state.actorHash, workspaceId, tx, receipts,
    expected: new Map([...state.inputs].map(([id, value]) => [id,
      { fingerprint: value.fingerprint, storedHash: value.storedHash }])), active: true };
  const lineage = await import("./source-lineage");
  return withArtifactNativeCommitPhase(() => commitReceipt.run(scope, async () => {
    try {
      invariant(await lineage.isArtifactInputProofReadable(actor, workspaceId, state.roots, tx),
        409, "SOURCE_CHANGED", "Slack complete proof changed before publication.");
      const result = await work();
      invariant(await lineage.isArtifactInputProofReadable(actor, workspaceId, state.roots, tx),
        409, "SOURCE_CHANGED", "Slack complete proof changed during publication.");
      return result;
    } finally { scope.active = false; }
  }));
}

export async function withSlackNativeCommitPreflight<T>(actor: AppActor, workspaceId: string,
  tx: Prisma.TransactionClient, submitted: readonly LineageRoot[], token: SlackNativeCommitPreflight,
  work: () => Promise<T>, beforeSourceEpochs?: () => Promise<void>): Promise<T> {
  const claim = claimSlackNativeCommitPreflight(actor, workspaceId, tx, token, submitted);
  return withClaimedSlackNativeCommitPreflight(actor, workspaceId, tx, claim, work, beforeSourceEpochs);
}
