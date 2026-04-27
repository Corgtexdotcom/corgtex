import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock, createActionMock } = vi.hoisted(() => {
  const tx = {
    communicationInstallation: { update: vi.fn() },
    workflowJob: { upsert: vi.fn() },
  };
  return {
    txMock: tx,
    prismaMock: {
      $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(tx)),
      communicationInboundEvent: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      communicationInstallation: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      communicationExternalUser: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      communicationMessage: {
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
      communicationEntityLink: {
        create: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
    },
    createActionMock: vi.fn(),
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
  env: {
    APP_URL: "https://app.example.test",
    NODE_ENV: "test",
    SLACK_SIGNING_SECRET: "slack-secret",
    ENCRYPTION_KEY: "a".repeat(64),
  },
  randomOpaqueToken: vi.fn(() => "nonce"),
  toInputJson: (value: unknown) => value,
  encryptSecret: (value: string) => `enc:${value}`,
  decryptSecret: (value: string) => value.replace(/^enc:/, ""),
}));

vi.mock("./actions", () => ({
  createAction: createActionMock,
  publishAction: vi.fn(),
}));

vi.mock("./tensions", () => ({
  createTension: vi.fn(),
  publishTension: vi.fn(),
}));

vi.mock("./proposals", () => ({
  createProposal: vi.fn(),
}));

vi.mock("./brain", () => ({
  ingestSource: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn(),
}));

function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = `v0=${createHmac("sha256", "slack-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Headers({
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  });
}

describe("communication Slack integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    createActionMock.mockResolvedValue({ id: "action-1" });
    prismaMock.communicationEntityLink.create.mockResolvedValue({});
    prismaMock.communicationMessage.updateMany.mockResolvedValue({ count: 2 });
  });

  it("verifies Slack request signatures", async () => {
    const { verifySlackRequest } = await import("./communication");
    const body = JSON.stringify({ type: "event_callback" });

    expect(verifySlackRequest(body, signedHeaders(body))).toBe(true);
  });

  it("rejects stale Slack request timestamps", async () => {
    const { verifySlackRequest } = await import("./communication");
    const body = "{}";
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600;

    expect(() => verifySlackRequest(body, signedHeaders(body, staleTimestamp))).toThrow("timestamp");
  });

  it("deduplicates Slack events and enqueues new events", async () => {
    const { ingestCommunicationEvent } = await import("./communication");
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce(null);
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      status: "ACTIVE",
    });
    prismaMock.communicationInboundEvent.create.mockResolvedValueOnce({
      id: "inbound-1",
    });

    const result = await ingestCommunicationEvent("SLACK", {
      team_id: "T1",
      event_id: "Ev1",
      event: { type: "message" },
    });

    expect(result).toEqual({ inboundEventId: "inbound-1", duplicate: false });
    expect(txMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "communication.slack.event",
        payload: { inboundEventId: "inbound-1" },
      }),
    }));
  });

  it("ignores Slack events for disconnected installations without enqueueing jobs", async () => {
    const { ingestCommunicationEvent } = await import("./communication");
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce(null);
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      status: "DISCONNECTED",
    });
    prismaMock.communicationInboundEvent.create.mockResolvedValueOnce({
      id: "inbound-ignored",
    });

    const result = await ingestCommunicationEvent("SLACK", {
      team_id: "T1",
      event_id: "EvDisconnected",
      event: { type: "message", text: "do not retain this text" },
    });

    expect(result).toEqual({ inboundEventId: "inbound-ignored", duplicate: false, ignored: true });
    expect(prismaMock.communicationInboundEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        installationId: "install-1",
        workspaceId: "workspace-1",
        status: "IGNORED",
        error: "Slack installation is not active.",
      }),
    }));
    expect(txMock.workflowJob.upsert).not.toHaveBeenCalled();
    expect(txMock.communicationInstallation.update).not.toHaveBeenCalled();
  });

  it("does not process stale queued Slack events after installation disconnect", async () => {
    const { processSlackInboundEvent } = await import("./communication");
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-1",
      provider: "SLACK",
      payload: {
        event: {
          type: "message",
          channel: "C1",
          ts: "1710000000.000100",
          text: "do not retain this text",
        },
      },
      installation: {
        id: "install-1",
        workspaceId: "workspace-1",
        status: "DISCONNECTED",
      },
    });

    await processSlackInboundEvent("inbound-1");

    expect(prismaMock.communicationInboundEvent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "inbound-1" },
      data: expect.objectContaining({
        status: "IGNORED",
        error: "Slack installation is not active.",
      }),
    }));
    expect(prismaMock.communicationMessage.upsert).not.toHaveBeenCalled();
  });

  it("creates private action drafts from Slack slash commands", async () => {
    const { handleSlackCommand } = await import("./communication");
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:bot-token",
    });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValueOnce({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });

    const response = await handleSlackCommand(new URLSearchParams({
      team_id: "T1",
      user_id: "U1",
      text: "action Ship the Slack MVP",
    }));

    expect(createActionMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "user" }), expect.objectContaining({
      workspaceId: "workspace-1",
      title: "Ship the Slack MVP",
      isPrivate: true,
    }));
    expect(response.text).toContain("Action draft created");
  });

  it("purges expired raw message content while preserving rows", async () => {
    const { purgeExpiredCommunicationMessages } = await import("./communication");

    await purgeExpiredCommunicationMessages("workspace-1");

    expect(prismaMock.communicationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        textRedactedAt: null,
      }),
      data: expect.objectContaining({
        text: null,
        textRedactedAt: expect.any(Date),
      }),
    }));
  });
});
