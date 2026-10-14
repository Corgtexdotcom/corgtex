import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
const f = vi.hoisted(() => ({ db: { workspaceIntegrationBinding: {findUnique:vi.fn(async()=>null)}, communicationMessageNativeInput:{findFirst:vi.fn()}, communicationInstallation: { findFirst: vi.fn() }, communicationChannel: { findFirst: vi.fn() },
  communicationMessage: { findFirst: vi.fn() } }, client: { auth: { test: vi.fn() }, conversations: { info: vi.fn(), history: vi.fn(), replies: vi.fn() } },
  epochs: vi.fn(), membership: vi.fn(), decrypt: vi.fn((text: string) => text.replace(/^enc:/, "")) }));
vi.mock("@corgtex/shared", () => ({ prisma: f.db, decryptSecret: f.decrypt, beginAuthorizationContext: vi.fn() }));
vi.mock("./source-lineage",()=>({lineageContentFingerprint:(_kind:string,row:unknown)=>JSON.stringify(row)}));
vi.mock("./auth", () => ({ requireWorkspaceMembership: f.membership }));
vi.mock("./source-permission-epochs", () => ({ isArtifactPermissionEpochProofCurrent: f.epochs }));
vi.mock("./slack-workspace-bindings", () => ({ getSlackWorkspaceBinding: (workspaceId?: string) => ({ workspaceId, source: "workspace",
  teamId: "T1", appId: "A1", signingSecret: "synthetic-secret" }) }));
vi.mock("@slack/web-api", () => ({ WebClient: class { auth = f.client.auth; conversations = f.client.conversations; } }));
import { captureSlackSignedIngress, assertSlackSignedIngress, communicationCanonicalJson, communicationNativeHash } from "./communication-native-ingress";
import { captureSlackNativeMessageFetch, communicationInstallationGrantHash, isCommunicationMessageNativeInputCurrent,
  withSlackNativeCommitReceipt, type CommunicationMessageNativeInputRecord, type SlackNativeFetchReceipt } from "./communication-native-authority";

