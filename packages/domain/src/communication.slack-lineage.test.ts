import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const f = vi.hoisted(() => {
  const installation: any = {}, channel: any = {}, member: any = {}, mapping: any = {};
  const messages = new Map<string, any>();
  const requests = new Map<string, any>();
  const rows = new Map<string, any>();
  const snapshots: any[] = [];
  const fingerprint = (row: any) => JSON.stringify(row);
  const publicScope = () => installation.status === "ACTIVE" && !installation.disconnectedAt
    && channel.kind === "PUBLIC" && channel.isIngestEnabled && !channel.isArchived
    && member.isActive && mapping.userId === member.userId && !mapping.isDeleted && !mapping.isBot;
  const capture = vi.fn(async (_actor, _workspaceId, inputs) => {
    if (!publicScope()) throw Object.assign(new Error("Restricted source"), { code: "SOURCE_RESTRICTED" });
    return inputs.map((input: any) => {
      const row = input.snapshot;
      if (row) rows.set(row.id, row);
      return { kind: input.kind, id: input.id, fingerprint: fingerprint(row ?? rows.get(input.id)) };
    });
  });
  const readable = vi.fn(async (_actor, _ws, roots) => publicScope()
    && roots.every((root: any) => rows.has(root.id) && fingerprint(rows.get(root.id)) === root.fingerprint));
  const db: any = {
    communicationMessageNativeInput: { create: vi.fn(async ({data}) => ({id:"native-input-1",...data})) },
    $queryRaw: vi.fn(async () => []),
    workspaceIntegrationBinding: { findUnique: vi.fn(async () => null) },
    communicationInstallation: {
      findFirst: vi.fn(async ({ where }) => installation.id === where.id && installation.workspaceId === where.workspaceId
        && installation.status === "ACTIVE" && !installation.disconnectedAt ? installation : null),
      findUnique: vi.fn(async () => installation),
    },
    communicationChannel: {
      findFirst: vi.fn(async ({ where }) => channel.workspaceId === where.workspaceId && channel.externalChannelId === where.externalChannelId
        && channel.installationId === where.installationId && channel.kind === "PUBLIC" && channel.isIngestEnabled && !channel.isArchived ? channel : null),
      updateMany: vi.fn(async ({ data }) => { Object.assign(channel, data); return { count: 1 }; }),
    },
    member: { findFirst: vi.fn(async ({ where }) => member.workspaceId === where.workspaceId && member.userId === where.userId && member.isActive ? member : null) },
    user: { findUnique: vi.fn(async () => member.user) },
    communicationExternalUser: {
      findFirst: vi.fn(async ({ where }) => mapping.workspaceId === where.workspaceId && mapping.installationId === where.installationId
        && mapping.userId === where.userId && (!where.externalUserId || mapping.externalUserId === where.externalUserId)
        && !mapping.isDeleted && !mapping.isBot ? mapping : null),
      findUnique: vi.fn(async () => mapping),
    },
    communicationMessage: {
      findFirst: vi.fn(async ({ where }) => messages.get(where.externalMessageId) ?? null),
      findMany: vi.fn(async ({ where }) => [...messages.values()].filter(row => where.externalMessageId.in.includes(row.externalMessageId))),
      upsert: vi.fn(async ({ where, update, create }) => {
        const ts = where.installationId_externalChannelId_externalMessageId.externalMessageId;
        const existing = messages.get(ts);
        const row = existing ? { ...existing, ...update } : { id: `message-${ts}`, textRedactedAt: null,
          receivedAt: new Date("2026-10-12T10:00:00Z"), createdAt: new Date("2026-10-12T10:00:00Z"), ...create };
        messages.set(ts, row); rows.set(row.id, row);
        return row;
      }),
    },
    agentRequestInput: {
      create: vi.fn(async ({ data }) => ({ id: "request-1", ...data })),
      upsert: vi.fn(async ({ where, create }) => {
        if (!requests.has(where.id)) requests.set(where.id, create);
        return requests.get(where.id);
      }),
    },
    workflowJob: { upsert: vi.fn(async ({ create }) => ({ id: "job-1", ...create })) },
  };
  const afterTransaction = vi.fn();
  db.$transaction = vi.fn(async (work: (tx: any) => Promise<any>) => {
    const original = new Map(messages);
    try {
      const result = await work({...db});
      afterTransaction();
      return result;
    } catch (error) {
      messages.clear(); for (const [key, value] of original) messages.set(key, value);
      throw error;
    }
  });
  const client = { conversations: {
    info: vi.fn(), replies: vi.fn(), history: vi.fn(),
  }, auth: { test: vi.fn() }, users: { info: vi.fn() } };
  const membership = vi.fn(async () => member);
  const snapshot = vi.fn(async (_actor, _ws, input) => {
    const preserved = structuredClone([...messages.values()].find(row => row.id === input.id));
    snapshots.push(preserved);
    return [{ kind: "ArtifactInputSnapshot", id: `snapshot-${input.id}`, fingerprint: fingerprint(preserved) }];
  });
  return { guardedSdk: false, http: vi.fn(), db, client, installation, channel, member, mapping, messages, requests, rows, snapshots, capture, readable, snapshot, membership, afterTransaction };
});

