import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequestControls } from "@corgtex/models";

const fixture = vi.hoisted(() => {
  const state = {
    installation: null as any,
    channel: null as any,
    messages: [] as any[],
    summary: null as any,
    receipt: null as any,
    config: {} as any,
    beforeResponse: null as null | (() => void),
  };
  const fingerprint = (_kind: string, row: unknown) => JSON.stringify(row);
  const validChannel = () => state.installation?.status === "ACTIVE" && state.installation.disconnectedAt === null
    && state.installation.workspaceId === "ws-1" && state.channel?.workspaceId === "ws-1"
    && state.channel.kind === "PUBLIC" && state.channel.isIngestEnabled && !state.channel.isArchived;
  const validMessage = (message: any) => validChannel() && message.workspaceId === "ws-1"
    && message.installationId === state.installation.id && message.externalChannelId === state.channel.externalChannelId
    && !message.isBot && !message.isHidden && !message.isDeleted && message.textRedactedAt === null;
  const proofReadable = vi.fn(async (_actor, _workspaceId, proof) => proof.every((root: any) => {
    const row = root.kind === "CommunicationChannel" ? state.channel : state.messages.find((message) => message.id === root.id);
    return row && (root.kind === "CommunicationChannel" ? validChannel() : validMessage(row)) && fingerprint(root.kind, row) === root.fingerprint;
  }));
  const capture = vi.fn(async (_actor, _workspaceId, inputs) => {
    const proof = inputs.map((input: any) => ({ kind: input.kind, id: input.id, fingerprint: fingerprint(input.kind, input.snapshot) }));
    if (!await proofReadable(_actor, _workspaceId, proof)) throw Object.assign(new Error("Unverified input"), { code: "UNKNOWN_LINEAGE" });
    return proof;
  });
  const record = vi.fn(async (input) => { state.receipt = input; return { id: "receipt-1" }; });
  const prisma = {
    $transaction: vi.fn(), $queryRaw: vi.fn(), $executeRaw: vi.fn(),
    workspaceAgentConfig: { findUnique: vi.fn(async () => ({ configJson: structuredClone(state.config) })) },
    communicationInstallation: { findFirst: vi.fn(async () => state.installation?.status === "ACTIVE" && state.installation.disconnectedAt === null ? structuredClone(state.installation) : null) },
    communicationChannel: { findFirst: vi.fn(async () => validChannel() ? structuredClone(state.channel) : null) },
    communicationMessage: { findMany: vi.fn(async () => state.messages.filter(validMessage).map((message) => structuredClone(message))) },
    communicationContextSummary: {
      findUnique: vi.fn(async () => state.summary ? structuredClone(state.summary) : null),
      deleteMany: vi.fn(),
      upsert: vi.fn(async (input) => {
        state.summary = state.summary ? { ...state.summary, ...input.update, updatedAt: new Date("2026-10-13T00:00:00Z") }
          : { id: "summary-1", ...input.create, updatedAt: new Date("2026-10-13T00:00:00Z") };
        return structuredClone(state.summary);
      }),
    },
  };
  const chat = vi.fn(async (_request: ModelRequestControls & { messages: Array<{ content: string }> }) => {
    state.beforeResponse?.();
    return { content: "Synthetic model output from both messages." };
  });
  return { state, fingerprint, proofReadable, capture, record, prisma, chat };
});

vi.mock("@corgtex/shared", () => ({ env: { APP_URL: "https://app.example.test" }, prisma: fixture.prisma, toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value)) }));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { chat: fixture.chat }, resolveModel: () => "fake-model" }));
vi.mock("@corgtex/domain", () => ({
  AGENT_REGISTRY: { "slack-agent": { defaultModelTier: "standard" } },
  captureArtifactInputProof: fixture.capture,
  isArtifactInputProofReadable: fixture.proofReadable,
  lineageContentFingerprint: fixture.fingerprint,
  recordArtifactInputLineage: fixture.record,
  invariant: (condition: unknown, _status: number, code: string, message: string) => {
    if (!condition) throw Object.assign(new Error(message), { code });
  },
}));

import { runSlackContextSummary } from "./slack-context";