const actor: AppActor = { kind: "user", user: { id: "user-a", email: "a@example.test", displayName: "Synthetic" } };
const target = { workspaceId: "ws-a", installationId: "installation-a", channelId: "C1", messageTs: "1700000000.000001" };
let installation: any, channel: any, message: any;
let lastReceipt: SlackNativeFetchReceipt;
beforeEach(() => {
  vi.clearAllMocks();
  installation = { id: target.installationId, workspaceId: target.workspaceId, provider: "SLACK", externalWorkspaceId: "T1", appId: "A1",
    botUserId: "U_BOT", botTokenEnc: "enc:token", status: "ACTIVE", disconnectedAt: null, scopes: ["channels:read", "channels:history"], optionalScopes: [], settings: {} };
  channel = { id: "channel-a", installationId: target.installationId, workspaceId: target.workspaceId, provider: "SLACK",
    externalChannelId: "C1", kind: "PUBLIC", isIngestEnabled: true, isArchived: false };
  message = { type: "message", ts: target.messageTs, user: "U_A", text: "Synthetic source", blocks: [{ type: "section", text: { type: "plain_text", text: "Synthetic source" } }] };
  f.db.communicationInstallation.findFirst.mockImplementation(async () => installation.status === "ACTIVE" ? installation : null);
  f.db.communicationChannel.findFirst.mockImplementation(async () => channel.kind === "PUBLIC" && channel.isIngestEnabled && !channel.isArchived ? channel : null);
  f.client.auth.test.mockResolvedValue({ ok: true, team_id: "T1", user_id: "U_BOT" });
  f.client.conversations.info.mockResolvedValue({ ok: true, channel: { id: "C1", is_private: false, is_archived: false, is_member: true } });
  f.client.conversations.history.mockImplementation(async () => ({ ok: true, messages: [message], has_more: false }));
  f.epochs.mockResolvedValue(true); f.membership.mockResolvedValue({ id: "member-a" });
});
async function nativeInput(): Promise<CommunicationMessageNativeInputRecord> {
  const receipt = await captureSlackNativeMessageFetch(target);
  lastReceipt = receipt;
  const expiresRawAt = new Date(Date.now() + 60_000);
  const committed = { id: "message-a", workspaceId: "ws-a", installationId: target.installationId,
    provider:"SLACK",permalink:null,messageTs:new Date(Number(target.messageTs)*1000),receivedAt:new Date(Number(target.messageTs)*1000), externalChannelId: "C1", externalMessageId: target.messageTs, externalUserId: "U_A", threadExternalId: null,
    isBot: false, isHidden: false, isDeleted: false, textRedactedAt: null, text: message.text, raw: receipt.projected, expiresRawAt };
  f.db.communicationMessage.findFirst.mockResolvedValue(committed);
  return { id: "input-a", workspaceId: "ws-a", installationId: target.installationId, communicationMessageId: "message-a", provider: "SLACK",
    externalWorkspaceId: "T1", appId: "A1", providerPrincipalId: "U_BOT", externalChannelId: "C1", externalMessageId: target.messageTs,
    externalUserId: "U_A", threadExternalId: null, mode: "AUTHENTICATED_FETCH", ingressInputId: null, requestJson: {...receipt.request,messageContentFingerprint:JSON.stringify(committed)},
    encryptedPayloadJson: `enc:${communicationCanonicalJson(receipt.payload)}`, projectedContentJson: receipt.projected,
    projectionHash: communicationNativeHash(communicationCanonicalJson(receipt.projected)), installationGrantHash: communicationInstallationGrantHash(installation),
    channelGrantHash: receipt.channelGrantHash, permissionEpochsJson: {}, epochProofVersion: 1, expiresRawAt, fetchedAt: new Date() };
}
describe("actual Slack native authority", () => {
  it("requires signed HTTP bytes and rejects clones, altered payloads and tenant changes", () => {
    const raw = JSON.stringify({ team_id: "T1", api_app_id: "A1", event: { text: "Original" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${createHmac("sha256", "synthetic-secret").update(`v0:${timestamp}:${raw}`).digest("hex")}` };
    const proof = captureSlackSignedIngress(raw, headers, "ws-a");
    expect(() => assertSlackSignedIngress(proof, JSON.parse(raw), "ws-a")).not.toThrow();
    expect(() => assertSlackSignedIngress(structuredClone(proof), JSON.parse(raw), "ws-a")).toThrow();
    expect(() => assertSlackSignedIngress(proof, { ...proof.payload, event: { text: "Different" } }, "ws-a")).toThrow();
    expect(() => assertSlackSignedIngress(proof, proof.payload, "ws-b")).toThrow();
    expect(Object.isFrozen(proof.payload.event)).toBe(true);
    expect(() => captureSlackSignedIngress(`${raw} `, headers, "ws-a")).toThrow();
  });
  it("copies request params before await and freezes nested response content", async () => {
    const params = { ...target }; const original = f.client.auth.test.getMockImplementation();
    f.client.auth.test.mockImplementationOnce(async () => { params.channelId = "PRIVATE"; return original!(); });
    const receipt = await captureSlackNativeMessageFetch(params);
    expect(receipt.target.channelId).toBe("C1");
    expect(f.client.conversations.history).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1" }));
    expect(Object.isFrozen((receipt.projected.blocks as any[])[0].text)).toBe(true);
    expect(() => ((receipt.projected.blocks as any[])[0].text.text = "Mutated")).toThrow();
  });
  it("rechecks actual current provider content every read, with no successful read cache", async () => {
    const input = await nativeInput();
    expect(await isCommunicationMessageNativeInputCurrent(actor, "ws-a", input)).toBe(true);
    message = { ...message, text: "Edited" };
    expect(await isCommunicationMessageNativeInputCurrent(actor, "ws-a", input)).toBe(false);
    expect(f.client.conversations.history).toHaveBeenCalledTimes(3);
  });
  it("admits only exact same-actor stored-input transaction preflight and resumes real transport outside it", async () => {
    const input = await nativeInput(); const tx = { ...f.db } as any;
    f.db.communicationMessageNativeInput.findFirst.mockResolvedValue(input);
    f.client.auth.test.mockClear();
    await withSlackNativeCommitReceipt(actor, "ws-a", input.id, tx, lastReceipt, async () => {
      expect(await isCommunicationMessageNativeInputCurrent(actor, "ws-a", input, tx)).toBe(true);
      expect(await isCommunicationMessageNativeInputCurrent(structuredClone(actor), "ws-a", input, tx)).toBe(false);
      f.db.communicationMessageNativeInput.findFirst.mockResolvedValue({ ...input, projectionHash: "forged" });
      expect(await isCommunicationMessageNativeInputCurrent(actor, "ws-a", input, tx)).toBe(false);
    });
    expect(f.client.auth.test).not.toHaveBeenCalled();
    expect(await isCommunicationMessageNativeInputCurrent(actor, "ws-a", input)).toBe(true);
    expect(f.client.auth.test).toHaveBeenCalledOnce();
    await expect(withSlackNativeCommitReceipt(actor, "ws-a", input.id, tx, structuredClone(lastReceipt), async () => true)).rejects.toThrow();
  });
  it("does not recertify an old receipt after a private channel is restored", async () => {
    const input = await nativeInput();
    channel.kind = "PRIVATE"; f.epochs.mockResolvedValue(false);
    expect(await isCommunicationMessageNativeInputCurrent(actor, "ws-a", input)).toBe(false);
    channel.kind = "PUBLIC";
    expect(await isCommunicationMessageNativeInputCurrent(actor, "ws-a", input)).toBe(false);
  });
  it.each(["epoch", "expiry", "retired", "workspace"])("denies %s before decrypt or provider calls", async reason => {
    const input = await nativeInput(); f.decrypt.mockClear(); f.client.auth.test.mockClear();
    if (reason === "epoch") f.epochs.mockResolvedValue(false);
    if (reason === "expiry") input.expiresRawAt = new Date(Date.now() - 1);
    if (reason === "retired") f.db.communicationMessage.findFirst.mockResolvedValue({ ...f.db.communicationMessage.findFirst.mock.results.at(-1)?.value, isDeleted: true });
    expect(await isCommunicationMessageNativeInputCurrent(actor, reason === "workspace" ? "ws-b" : "ws-a", input)).toBe(false);
    expect(f.decrypt).not.toHaveBeenCalled(); expect(f.client.auth.test).not.toHaveBeenCalled();
  });
  it.each(["private", "principal", "provider-failure", "deleted", "files", "grant-race"])("withholds %s without stale fallback", async reason => {
    const input = await nativeInput();
    if (reason === "private") f.client.conversations.info.mockResolvedValue({ ok: true, channel: { id: "C1", is_private: true, is_archived: false, is_member: true } });
    if (reason === "principal") f.client.auth.test.mockResolvedValue({ ok: true, team_id: "T_OTHER", user_id: "U_BOT" });
    if (reason === "provider-failure") f.client.conversations.history.mockRejectedValue(new Error("sensitive provider error"));
    if (reason === "deleted") f.client.conversations.history.mockResolvedValue({ ok: true, messages: [], has_more: false });
    if (reason === "files") message = { ...message, files: [{ id: "private-file" }] };
    if (reason === "grant-race") f.client.conversations.history.mockImplementationOnce(async () => { installation.scopes = ["channels:read"]; return { ok: true, messages: [message] }; });
    expect(await isCommunicationMessageNativeInputCurrent(actor, "ws-a", input)).toBe(false);
  });
});