vi.mock("@corgtex/shared", () => ({
  prisma: f.db, env: { APP_URL: "https://synthetic.example.test", NODE_ENV: "test" },
  beginAuthorizationContext: () => undefined,
  decryptSecret: (value: string) => value.replace(/^enc:/, ""), encryptSecret: (value: string) => `enc:${value}`,
  randomOpaqueToken: () => "synthetic-token", toInputJson: (value: unknown) => value,
}));
vi.mock("@slack/web-api", async importOriginal => {
  const actual = await importOriginal<typeof import("@slack/web-api")>();
  return { ...actual, WebClient: vi.fn(function WebClient(token?: string, options?: import("@slack/web-api").WebClientOptions) {
    return f.guardedSdk ? new actual.WebClient(token, { ...options, adapter: f.http,
      retryConfig: { retries: 1, minTimeout: 0, maxTimeout: 0 },
      logger: { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => "error" } as never,
    }) : f.client;
  }) };
});
vi.mock("./auth", () => ({ requireWorkspaceMembership: f.membership }));
vi.mock("./source-permission-epochs", () => ({ artifactPermissionEpochIdentities: () => [{kind:"Workspace",id:"workspace-1"}], capturePermissionEpochs: vi.fn(async () => ({version:1})), isArtifactPermissionEpochProofCurrent: vi.fn(async()=>true) }));
vi.mock("./source-lineage", () => ({ recordArtifactInputLineage: vi.fn(), preserveUnknownArtifactInputSnapshot: async (_tx: any,_ws: any,input: any) => { f.snapshots.push(structuredClone([...f.messages.values()].find(row=>row.id===input.id))); }, captureArtifactInputProof: f.capture, captureArtifactInputSnapshotProof: f.snapshot, isArtifactInputProofReadable: f.readable, lineageContentFingerprint: (_kind: string, row: unknown) => JSON.stringify(row) }));
vi.mock("./actions", () => ({ createAction: vi.fn(), publishAction: vi.fn() }));
vi.mock("./tensions", () => ({ createTension: vi.fn(), publishTension: vi.fn() }));
vi.mock("./proposals", () => ({ createProposal: vi.fn(), submitProposal: vi.fn() }));
vi.mock("./brain", () => ({ ingestSource: vi.fn() }));
vi.mock("./meeting-action-review", () => ({
  assertMeetingReviewPublicPublication: vi.fn(), buildSlackMeetingActionReviewEditView: vi.fn(), confirmSlackMeetingActionReviewProposal: vi.fn(),
  dismissSlackMeetingActionReviewProposal: vi.fn(), isSlackMeetingActionReviewAction: vi.fn(), parseSlackMeetingActionReviewActionValue: vi.fn(),
  refreshSlackMeetingActionReviewAfterWebApply: vi.fn(), SLACK_MEETING_ACTION_REVIEW_EDIT_CALLBACK_ID: "synthetic-review",
  updateSlackMeetingActionReviewProposalFromModal: vi.fn(),
}));
vi.mock("./slack-followups", () => ({ reconcileSlackThreadFollowupsAfterMessageChange: vi.fn(), slackFollowupStopIntent: vi.fn(), suppressSlackThreadFollowups: vi.fn() }));
vi.mock("./slack-workspace-bindings", () => ({ getSlackWorkspaceBinding: () => ({ source:"legacy",signingSecret:"synthetic-secret" }) }));

