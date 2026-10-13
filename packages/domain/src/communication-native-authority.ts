import { WebClient } from "@slack/web-api";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, CommunicationInstallation } from "@prisma/client";
import { decryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { communicationCanonicalJson, communicationNativeHash, freezeCommunicationPayload, isStoredSlackIngressSignatureCurrent } from "./communication-native-ingress";
import { isArtifactPermissionEpochProofCurrent } from "./source-permission-epochs";

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
const commitReceipt = new AsyncLocalStorage<{ actor: AppActor; actorHash: string; workspaceId: string; inputId: string;
  tx: Prisma.TransactionClient; receipt: SlackNativeFetchReceipt }>();
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
export function assertSlackNativeFetchReceipt(receipt: SlackNativeFetchReceipt) {
  invariant(fetched.has(receipt), 409, "UNKNOWN_LINEAGE", "An actual authenticated Slack fetch is required.");
}
/** Internal DB-only atomic writer scope. Normal reads never use this preflight capability. */
export async function withSlackNativeCommitReceipt<T>(actor: AppActor, workspaceId: string, inputId: string,
  tx: Prisma.TransactionClient, receipt: SlackNativeFetchReceipt, work: () => Promise<T>): Promise<T> {
  assertSlackNativeFetchReceipt(receipt);
  invariant(receipt.target.workspaceId === workspaceId && tx !== prisma, 409, "SOURCE_CHANGED", "The native write requires its exact transaction and live fetch.");
  return commitReceipt.run({ actor, actorHash: hash(actor), workspaceId, inputId, tx, receipt }, work);
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
    const admittedCommit = capability && db !== prisma && capability.actor === actor && capability.workspaceId === workspaceId
      && capability.actorHash === hash(actor) && capability.inputId === input.id && capability.tx === db;
    if (capability && !admittedCommit) return false;
    if (admittedCommit) {
      const storedInput = await db.communicationMessageNativeInput.findFirst({ where: {id:input.id,workspaceId} });
      if (!storedInput || communicationCanonicalJson(storedInput) !== communicationCanonicalJson(input)) return false;
    }
    const current = admittedCommit ? capability.receipt
      : await captureSlackNativeMessageFetch({ workspaceId, installationId: input.installationId,
        channelId: input.externalChannelId, messageTs: input.externalMessageId, threadTs: input.threadExternalId }, db);
    if (current.target.installationId !== input.installationId || current.target.channelId !== input.externalChannelId
      || current.target.messageTs !== input.externalMessageId || (admittedCommit && hash(current.payload) !== hash(payload))
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