const params = { workspaceId: "ws-1", installationId: "installation-1", channelId: "C1", dayISO: "2026-10-12", workflowJobId: "synthetic-job" };
function oldSummary() {
  return { id: "summary-1", workspaceId: "ws-1", installationId: "installation-1", summaryMd: "Unknown legacy or restricted prior content.",
    updatedAt: new Date("2026-10-12T01:00:00Z"), title: "Prior private summary" };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.record.mockImplementation(async (input) => { fixture.state.receipt = input; return { id: "receipt-1" }; });
  fixture.state.installation = { id: "installation-1", workspaceId: "ws-1", provider: "SLACK", status: "ACTIVE", disconnectedAt: null };
  fixture.state.channel = { id: "channel-1", workspaceId: "ws-1", installationId: "installation-1", provider: "SLACK", externalChannelId: "C1",
    name: "synthetic-general", kind: "PUBLIC", isIngestEnabled: true, isArchived: false };
  fixture.state.messages = [1, 2].map((number) => ({ id: `message-${number}`, workspaceId: "ws-1", installationId: "installation-1", provider: "SLACK",
    externalChannelId: "C1", externalMessageId: `timestamp-${number}`, externalUserId: `U${number}`, threadExternalId: null,
    text: `Synthetic public message ${number}`, messageTs: new Date(`2026-10-12T12:0${number}:00Z`), isBot: false, isHidden: false, isDeleted: false, textRedactedAt: null }));
  fixture.state.summary = null;
  fixture.state.receipt = null;
  fixture.state.config = {};
  fixture.state.beforeResponse = null;
  fixture.prisma.$transaction.mockImplementation(async (callback) => {
    const before = structuredClone({ summary: fixture.state.summary, receipt: fixture.state.receipt });
    try { return await callback(fixture.prisma); }
    catch (error) { fixture.state.summary = before.summary; fixture.state.receipt = before.receipt; throw error; }
  });
});