import { fetchAndPersistReadableSlackThreadMessages, handleSlackCommand as unsignedCommand, handleSlackInteraction as unsignedInteraction, captureSlackSignedIngress } from "./communication";
function signed(payload: Record<string, unknown>) {
  const raw=JSON.stringify(payload), timestamp=String(Math.floor(Date.now()/1000));
  return captureSlackSignedIngress(raw,{"x-slack-request-timestamp":timestamp,"x-slack-signature":`v0=${createHmac("sha256","synthetic-secret").update(`v0:${timestamp}:${raw}`).digest("hex")}`});
}
const handleSlackCommand = (payload: URLSearchParams) => { payload=new URLSearchParams(payload);payload.set("api_app_id","A1");return unsignedCommand(payload,signed(Object.fromEntries(payload))); };
const handleSlackInteraction = (payload: Record<string,unknown>) => {payload={...payload,api_app_id:"A1"};return unsignedInteraction(payload,signed(payload)); };

const actor: AppActor = { kind: "user", user: { id: "user-1", email: "user@example.test", displayName: "User" } };
const params = { workspaceId: "workspace-1", installationId: "install-1", channelId: "C1", threadTs: "1714320000.000100" };
function providerMessage(ts = params.threadTs, text = "SYNTHETIC fresh public message") {
  return { ts, user: "U2", thread_ts: params.threadTs, text };
}

beforeEach(() => {
  vi.clearAllMocks(); f.rows.clear(); f.messages.clear(); f.requests.clear(); f.snapshots.length = 0; f.afterTransaction.mockReset();
  Object.assign(f.installation, { id: "install-1", workspaceId: "workspace-1", externalWorkspaceId: "T1", appId:"A1", botUserId:"UBOT", scopes:[], optionalScopes:[], provider: "SLACK", status: "ACTIVE", disconnectedAt: null, botTokenEnc: "enc:synthetic-token", settings: {} });
  Object.assign(f.channel, { id: "channel-1", workspaceId: "workspace-1", installationId: "install-1", externalChannelId: "C1", provider: "SLACK", kind: "PUBLIC", isIngestEnabled: true, isArchived: false });
  Object.assign(f.member, { id: "member-1", workspaceId: "workspace-1", userId: "user-1", isActive: true,
    user: { id: "user-1", email: "user@example.test", displayName: "User" } });
  Object.assign(f.mapping, { id: "mapping-1", workspaceId: "workspace-1", installationId: "install-1", provider: "SLACK", externalUserId: "U1", userId: "user-1", memberId: "member-1", isBot: false, isDeleted: false });
  f.client.auth.test.mockResolvedValue({ok:true,team_id:"T1",user_id:"UBOT"});
  f.client.conversations.history.mockImplementation(async (args: any) => {
    const responses = await Promise.all(f.client.conversations.replies.mock.results.map(result=>result.value));
    return {ok:true,messages:responses.flatMap(response=>response?.messages??[]).filter((row: any)=>row.ts===args.oldest).slice(0,1)};
  });
  f.client.conversations.info.mockReset().mockResolvedValue({ ok: true, channel: { id: "C1", is_private: false, is_archived: false, is_member: true } });
  f.client.conversations.replies.mockReset().mockImplementation(async (args: any) => {
    if (args.oldest) {
      const responses = await Promise.all(f.client.conversations.replies.mock.results.slice(0,-1).map(result=>result.value));
      return {ok:true,messages:responses.flatMap(response=>response?.messages??[]).filter((row: any)=>row.ts===args.oldest).slice(0,1)};
    }
    return {ok:true,messages:[providerMessage()]};
  });
  f.membership.mockReset().mockResolvedValue(f.member);
});

describe("native Slack thread receipts", () => {
  it("returns complete persisted provider rows after checking live destination and exact source proofs", async () => {
    const rows = await fetchAndPersistReadableSlackThreadMessages(actor, params);
    expect(rows).toEqual([expect.objectContaining({ id: `message-${params.threadTs}`, workspaceId: params.workspaceId, installationId: params.installationId,
      externalChannelId: "C1", externalUserId: "U2", externalMessageId: params.threadTs, text: "SYNTHETIC fresh public message", raw: expect.objectContaining(providerMessage()) })]);
    expect(f.client.conversations.info).toHaveBeenCalledTimes(3);
    expect(f.client.conversations.replies).toHaveBeenCalledWith({ channel: "C1", ts: params.threadTs, limit: 200 });
    expect(f.db.$queryRaw).toHaveBeenCalledTimes(3);
    expect(f.capture.mock.calls.at(-1)![2]).toEqual([expect.objectContaining({ kind: "CommunicationMessage", snapshot: rows[0] })]);
  });

  it.each(["private", "archived", "disabled", "disconnected", "departed", "remapped"])("withholds a %s source before provider reads", async state => {
    if (state === "private") f.channel.kind = "PRIVATE";
    if (state === "archived") f.channel.isArchived = true;
    if (state === "disabled") f.channel.isIngestEnabled = false;
    if (state === "disconnected") f.installation.status = "DISCONNECTED";
    if (state === "departed") f.member.isActive = false;
    if (state === "remapped") f.mapping.userId = "another-user";
    await expect(fetchAndPersistReadableSlackThreadMessages(actor, params)).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(f.client.conversations.replies).not.toHaveBeenCalled();
    expect(f.db.communicationMessage.upsert).not.toHaveBeenCalled();
  });

  it("does not replace a missing requester with a privileged agent actor", async () => {
    await expect(fetchAndPersistReadableSlackThreadMessages({ kind: "agent", authProvider: "bootstrap", label: "synthetic", workspaceIds: [params.workspaceId] }, params)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.client.conversations.info).not.toHaveBeenCalled();
    expect(f.client.conversations.replies).not.toHaveBeenCalled();
  });

  it("checks tenant identity before provider access", async () => {
    await expect(fetchAndPersistReadableSlackThreadMessages(actor, { ...params, workspaceId: "other-workspace" })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(f.client.conversations.replies).not.toHaveBeenCalled();
  });

  it("records observed remote privacy revocation without overwriting original messages", async () => {
    f.client.conversations.info.mockResolvedValueOnce({ ok: true, channel: { id: "C1", is_private: true, is_archived: false, is_member: true } });
    await expect(fetchAndPersistReadableSlackThreadMessages(actor, params)).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(f.channel.kind).toBe("PRIVATE");
    expect(f.client.conversations.replies).not.toHaveBeenCalled();
    expect(f.db.communicationMessage.upsert).not.toHaveBeenCalled();
  });

  it("rejects privacy changes during the remote replies call before persistence", async () => {
    f.client.conversations.replies.mockImplementationOnce(async () => {
      f.client.conversations.info.mockResolvedValueOnce({ ok: true, channel: { id: "C1", is_private: true, is_archived: false, is_member: true } });
      return { ok: true, messages: [providerMessage()] };
    });
    await expect(fetchAndPersistReadableSlackThreadMessages(actor, params)).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(f.db.communicationMessage.upsert).not.toHaveBeenCalled();
  });

  it.each(["disconnected", "remapped"])("rejects a %s requester connection during the provider read", async state => {
    f.client.conversations.replies.mockImplementationOnce(async () => {
      if (state === "disconnected") f.installation.status = "DISCONNECTED";
      else f.mapping.userId = "another-user";
      return { ok: true, messages: [providerMessage()] };
    });
    await expect(fetchAndPersistReadableSlackThreadMessages(actor, params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(f.db.communicationMessage.upsert).not.toHaveBeenCalled();
  });

  it("preserves the prior native body before updating a current provider message", async () => {
    const original = { id: "old-message", ...params, provider: "SLACK", externalChannelId: "C1", externalMessageId: params.threadTs,
      externalUserId: "U2", threadExternalId: params.threadTs, text: "ORIGINAL public body", receivedAt: new Date("2024-04-28T10:00:00Z"), isHidden: false, isDeleted: false, textRedactedAt: null };
    f.messages.set(params.threadTs, original);
    const rows = await fetchAndPersistReadableSlackThreadMessages(actor, params);
    expect(f.snapshots).toContainEqual(expect.objectContaining({ id: "old-message", text: "ORIGINAL public body" }));
    expect(rows[0]).toMatchObject({ id: "old-message", text: "SYNTHETIC fresh public message", receivedAt: new Date(Number(params.threadTs)*1000) });
  });

  it("preserves the exact native revision when a provider refresh repeats unchanged content", async () => {
    const first = await fetchAndPersistReadableSlackThreadMessages(actor, params);
    const before = JSON.stringify(first[0]);
    const second = await fetchAndPersistReadableSlackThreadMessages(actor, params);
    expect(second[0]).toBe(first[0]);
    expect(JSON.stringify(second[0])).toBe(before);
    expect(f.db.communicationMessage.upsert).toHaveBeenCalledOnce();
    expect(f.snapshot).not.toHaveBeenCalled();
  });

  it.each(["isBot", "isHidden", "isDeleted", "textRedactedAt"])("does not restore a locally %s source during a provider refresh", async field => {
    const original = { id: "blocked-message", externalMessageId: params.threadTs, text: "ORIGINAL withheld body", [field]: field === "textRedactedAt" ? new Date() : true };
    f.messages.set(params.threadTs, original);
    expect(await fetchAndPersistReadableSlackThreadMessages(actor, params)).toEqual([]);
    expect(f.db.communicationMessage.upsert).not.toHaveBeenCalled();
    expect(f.messages.get(params.threadTs)).toBe(original);
  });

  it("withholds native rows when grants revoke immediately after persistence", async () => {
    f.afterTransaction.mockImplementationOnce(() => { f.channel.isIngestEnabled = false; });
    await expect(fetchAndPersistReadableSlackThreadMessages(actor, params)).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(f.messages.size).toBe(1); // Keep the source; its live read gate now withholds it.
  });

  it("rejects a provider message from a different thread", async () => {
    f.client.conversations.replies.mockResolvedValueOnce({ ok: true, messages: [{ ...providerMessage(), thread_ts: "9999999999.000100" }] });
    await expect(fetchAndPersistReadableSlackThreadMessages(actor, params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(f.db.communicationMessage.upsert).not.toHaveBeenCalled();
  });

  it("requires exact remote channel identity and withholds mismatched provider message channels", async () => {
    f.client.conversations.info.mockResolvedValueOnce({ ok: true, channel: { id: "C_OTHER", is_private: false, is_archived: false, is_member: true } });
    await expect(fetchAndPersistReadableSlackThreadMessages(actor, params)).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(f.client.conversations.replies).not.toHaveBeenCalled();
    f.client.conversations.replies.mockResolvedValueOnce({ ok: true, messages: [{ ...providerMessage(), channel: "C_OTHER" }] });
    await expect(fetchAndPersistReadableSlackThreadMessages(actor, params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(f.db.communicationMessage.upsert).not.toHaveBeenCalled();
  });

  it("bounds provider input and excludes bot messages", async () => {
    f.client.conversations.replies.mockResolvedValueOnce({ ok: true, messages: [{ ...providerMessage(), bot_id: "BOT" }, providerMessage("1714320001.000100"), providerMessage("1714320002.000100")] });
    const rows = await fetchAndPersistReadableSlackThreadMessages(actor, { ...params, limit: 2 });
    expect(rows.map(row => row.externalMessageId)).toEqual(["1714320001.000100", "1714320002.000100"]);
    expect(f.client.conversations.replies.mock.calls[0][0].limit).toBe(200);
  });

  it("replenishes the permitted source limit through excluded bot and locally hidden provider candidates", async () => {
    const hidden = Array.from({ length: 100 }, (_, index) => providerMessage(`171431${String(index).padStart(4, "0")}.000100`, "HIDDEN source"));
    for (const message of hidden) f.messages.set(message.ts, { id: `hidden-${message.ts}`, externalMessageId: message.ts, isHidden: true, text: message.text });
    f.client.conversations.replies.mockResolvedValueOnce({ ok: true, messages: [
      ...Array.from({ length: 100 }, (_, index) => ({ ...providerMessage(`171430${String(index).padStart(4, "0")}.000100`), bot_id: "BOT" })), ...hidden,
    ], has_more: true, response_metadata: { next_cursor: "next-permitted-page" } });
    f.client.conversations.replies.mockResolvedValueOnce({ ok: true, messages: [providerMessage("1714320001.000100"), providerMessage("1714320002.000100")], has_more: false });
    const rows = await fetchAndPersistReadableSlackThreadMessages(actor, { ...params, limit: 2 });
    expect(rows.map(row => row.externalMessageId)).toEqual(["1714320001.000100", "1714320002.000100"]);
    expect(f.client.conversations.replies.mock.calls[1][0]).toMatchObject({ cursor: "next-permitted-page" });
    expect(f.db.communicationMessage.upsert).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(rows)).not.toContain("HIDDEN");
  });

});

describe("authored Slack request ingress", () => {
  it("mints an exact original slash command input and binds its queued job to that immutable id", async () => {
    const payload = new URLSearchParams({ team_id: "T1", user_id: "U1", channel_id: "C1", text: "What is our policy?", response_url: "https://synthetic.slack.test/response" });
    await handleSlackCommand(payload);
    expect(f.db.agentRequestInput.create).toHaveBeenCalledWith({ data: { workspaceId: "workspace-1", userId: "user-1", agentKey: "slack-agent", prompt: "What is our policy?" } });
    expect(f.db.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { dedupeKey: expect.stringMatching(/^install-1:slash_command:C1:.+:communication-slack-agent$/) }, create: expect.objectContaining({ payload: expect.objectContaining({ requestInputId: "request-1", source: "slash_command" }) }) }));
  });

  it("keeps shortcut source text in its native source and mints only the authored operation", async () => {
    await handleSlackInteraction({ type: "message_action", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      message: providerMessage(), response_url: "https://synthetic.slack.test/response" });
    expect(f.db.agentRequestInput.create).toHaveBeenCalledWith({ data: { workspaceId: "workspace-1", userId: "user-1", agentKey: "slack-agent", prompt: "Act on the selected Slack message." } });
    expect(f.db.workflowJob.upsert.mock.calls[0][0].create.payload).toMatchObject({ requestInputId: "request-1", sourceMessageId: `message-${params.threadTs}`, prompt: "Act on the selected Slack message." });
    expect(JSON.stringify(f.db.agentRequestInput.create.mock.calls)).not.toContain("SYNTHETIC fresh public message");
  });

  it("does not queue a stale selected snapshot whose current native text changed", async () => {
    await expect(handleSlackInteraction({ type: "message_action", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      message: { ...providerMessage(), text: "OLD selected body" } })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(f.db.agentRequestInput.create).not.toHaveBeenCalled();
    expect(f.db.workflowJob.upsert).not.toHaveBeenCalled();
  });

  it.each(["slash_command", "message_shortcut"])("binds signed %s retries to the same immutable input and job identity", async source => {
    const slash = new URLSearchParams({ team_id: "T1", user_id: "U1", channel_id: "C1", text: "What is our policy?", trigger_id: "SIGNED-TRIGGER" });
    const shortcut = { type: "message_action", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" }, message: providerMessage(), trigger_id: "SIGNED-TRIGGER" };
    if (source === "slash_command") { await handleSlackCommand(slash); await handleSlackCommand(slash); }
    else { await handleSlackInteraction(shortcut); await handleSlackInteraction(shortcut); }
    const calls = f.db.agentRequestInput.upsert.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].where.id).toBe(calls[1][0].where.id);
    expect(calls[0][0].update).toEqual({});
    expect(f.requests.size).toBe(1);
    expect(f.db.workflowJob.upsert.mock.calls[0][0].where).toEqual(f.db.workflowJob.upsert.mock.calls[1][0].where);
    expect(f.db.workflowJob.upsert.mock.calls[0][0].create.payload.requestInputId).toBe(calls[0][0].where.id);
  });

  it("rejects a changed payload using the same signed request identity without overwriting the original", async () => {
    const payload = new URLSearchParams({ team_id: "T1", user_id: "U1", channel_id: "C1", text: "What is our policy?", trigger_id: "SIGNED-TRIGGER" });
    await handleSlackCommand(payload);
    payload.set("text", "FORGED second body with the same trigger");
    await expect(handleSlackCommand(payload)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect([...f.requests.values()][0].prompt).toBe("What is our policy?");
    expect(f.db.workflowJob.upsert).toHaveBeenCalledOnce();
  });

});


describe("Guarded Slack HTTP attempts", () => {
  it.each(["post", "update"] as const)("denies %s after credential acquisition without sending", async mode => {
    f.guardedSdk = true; f.http.mockReset(); let allowed = true;
    const original = f.db.communicationInstallation.findUnique.getMockImplementation()!;
    f.db.communicationInstallation.findUnique.mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      const row = await original(...args); allowed = false; return row;
    });
    const controller = new AbortController();
    const guard = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal).toBe(controller.signal); if (!allowed) throw new Error("Original receipt revoked");
    });
    const { sendSlackMessage, updateSlackMessage } = await import("./communication");
    try {
      const call = mode === "post" ? sendSlackMessage("installation-1", { channel: "C1" }, [], undefined, { signal: controller.signal, authorizeAttempt: guard })
        : updateSlackMessage("installation-1", { channel: "C1", ts: "1" }, [], undefined, { signal: controller.signal, authorizeAttempt: guard });
      await expect(call).rejects.toThrow("Original receipt revoked");
      expect(guard).toHaveBeenCalledTimes(1); expect(f.http).not.toHaveBeenCalled();
    } finally { f.guardedSdk = false; }
  });
  it.each(["post", "update"] as const)("rechecks %s on SDK retry and stops immediately on denial", async mode => {
    f.guardedSdk = true; let allowed = true; let checks = 0;
    f.http.mockReset().mockImplementation(async config => {
      allowed = false;
      return { status: 500, statusText: "retry", data: {}, headers: {}, config };
    });
    const { sendSlackMessage, updateSlackMessage } = await import("./communication");
    const controls = { signal: new AbortController().signal, authorizeAttempt: async () => { checks++; if (!allowed) throw new Error("Retry receipt revoked"); } };
    try {
      await expect(mode === "post" ? sendSlackMessage("installation-1", { channel: "C1" }, [], undefined, controls)
        : updateSlackMessage("installation-1", { channel: "C1", ts: "1" }, [], undefined, controls)).rejects.toThrow("Retry receipt revoked");
      expect(checks).toBe(2); expect(f.http).toHaveBeenCalledTimes(1);
    } finally { f.guardedSdk = false; }
  });
  it("preserves authorized SDK retry and forwards cancellation to the actual transport", async () => {
    f.guardedSdk = true; const controller = new AbortController(); const guard = vi.fn(async () => {});
    f.http.mockReset().mockImplementationOnce(async config => ({ status: 500, data: {}, headers: {}, config }))
      .mockImplementationOnce(async config => ({ status: 200, data: { ok: true, ts: "2" }, headers: {}, request: { path: "/api/chat.postMessage" }, config }));
    const { sendSlackMessage } = await import("./communication");
    try {
      await expect(sendSlackMessage("installation-1", { channel: "C1" }, [], undefined,
        { signal: controller.signal, authorizeAttempt: guard })).resolves.toMatchObject({ ts: "2" });
      expect(guard).toHaveBeenCalledTimes(2); expect(f.http).toHaveBeenCalledTimes(2);
      expect(f.http.mock.calls[1][0].signal).toBe(controller.signal);
    } finally { f.guardedSdk = false; }
  });
});