describe("Slack summary complete input receipts", () => {
  it("captures the channel name and every prompt message before generation, then commits a DERIVED receipt atomically", async () => {
    expect(await runSlackContextSummary(params)).toEqual({ summarized: true, messageCount: 2 });
    expect(fixture.capture.mock.calls[0][2]).toEqual([
      expect.objectContaining({ kind: "CommunicationChannel", id: "channel-1", snapshot: expect.objectContaining({ name: "synthetic-general" }) }),
      expect.objectContaining({ kind: "CommunicationMessage", id: "message-1" }),
      expect.objectContaining({ kind: "CommunicationMessage", id: "message-2" }),
    ]);
    expect(fixture.capture.mock.invocationCallOrder[0]).toBeLessThan(fixture.chat.mock.invocationCallOrder[0]);
    const prompt = JSON.parse(fixture.chat.mock.calls[0][0].messages[1].content);
    expect(prompt.channel).toBe("#synthetic-general");
    expect(prompt.transcript).toContain("Synthetic public message 1");
    expect(prompt.transcript).toContain("Synthetic public message 2");
    expect(fixture.record).toHaveBeenCalledWith(expect.objectContaining({
      tx: fixture.prisma, artifact: { kind: "CommunicationContextSummary", id: "summary-1" },
      content: expect.objectContaining({ summaryMd: "Synthetic model output from both messages." }), origin: "DERIVED", inputs: [],
      inheritedRoots: expect.arrayContaining([expect.objectContaining({ kind: "CommunicationChannel" }), expect.objectContaining({ id: "message-2" })]),
    }));
    expect(fixture.prisma.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it("excludes unknown prior summary text from the model context", async () => {
    fixture.state.summary = oldSummary();
    await runSlackContextSummary(params);
    expect(JSON.stringify(fixture.chat.mock.calls)).not.toMatch(/Unknown legacy|Prior private summary/);
    expect(fixture.capture.mock.calls[0][2].every((input: any) => input.kind !== "CommunicationContextSummary")).toBe(true);
  });

  it("preserves the previous summary when no current readable messages remain", async () => {
    fixture.state.summary = oldSummary();
    fixture.state.messages = [];
    expect(await runSlackContextSummary(params)).toEqual({ skipped: true, reason: "no_messages" });
    expect(fixture.state.summary).toEqual(oldSummary());
    expect(fixture.prisma.communicationContextSummary.deleteMany).not.toHaveBeenCalled();
    expect(fixture.chat).not.toHaveBeenCalled();
  });

  it.each(["PRIVATE", "archived", "disabled", "other-workspace", "disconnected"])("rejects an initially %s Slack source before generating", async (condition) => {
    fixture.state.summary = oldSummary();
    if (condition === "PRIVATE") fixture.state.channel.kind = "PRIVATE";
    if (condition === "archived") fixture.state.channel.isArchived = true;
    if (condition === "disabled") fixture.state.channel.isIngestEnabled = false;
    if (condition === "other-workspace") fixture.state.channel.workspaceId = "ws-2";
    if (condition === "disconnected") fixture.state.installation.disconnectedAt = new Date();
    expect(await runSlackContextSummary(params)).toMatchObject({ skipped: true });
    expect(fixture.chat).not.toHaveBeenCalled();
    expect(fixture.state.summary).toEqual(oldSummary());
  });

  it.each(["channel-name", "message-text", "message-hidden", "installation-disconnected", "channel-private", "new-message", "disabled-config"])("preserves old content when %s changes during generation", async (condition) => {
    fixture.state.summary = oldSummary();
    fixture.state.beforeResponse = () => {
      if (condition === "channel-name") fixture.state.channel.name = "synthetic-renamed";
      if (condition === "message-text") fixture.state.messages[0].text = "Synthetic edited message";
      if (condition === "message-hidden") fixture.state.messages[0].isHidden = true;
      if (condition === "installation-disconnected") fixture.state.installation.disconnectedAt = new Date();
      if (condition === "channel-private") fixture.state.channel.kind = "PRIVATE";
      if (condition === "new-message") fixture.state.messages.push({ ...fixture.state.messages[0], id: "message-3", externalMessageId: "timestamp-3" });
      if (condition === "disabled-config") fixture.state.config.publicIngestionEnabled = false;
    };
    await expect(runSlackContextSummary(params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.state.summary).toEqual(oldSummary());
    expect(fixture.record).not.toHaveBeenCalled();
  });

  it("rejects an older generation after a newer summary commits", async () => {
    fixture.state.beforeResponse = () => { fixture.state.summary = { ...oldSummary(), summaryMd: "Newer valid summary", updatedAt: new Date("2026-10-12T20:00:00Z") }; };
    await expect(runSlackContextSummary(params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.state.summary.summaryMd).toBe("Newer valid summary");
    expect(fixture.prisma.communicationContextSummary.upsert).not.toHaveBeenCalled();
  });

  it("rolls back content when lineage persistence fails", async () => {
    fixture.state.summary = oldSummary();
    fixture.record.mockRejectedValueOnce(new Error("Synthetic receipt storage failure"));
    await expect(runSlackContextSummary(params)).rejects.toThrow("Synthetic receipt storage failure");
    expect(fixture.prisma.communicationContextSummary.upsert).toHaveBeenCalled();
    expect(fixture.state.summary).toEqual(oldSummary());
    expect(fixture.state.receipt).toBeNull();
  });
});


describe("Slack summary provider attempt boundary", () => {
  it.each(["credentials", "retry"] as const)("withholds original transcript after revocation during %s", async (phase) => {
    let sends = 0;
    fixture.chat.mockImplementationOnce(async (request) => {
      const guarded = request;
      const signal = new AbortController().signal;
      if (phase === "retry") { await guarded.authorizeAttempt?.({ signal }); sends += 1; }
      fixture.state.messages[0].isHidden = true;
      await guarded.authorizeAttempt?.({ signal });
      sends += 1;
      return { content: "Should not send revoked transcript" };
    });
    await expect(runSlackContextSummary(params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(sends).toBe(phase === "retry" ? 1 : 0);
    expect(fixture.capture).toHaveBeenCalledTimes(1);
    expect(fixture.record).not.toHaveBeenCalled();
  });
  it.each(["redacted", "disconnected", "muted", "disabled"])("denies %s inputs before the summary provider send", async (change) => {
    let sends = 0;
    fixture.chat.mockImplementationOnce(async (request) => {
      if (change === "redacted") fixture.state.messages[0].textRedactedAt = new Date();
      if (change === "disconnected") fixture.state.installation.disconnectedAt = new Date();
      if (change === "muted") fixture.state.config.mutedChannelIds = ["C1"];
      if (change === "disabled") fixture.state.config.publicIngestionEnabled = false;
      await request.authorizeAttempt!({ signal: new AbortController().signal });
      sends += 1;
      return { content: "Denied" };
    });
    await expect(runSlackContextSummary(params)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(sends).toBe(0);
    expect(fixture.capture).toHaveBeenCalledTimes(1);
  });

  it("permits a retry with the same original receipt and propagates cancellation", async () => {
    const controller = new AbortController();
    fixture.chat.mockImplementationOnce(async (request) => {
      expect(request.signal).toBe(controller.signal);
      const original = await fixture.capture.mock.results[0].value;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await request.authorizeAttempt!({ signal: controller.signal });
        expect(fixture.proofReadable.mock.calls.at(-1)![2]).toBe(original);
      }
      return { content: "Permitted summary" };
    });
    await expect(runSlackContextSummary({ ...params, signal: controller.signal })).resolves.toMatchObject({ summarized: true });
    expect(fixture.capture).toHaveBeenCalledTimes(1);
    expect(fixture.state.summary.summaryMd).toBe("Permitted summary");
  });

  it.each(["before", "during proof"])("stops a cancelled summary attempt %s authorization", async (phase) => {
    const controller = new AbortController();
    let sends = 0;
    const check = fixture.proofReadable.getMockImplementation()!;
    fixture.chat.mockImplementationOnce(async (request) => {
      if (phase === "before") controller.abort(new Error("Synthetic cancellation"));
      else fixture.proofReadable.mockImplementationOnce(async (...args) => { const allowed = await check(...args); controller.abort(new Error("Synthetic cancellation")); return allowed; });
      await request.authorizeAttempt!({ signal: controller.signal });
      sends += 1;
      return { content: "Cancelled" };
    });
    await expect(runSlackContextSummary({ ...params, signal: controller.signal })).rejects.toThrow("Synthetic cancellation");
    expect(sends).toBe(0);
    expect(fixture.record).not.toHaveBeenCalled();
  });

});