describe("Slack agent response attempt controls", () => {
  it.each((["public", "ephemeral"] as const).flatMap(destination =>
    (["credentials", "retry", "none"] as const).map(boundary => ({ destination, boundary }))))("guards $destination replies at $boundary", async ({ destination, boundary }) => {
    f.guardedSdk = true;
    let allowed = true;
    const original = f.db.communicationInstallation.findUnique.getMockImplementation()!;
    f.db.communicationInstallation.findUnique.mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      const row = await original(...args);
      if (boundary === "credentials") allowed = false;
      return row;
    });
    const controller = new AbortController();
    const authorizeAttempt = vi.fn(async ({ signal }: Readonly<{ signal: AbortSignal }>) => {
      expect(signal).toBe(controller.signal);
      if (!allowed) { const failure = new Error("Original response receipt revoked"); controller.abort(failure); throw failure; }
    });
    let sends = 0;
    f.http.mockReset().mockImplementation(async config => {
      sends++;
      if (boundary === "retry" && sends === 1) { allowed = false; return { status: 500, data: {}, headers: {}, config }; }
      return { status: 200, data: { ok: true, ts: "2" }, headers: {}, request: { path: "/api/chat.postMessage" }, config };
    });
    const { deliverSlackAgentResponse } = await import("./communication");
    try {
      const result = await deliverSlackAgentResponse({ source: destination === "public" ? "app_mention" : "slash_command",
        installationId: "install-1", workspaceId: "workspace-1", actorUserId: "user-1", externalUserId: "U1", prompt: "Synthetic",
        channelId: "C1", threadTs: "1" }, { text: "Synthetic response" }, { signal: controller.signal, authorizeAttempt }).catch(error => error);
      expect(sends).toBe(boundary === "credentials" ? 0 : 1);
      expect(authorizeAttempt).toHaveBeenCalledTimes(boundary === "retry" ? 2 : 1);
      if (boundary === "none") { expect(result).toBeUndefined(); expect(f.http.mock.calls[0][0].signal).toBe(controller.signal); }
      else expect(result).toBeInstanceOf(Error);
    } finally { f.guardedSdk = false; }
  });

  it.each(["allow", "deny", "abort-during-response"] as const)("guards the decrypted response URL before fetch: %s", async mode => {
    const order: string[] = []; const controller = new AbortController();
    const failure = new Error("Original response authority revoked");
    const authorizeAttempt = vi.fn(async ({ signal }: Readonly<{ signal: AbortSignal }>) => {
      order.push("guard"); expect(signal).toBe(controller.signal);
      if (mode === "deny") { controller.abort(failure); throw failure; }
    });
    const fetchMock = vi.fn(async () => { order.push("fetch"); if (mode === "abort-during-response") controller.abort(failure); return { ok: true }; });
    vi.stubGlobal("fetch", fetchMock);
    const { deliverSlackAgentResponse } = await import("./communication");
    try {
      const result = await deliverSlackAgentResponse({ source: "slash_command", installationId: "install-1", workspaceId: "workspace-1",
        actorUserId: "user-1", externalUserId: "U1", prompt: "Synthetic", responseUrlEnc: "enc:https://synthetic.invalid/response" },
      { text: "Synthetic response" }, { signal: controller.signal, authorizeAttempt }).catch(error => error);
      expect(order).toEqual(mode === "deny" ? ["guard"] : ["guard", "fetch"]);
      if (mode === "allow") expect(result).toBeUndefined(); else expect(result).toBe(failure);
      if (mode !== "deny") expect(fetchMock).toHaveBeenCalledWith("https://synthetic.invalid/response",
        expect.objectContaining({ signal: controller.signal, method: "POST" }));
    } finally { vi.unstubAllGlobals(); }
  });
});
