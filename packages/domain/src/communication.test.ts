import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  txMock,
  createActionMock,
  slackWebClientMock,
  meetingReviewConfirmMock,
  meetingReviewDismissMock,
  meetingReviewEditViewMock,
  meetingReviewModalUpdateMock,
} = vi.hoisted(() => {
  const tx = {
    communicationInstallation: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceIntegrationBinding: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    workflowJob: { upsert: vi.fn() },
    communicationEntityLink: { create: vi.fn() },
  };
  const webClient = {
    conversations: {
      list: vi.fn(),
      join: vi.fn(),
      history: vi.fn(),
      replies: vi.fn(),
      info: vi.fn(),
    },
    oauth: {
      v2: { access: vi.fn() },
    },
    chat: {
      postMessage: vi.fn(),
      postEphemeral: vi.fn(),
      update: vi.fn(),
    },
    users: {
      lookupByEmail: vi.fn(),
      info: vi.fn(),
    },
    views: {
      publish: vi.fn(),
      open: vi.fn(),
    },
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
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      },
      workspaceIntegrationBinding: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      communicationChannel: {
        upsert: vi.fn(),
      },
      communicationExternalUser: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      communicationMessage: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
      knowledgeChunk: {
        deleteMany: vi.fn(),
      },
      meeting: {
        findFirst: vi.fn(),
      },
      communicationEntityLink: {
        create: vi.fn(),
        findUnique: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      workflowJob: {
        upsert: vi.fn(),
      },
    },
    createActionMock: vi.fn(),
    slackWebClientMock: webClient,
    meetingReviewConfirmMock: vi.fn(),
    meetingReviewDismissMock: vi.fn(),
    meetingReviewEditViewMock: vi.fn(),
    meetingReviewModalUpdateMock: vi.fn(),
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
  submitProposal: vi.fn(),
}));

vi.mock("./brain", () => ({
  ingestSource: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn(),
}));

vi.mock("./meeting-action-review", () => ({
  SLACK_MEETING_ACTION_REVIEW_EDIT_CALLBACK_ID: "corgtex_meeting_review_edit_modal",
  isSlackMeetingActionReviewAction: (actionId: string) => [
    "corgtex_meeting_review_confirm",
    "corgtex_meeting_review_edit",
    "corgtex_meeting_review_dismiss",
  ].includes(actionId),
  parseSlackMeetingActionReviewActionValue: (value: string) => JSON.parse(value || "{}"),
  buildSlackMeetingActionReviewEditView: meetingReviewEditViewMock,
  confirmSlackMeetingActionReviewProposal: meetingReviewConfirmMock,
  dismissSlackMeetingActionReviewProposal: meetingReviewDismissMock,
  updateSlackMeetingActionReviewProposalFromModal: meetingReviewModalUpdateMock,
}));

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn(function WebClient() {
    return slackWebClientMock;
  }),
}));

function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = `v0=${createHmac("sha256", "slack-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Headers({
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  });
}

function slackMessageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    externalChannelId: "C1",
    externalMessageId: "1714320000.000100",
    threadExternalId: null,
    messageTs: new Date("2024-04-28T16:00:00.000Z"),
    updatedAt: new Date("2024-04-28T16:00:01.000Z"),
    ...overrides,
  };
}

describe("communication Slack integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock));
    createActionMock.mockResolvedValue({ id: "action-1" });
    prismaMock.communicationEntityLink.create.mockResolvedValue({});
    prismaMock.communicationEntityLink.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.communicationMessage.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.communicationMessage.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.communicationMessage.findMany.mockReset().mockResolvedValue([]);
    prismaMock.knowledgeChunk.deleteMany.mockReset().mockResolvedValue({ count: 0 });
    prismaMock.workspaceIntegrationBinding.findUnique.mockReset();
    prismaMock.workspaceIntegrationBinding.upsert.mockReset();
    prismaMock.communicationInstallation.findFirst.mockReset();
    prismaMock.communicationInstallation.findUnique.mockReset();
    prismaMock.communicationChannel.upsert.mockReset();
    prismaMock.communicationExternalUser.findFirst.mockReset();
    prismaMock.communicationExternalUser.findUnique.mockReset();
    prismaMock.communicationExternalUser.upsert.mockReset();
    prismaMock.user.findUnique.mockReset();
    prismaMock.communicationMessage.upsert.mockReset();
    prismaMock.communicationInstallation.update.mockReset();
    txMock.workspaceIntegrationBinding.findUnique.mockReset().mockResolvedValue(null);
    txMock.workspaceIntegrationBinding.upsert.mockReset().mockResolvedValue({ id: "binding-1", externalWorkspaceId: "T1" });
    txMock.communicationInstallation.findFirst.mockReset().mockResolvedValue(null);
    txMock.communicationInstallation.findUnique.mockReset().mockResolvedValue(null);
    txMock.communicationInstallation.update.mockReset();
    txMock.communicationInstallation.upsert.mockReset().mockResolvedValue({ id: "install-1" });
    txMock.workflowJob.upsert.mockReset();
    txMock.communicationEntityLink.create.mockReset().mockResolvedValue({});
    slackWebClientMock.conversations.list.mockReset();
    slackWebClientMock.conversations.join.mockReset();
    slackWebClientMock.conversations.history.mockReset();
    slackWebClientMock.conversations.info.mockReset();
    slackWebClientMock.chat.update.mockReset();
    slackWebClientMock.users.lookupByEmail.mockReset();
    slackWebClientMock.users.info.mockReset();
    slackWebClientMock.views.open.mockReset();
    prismaMock.meeting.findFirst.mockReset();
    meetingReviewConfirmMock.mockReset().mockResolvedValue({
      channelId: "C1",
      messageTs: "1714320000.000100",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
      text: "Corgtex meeting follow-up review",
      responseText: "Created action.",
    });
    meetingReviewDismissMock.mockReset().mockResolvedValue({
      channelId: "C1",
      messageTs: "1714320000.000100",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
      text: "Corgtex meeting follow-up review",
      responseText: "Dismissed.",
    });
    meetingReviewEditViewMock.mockReset().mockResolvedValue({ type: "modal", callback_id: "corgtex_meeting_review_edit_modal", blocks: [] });
    meetingReviewModalUpdateMock.mockReset().mockResolvedValue({
      channelId: "C1",
      messageTs: "1714320000.000100",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
      text: "Corgtex meeting follow-up review",
      responseText: "Updated.",
    });
  });

  it("verifies Slack request signatures", async () => {
    const { verifySlackRequest } = await import("./communication");
    const body = JSON.stringify({ type: "event_callback" });

    expect(verifySlackRequest(body, signedHeaders(body))).toBe(true);
  });

  it("bounds Slack digest messages by an optional upper cutoff", async () => {
    const { listSlackMessagesForDigest } = await import("./communication");
    const since = new Date("2026-04-29T12:00:00.000Z");
    const until = new Date("2026-04-30T12:00:00.000Z");

    await listSlackMessagesForDigest("workspace-1", since, until);

    expect(prismaMock.communicationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        provider: "SLACK",
        receivedAt: { gte: since, lte: until },
        text: { not: null },
        isBot: false,
        isHidden: false,
        isDeleted: false,
      }),
    }));
  });

  it("rejects stale Slack request timestamps", async () => {
    const { verifySlackRequest } = await import("./communication");
    const body = "{}";
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600;

    expect(() => verifySlackRequest(body, signedHeaders(body, staleTimestamp))).toThrow("timestamp");
  });

  it("requests public channel history and join scopes for archive installs", async () => {
    const { slackOAuthScopes } = await import("./communication");

    expect(slackOAuthScopes().split(",")).toEqual(expect.arrayContaining([
      "channels:history",
      "channels:join",
    ]));
  });

  it("round-trips versioned Slack OAuth state with expected team and flow metadata", async () => {
    const { createSlackOAuthState, readSlackOAuthState } = await import("./communication");

    const state = createSlackOAuthState("workspace-1", {
      expectedTeamId: "T1",
      flow: {
        kind: "control_plane",
        deploymentId: "dep-1",
        initiatedByUserId: "operator-1",
      },
    });

    expect(readSlackOAuthState(state.value)).toEqual({
      version: 1,
      workspaceId: "workspace-1",
      nonce: "nonce",
      expectedTeamId: "T1",
      flow: {
        kind: "control_plane",
        deploymentId: "dep-1",
        initiatedByUserId: "operator-1",
      },
    });
  });

  it("keeps reading legacy Slack OAuth state while callbacks roll over", async () => {
    const { readSlackOAuthState } = await import("./communication");
    const legacyState = Buffer.from(JSON.stringify({
      workspaceId: "workspace-1",
      nonce: "nonce",
    })).toString("base64url");

    expect(readSlackOAuthState(legacyState)).toEqual({
      version: 0,
      workspaceId: "workspace-1",
      nonce: "nonce",
      expectedTeamId: null,
      flow: { kind: "workspace" },
    });
  });

  it("stores archive settings with long retention when public history is granted", async () => {
    const { saveSlackInstallation } = await import("./communication");
    txMock.communicationInstallation.upsert.mockResolvedValueOnce({ id: "install-1" });

    await saveSlackInstallation({ kind: "system" } as any, {
      workspaceId: "workspace-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        access_token: "xoxb-token",
        scope: "commands,channels:history,channels:join",
      } as any,
    });

    expect(txMock.workspaceIntegrationBinding.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_provider: { workspaceId: "workspace-1", provider: "SLACK" } },
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        provider: "SLACK",
        externalWorkspaceId: "T1",
      }),
    }));
    expect(txMock.communicationInstallation.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        settings: expect.objectContaining({
          broadPublicIngestion: true,
          autoJoinPublicChannels: true,
          rawRetentionDays: 3650,
          unansweredFollowupDelayMinutes: 1440,
          unansweredActionCreationDelayMinutes: 1440,
          staleActionFollowupDelayMinutes: 4320,
          label: "Public Channel Archive",
        }),
      }),
      create: expect.objectContaining({
        settings: expect.objectContaining({
          broadPublicIngestion: true,
          autoJoinPublicChannels: true,
          rawRetentionDays: 3650,
          unansweredFollowupDelayMinutes: 1440,
          unansweredActionCreationDelayMinutes: 1440,
          staleActionFollowupDelayMinutes: 4320,
          label: "Public Channel Archive",
        }),
      }),
    }));
  });

  it("stores Slack installations for a target workspace without workspace membership checks", async () => {
    const { saveSlackInstallationForWorkspace } = await import("./communication");
    txMock.communicationInstallation.upsert.mockResolvedValueOnce({ id: "install-1" });

    await saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      installedByUserId: "operator-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        enterprise: { id: "E1" },
        app_id: "A1",
        bot_user_id: "B1",
        access_token: "xoxb-token",
        scope: "commands, chat:write, channels:history",
      } as any,
    });

    expect(txMock.workspaceIntegrationBinding.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_provider: { workspaceId: "workspace-1", provider: "SLACK" } },
      update: expect.objectContaining({
        externalOrgId: "E1",
        externalTeamName: "Team",
        appId: "A1",
        installedByUserId: "operator-1",
      }),
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        provider: "SLACK",
        externalWorkspaceId: "T1",
        externalOrgId: "E1",
        externalTeamName: "Team",
        appId: "A1",
        installedByUserId: "operator-1",
      }),
    }));
    expect(txMock.communicationInstallation.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { provider_externalWorkspaceId: { provider: "SLACK", externalWorkspaceId: "T1" } },
      update: expect.objectContaining({
        externalOrgId: "E1",
        externalTeamName: "Team",
        appId: "A1",
        botUserId: "B1",
        botTokenEnc: "enc:xoxb-token",
        scopes: ["commands", "chat:write", "channels:history"],
        optionalScopes: ["channels:history"],
        status: "ACTIVE",
        installedByUserId: "operator-1",
      }),
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        provider: "SLACK",
        externalWorkspaceId: "T1",
        installedByUserId: "operator-1",
      }),
    }));
  });

  it("rejects Slack OAuth when the selected team does not match the workspace binding", async () => {
    const { saveSlackInstallationForWorkspace } = await import("./communication");
    txMock.workspaceIntegrationBinding.findUnique.mockResolvedValueOnce({ externalWorkspaceId: "T1" });

    await expect(saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      expectedTeamId: "T1",
      oauthResponse: {
        ok: true,
        team: { id: "T2", name: "Other Team" },
        access_token: "xoxb-token",
        scope: "commands",
      } as any,
    })).rejects.toMatchObject({
      code: "SLACK_TEAM_MISMATCH",
    });

    expect(txMock.workspaceIntegrationBinding.upsert).not.toHaveBeenCalled();
    expect(txMock.communicationInstallation.upsert).not.toHaveBeenCalled();
  });

  it("rejects Slack OAuth when that team is already connected to another Corgtex workspace", async () => {
    const { saveSlackInstallationForWorkspace } = await import("./communication");
    txMock.communicationInstallation.findUnique.mockResolvedValueOnce({ workspaceId: "workspace-2" });

    await expect(saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        access_token: "xoxb-token",
        scope: "commands",
      } as any,
    })).rejects.toMatchObject({
      code: "SLACK_TEAM_ALREADY_CONNECTED",
    });

    expect(txMock.workspaceIntegrationBinding.upsert).not.toHaveBeenCalled();
    expect(txMock.communicationInstallation.upsert).not.toHaveBeenCalled();
  });

  it("sanitizes concurrent Slack binding uniqueness conflicts", async () => {
    const { saveSlackInstallationForWorkspace } = await import("./communication");
    txMock.workspaceIntegrationBinding.upsert.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    }));

    await expect(saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        access_token: "xoxb-token",
        scope: "commands",
      } as any,
    })).rejects.toMatchObject({
      code: "SLACK_TEAM_ALREADY_CONNECTED",
    });

    expect(txMock.communicationInstallation.upsert).not.toHaveBeenCalled();
  });

  it("rejects same-workspace Slack binding races before saving the losing team installation", async () => {
    const { saveSlackInstallationForWorkspace } = await import("./communication");
    txMock.workspaceIntegrationBinding.upsert.mockResolvedValueOnce({ externalWorkspaceId: "T2" });

    await expect(saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        access_token: "xoxb-token",
        scope: "commands",
      } as any,
    })).rejects.toMatchObject({
      code: "SLACK_WORKSPACE_ALREADY_BOUND",
    });

    expect(txMock.communicationInstallation.upsert).not.toHaveBeenCalled();
  });

  it("does not sanitize unrelated Slack binding database errors as tenant conflicts", async () => {
    const { saveSlackInstallationForWorkspace } = await import("./communication");
    txMock.workspaceIntegrationBinding.upsert.mockRejectedValueOnce(Object.assign(new Error("Record not found"), {
      code: "P2025",
    }));

    await expect(saveSlackInstallationForWorkspace({
      workspaceId: "workspace-1",
      oauthResponse: {
        ok: true,
        team: { id: "T1", name: "Team" },
        access_token: "xoxb-token",
        scope: "commands",
      } as any,
    })).rejects.toMatchObject({
      code: "P2025",
    });

    expect(txMock.communicationInstallation.upsert).not.toHaveBeenCalled();
  });

  it("resolves notification recipients from cached Slack user mappings before API lookup", async () => {
    const { resolveSlackNotificationRecipient } = await import("./communication");
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      botTokenEnc: "enc:xoxb-token",
    });
    prismaMock.communicationExternalUser.findFirst.mockResolvedValueOnce({
      externalUserId: "U1",
    });

    await expect(resolveSlackNotificationRecipient({
      workspaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.test",
    })).resolves.toEqual({
      installationId: "install-1",
      externalUserId: "U1",
    });

    expect(slackWebClientMock.users.lookupByEmail).not.toHaveBeenCalled();
  });

  it("looks up notification recipients by email and caches the Slack mapping", async () => {
    const { resolveSlackNotificationRecipient } = await import("./communication");
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      botTokenEnc: "enc:xoxb-token",
    });
    prismaMock.communicationExternalUser.findFirst.mockResolvedValueOnce(null);
    slackWebClientMock.users.lookupByEmail.mockResolvedValueOnce({
      user: {
        id: "U1",
        name: "andy",
        deleted: false,
        is_bot: false,
        profile: {
          email: "andy@example.test",
          display_name: "Andy",
        },
      },
    });
    prismaMock.communicationExternalUser.upsert.mockResolvedValueOnce({ id: "external-user-1" });

    await expect(resolveSlackNotificationRecipient({
      workspaceId: "workspace-1",
      userId: "user-1",
      email: "andy@example.test",
    })).resolves.toEqual({
      installationId: "install-1",
      externalUserId: "U1",
    });

    expect(slackWebClientMock.users.lookupByEmail).toHaveBeenCalledWith({ email: "andy@example.test" });
    expect(prismaMock.communicationExternalUser.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { installationId_externalUserId: { installationId: "install-1", externalUserId: "U1" } },
      update: expect.objectContaining({
        userId: "user-1",
        email: "andy@example.test",
        displayName: "Andy",
        isBot: false,
        isDeleted: false,
      }),
      create: expect.objectContaining({
        installationId: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        externalUserId: "U1",
        userId: "user-1",
      }),
    }));
  });

  it("syncs accessible public Slack channel history without storing bot messages", async () => {
    const { syncSlackPublicArchiveForWorkspace } = await import("./communication");
    prismaMock.communicationInstallation.findFirst.mockResolvedValueOnce({
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:xoxb-token",
      scopes: ["channels:history", "channels:join"],
      settings: { rawRetentionDays: 3650 },
      installedAt: new Date(),
    });
    slackWebClientMock.conversations.list.mockResolvedValueOnce({
      channels: [{ id: "C1", name: "general", is_archived: false, is_member: false }],
      response_metadata: {},
    });
    slackWebClientMock.conversations.join.mockResolvedValueOnce({ ok: true });
    slackWebClientMock.conversations.history.mockResolvedValueOnce({
      messages: [
        { ts: "1714320000.000100", user: "U1", text: "Public update" },
        { ts: "1714320001.000100", bot_id: "B1", subtype: "bot_message", text: "ignored" },
      ],
      response_metadata: {},
    });
    prismaMock.communicationChannel.upsert.mockResolvedValue({ id: "channel-1" });
    prismaMock.communicationMessage.upsert.mockResolvedValue(slackMessageRow());
    prismaMock.communicationInstallation.update.mockResolvedValue({ id: "install-1" });

    const summary = await syncSlackPublicArchiveForWorkspace("workspace-1");

    expect(summary).toMatchObject({
      channelsSeen: 1,
      channelsJoined: 1,
      messagesScanned: 2,
      messagesUpserted: 1,
      retentionDays: 3650,
    });
    expect(prismaMock.communicationMessage.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.communicationInstallation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        settings: expect.objectContaining({
          broadPublicIngestion: true,
          autoJoinPublicChannels: true,
          rawRetentionDays: 3650,
        }),
        lastError: null,
      }),
    }));
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

  it("ignores Slack events when the team no longer matches the workspace binding", async () => {
    const { ingestCommunicationEvent } = await import("./communication");
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce(null);
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-legacy",
      workspaceId: "workspace-1",
      status: "ACTIVE",
    });
    prismaMock.workspaceIntegrationBinding.findUnique.mockResolvedValueOnce({ externalWorkspaceId: "T2" });
    prismaMock.communicationInboundEvent.create.mockResolvedValueOnce({
      id: "inbound-ignored",
    });

    const result = await ingestCommunicationEvent("SLACK", {
      team_id: "T1",
      event_id: "EvLegacy",
      event: { type: "message" },
    });

    expect(result).toEqual({ inboundEventId: "inbound-ignored", duplicate: false, ignored: true });
    expect(prismaMock.communicationInboundEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        installationId: null,
        workspaceId: null,
        status: "IGNORED",
        error: "No Corgtex Slack installation matched this event.",
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

  it("stores public Slack message events and queues Brain indexing plus summaries", async () => {
    const { processSlackInboundEvent } = await import("./communication");
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-message",
      provider: "SLACK",
      payload: {
        event: {
          type: "message",
          channel: "C1",
          channel_type: "channel",
          user: "U1",
          ts: "1714320000.000100",
          text: "Public launch detail is ready.",
        },
      },
      installation: {
        id: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        status: "ACTIVE",
        settings: { rawRetentionDays: 3650 },
      },
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    prismaMock.communicationMessage.upsert.mockResolvedValueOnce(slackMessageRow());

    await processSlackInboundEvent("inbound-message");

    expect(prismaMock.communicationMessage.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        text: "Public launch detail is ready.",
        textRedactedAt: null,
        isDeleted: false,
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "knowledge.sync.slack-message",
        payload: { messageId: "message-1" },
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "external-resource.capture-source",
        payload: { sourceType: "SLACK_MESSAGE", sourceId: "message-1" },
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "communication.slack.context-summary",
        payload: expect.objectContaining({
          installationId: "install-1",
          channelId: "C1",
        }),
      }),
    }));
  });

  it("redacts deleted Slack messages and removes indexed Brain chunks", async () => {
    const { processSlackInboundEvent } = await import("./communication");
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-delete",
      provider: "SLACK",
      payload: {
        event: {
          type: "message",
          subtype: "message_deleted",
          channel: "C1",
          channel_type: "channel",
          deleted_ts: "1714320000.000100",
          previous_message: {
            type: "message",
            channel: "C1",
            user: "U1",
            ts: "1714320000.000100",
            text: "Please remove this",
          },
        },
      },
      installation: {
        id: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        status: "ACTIVE",
        settings: { rawRetentionDays: 3650 },
      },
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    prismaMock.communicationMessage.findUnique.mockResolvedValueOnce(slackMessageRow());

    await processSlackInboundEvent("inbound-delete");

    expect(prismaMock.communicationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        installationId: "install-1",
        externalChannelId: "C1",
        externalMessageId: "1714320000.000100",
      }),
      data: expect.objectContaining({
        text: null,
        isDeleted: true,
        isHidden: true,
        textRedactedAt: expect.any(Date),
      }),
    }));
    expect(prismaMock.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: {
        sourceType: "SLACK",
        sourceId: "message-1",
      },
    });
    expect(prismaMock.workflowJob.upsert).not.toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ type: "knowledge.sync.slack-message" }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "external-resource.capture-source",
        payload: { sourceType: "SLACK_MESSAGE", sourceId: "message-1" },
      }),
    }));
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "communication.slack.context-summary",
      }),
    }));
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

  it("atomically creates an open Action and final source link for a claim key", async () => {
    const { createWorkItemFromCommunicationSource } = await import("./communication");

    await expect(createWorkItemFromCommunicationSource({
      kind: "user",
      user: { id: "user-1", email: "user@example.test", displayName: "User", globalRole: "USER" },
    }, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Send the contract",
      sourceMessageId: "message-1",
      externalUserId: "U1",
      open: true,
      claimKey: "slack:proactive-action:message-1",
    })).resolves.toMatchObject({
      entityType: "Action",
      entityId: "action-1",
      opened: true,
    });

    expect(createActionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      isPrivate: false,
      _tx: txMock,
    }));
    expect(txMock.communicationEntityLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        claimKey: "slack:proactive-action:message-1",
        entityType: "Action",
        entityId: "action-1",
        action: "create_action",
      }),
    });
    expect(prismaMock.communicationEntityLink.create).not.toHaveBeenCalled();
  });

  it("returns the committed source-linked Action after a concurrent claim-key loss", async () => {
    const uniqueError = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    txMock.communicationEntityLink.create.mockRejectedValueOnce(uniqueError);
    prismaMock.communicationEntityLink.findUnique.mockResolvedValueOnce({
      installationId: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      messageId: "message-1",
      entityType: "Action",
      entityId: "action-existing",
      action: "create_action",
      claimKey: "slack:proactive-action:message-1",
    });
    const { createWorkItemFromCommunicationSource } = await import("./communication");

    await expect(createWorkItemFromCommunicationSource({
      kind: "user",
      user: { id: "user-1", email: "user@example.test", displayName: "User", globalRole: "USER" },
    }, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Send the contract",
      sourceMessageId: "message-1",
      open: true,
      claimKey: "slack:proactive-action:message-1",
    })).resolves.toMatchObject({
      entityType: "Action",
      entityId: "action-existing",
      opened: true,
    });
  });

  it("leaves no pre-claim when Action creation fails inside the transaction", async () => {
    const createError = new Error("Action creation failed");
    createActionMock.mockRejectedValueOnce(createError);
    const { createWorkItemFromCommunicationSource } = await import("./communication");

    await expect(createWorkItemFromCommunicationSource({
      kind: "user",
      user: { id: "user-1", email: "user@example.test", displayName: "User", globalRole: "USER" },
    }, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Send the contract",
      sourceMessageId: "message-1",
      open: true,
      claimKey: "slack:proactive-action:message-1",
    })).rejects.toBe(createError);

    expect(txMock.communicationEntityLink.create).not.toHaveBeenCalled();
    expect(prismaMock.communicationEntityLink.findUnique).not.toHaveBeenCalled();
  });

  it("does not mask unrelated unique failures or allow claim keys on non-open Actions", async () => {
    const uniqueError = Object.assign(new Error("Unrelated unique constraint failed"), { code: "P2002" });
    txMock.communicationEntityLink.create.mockRejectedValueOnce(uniqueError);
    const { createWorkItemFromCommunicationSource } = await import("./communication");
    const actor = {
      kind: "user" as const,
      user: { id: "user-1", email: "user@example.test", displayName: "User", globalRole: "USER" as const },
    };

    await expect(createWorkItemFromCommunicationSource(actor, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Send the contract",
      sourceMessageId: "message-1",
      open: true,
      claimKey: "slack:proactive-action:message-1",
    })).rejects.toBe(uniqueError);

    await expect(createWorkItemFromCommunicationSource(actor, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Draft only",
      claimKey: "slack:proactive-action:draft",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(createWorkItemFromCommunicationSource(actor, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "TENSION",
      title: "Not an Action",
      open: true,
      claimKey: "slack:proactive-action:tension",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(createWorkItemFromCommunicationSource(actor, {
      workspaceId: "workspace-1",
      provider: "SLACK",
      installationId: "install-1",
      kind: "ACTION",
      title: "Blank claim",
      open: true,
      claimKey: "   ",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("enqueues plain Slack slash command text for the Slack agent", async () => {
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
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    const response = await handleSlackCommand(new URLSearchParams({
      team_id: "T1",
      user_id: "U1",
      channel_id: "C1",
      response_url: "https://hooks.slack.test/response",
      text: "Jan should follow up with Milan tomorrow",
    }));

    expect(createActionMock).not.toHaveBeenCalled();
    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workspaceId: "workspace-1",
        type: "communication.slack.agent",
        payload: expect.objectContaining({
          source: "slash_command",
          prompt: "Jan should follow up with Milan tomorrow",
          channelId: "C1",
          responseUrlEnc: "enc:https://hooks.slack.test/response",
        }),
      }),
    }));
    expect(response.text).toContain("working");
  });

  it("enqueues app mentions with the bot mention stripped", async () => {
    const { processSlackInboundEvent } = await import("./communication");
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-1",
      provider: "SLACK",
      payload: {
        event: {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          ts: "1710000000.000100",
          text: "<@UBOT> turn this into a tension",
        },
      },
      installation: {
        id: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        status: "ACTIVE",
        botUserId: "UBOT",
        botTokenEnc: "enc:bot-token",
      },
    });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValueOnce({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    prismaMock.communicationMessage.upsert.mockResolvedValueOnce(slackMessageRow({ externalMessageId: "1710000000.000100" }));
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    await processSlackInboundEvent("inbound-1");

    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "inbound-1:communication-slack-agent" },
      create: expect.objectContaining({
        type: "communication.slack.agent",
        payload: expect.objectContaining({
          source: "app_mention",
          prompt: "turn this into a tension",
          threadTs: "1710000000.000100",
          sourceMessageId: "message-1",
        }),
      }),
    }));
  });

  it("routes app mentions in agenda threads to agenda editing", async () => {
    const { processSlackInboundEvent } = await import("./communication");
    prismaMock.communicationInboundEvent.findUnique.mockResolvedValueOnce({
      id: "inbound-agenda",
      provider: "SLACK",
      payload: {
        event: {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          ts: "1710000001.000100",
          thread_ts: "1710000000.000100",
          text: "<@UBOT> add Bob's detail to action item 2",
        },
      },
      installation: {
        id: "install-1",
        workspaceId: "workspace-1",
        provider: "SLACK",
        status: "ACTIVE",
        botUserId: "UBOT",
        botTokenEnc: "enc:bot-token",
      },
    });
    prismaMock.communicationExternalUser.findUnique.mockResolvedValueOnce({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    prismaMock.communicationMessage.upsert.mockResolvedValueOnce(slackMessageRow({ externalMessageId: "1710000001.000100", threadExternalId: "1710000000.000100" }));
    prismaMock.meeting.findFirst.mockResolvedValueOnce({ id: "meeting-1" });
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    await processSlackInboundEvent("inbound-agenda");

    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "inbound-agenda:meeting-agenda-edit" },
      create: expect.objectContaining({
        type: "meeting.agenda.edit",
        payload: expect.objectContaining({
          meetingId: "meeting-1",
          actorUserId: "user-1",
          installationId: "install-1",
          channelId: "C1",
          threadTs: "1710000000.000100",
          messageTs: "1710000001.000100",
          messageText: "add Bob's detail to action item 2",
          sourceMessageId: "message-1",
        }),
      }),
    }));
  });

  it("validates Slack agenda channels before saving", async () => {
    const { validateSlackPostTarget } = await import("./communication");
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      botTokenEnc: "enc:bot-token",
    });
    slackWebClientMock.conversations.info.mockResolvedValueOnce({
      channel: {
        id: "C1",
        name: "all-corgtex",
        is_archived: false,
        is_member: true,
      },
    });

    await expect(validateSlackPostTarget("install-1", "<#C1|all-corgtex>")).resolves.toEqual({
      ok: true,
      channelId: "C1",
      channelName: "all-corgtex",
    });
  });

  it("rejects Slack agenda channels where the bot is not a member", async () => {
    const { validateSlackPostTarget } = await import("./communication");
    prismaMock.communicationInstallation.findUnique.mockResolvedValueOnce({
      id: "install-1",
      botTokenEnc: "enc:bot-token",
    });
    slackWebClientMock.conversations.info.mockResolvedValueOnce({
      channel: {
        id: "C1",
        name: "new-channel",
        is_archived: false,
        is_member: false,
      },
    });

    await expect(validateSlackPostTarget("install-1", "C1")).resolves.toMatchObject({
      ok: false,
      code: "SLACK_CHANNEL_NOT_JOINED",
    });
  });

  it("runs the Slack agent for message shortcuts instead of opening the legacy modal", async () => {
    const { handleSlackInteraction } = await import("./communication");
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
    prismaMock.communicationChannel.upsert.mockResolvedValueOnce({ id: "channel-1", kind: "PUBLIC", isIngestEnabled: true });
    prismaMock.communicationMessage.upsert.mockResolvedValueOnce(slackMessageRow({ externalMessageId: "1710000000.000100" }));
    prismaMock.workflowJob.upsert.mockResolvedValueOnce({ id: "job-1" });

    const response = await handleSlackInteraction({
      type: "message_action",
      team: { id: "T1" },
      user: { id: "U1" },
      channel: { id: "C1" },
      response_url: "https://hooks.slack.test/response",
      message: {
        user: "U2",
        ts: "1710000000.000100",
        text: "We need clearer ownership for onboarding.",
      },
    });

    expect(prismaMock.workflowJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: "communication.slack.agent",
        payload: expect.objectContaining({
          source: "message_shortcut",
          prompt: "Act on this Slack message:\nWe need clearer ownership for onboarding.",
          sourceMessageId: "message-1",
          responseUrlEnc: "enc:https://hooks.slack.test/response",
        }),
      }),
    }));
    expect(response.text).toContain("working");
  });

  it("routes signed meeting-review confirm block actions through Corgtex-side authorization", async () => {
    const { handleSlackInteraction } = await import("./communication");
    const installation = {
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:bot-token",
      externalWorkspaceId: "T1",
    };
    prismaMock.communicationInstallation.findUnique.mockResolvedValue(installation);
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });

    const response = await handleSlackInteraction({
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      actions: [{
        action_id: "corgtex_meeting_review_confirm",
        value: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }),
      }],
    });

    expect(meetingReviewConfirmMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: "user",
      user: expect.objectContaining({ id: "user-1" }),
    }), {
      workspaceId: "workspace-1",
      installationId: "install-1",
      externalUserId: "U1",
      reviewId: "review-1",
      insightId: "insight-1",
    });
    expect(slackWebClientMock.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C1",
      ts: "1714320000.000100",
      text: "Corgtex meeting follow-up review",
    }));
    expect(response).toEqual({ response_type: "ephemeral", text: "Created action." });
  });

  it("opens the meeting-review edit modal from signed block actions", async () => {
    const { handleSlackInteraction } = await import("./communication");
    const installation = {
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:bot-token",
      externalWorkspaceId: "T1",
    };
    prismaMock.communicationInstallation.findUnique.mockResolvedValue(installation);
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });

    await expect(handleSlackInteraction({
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      trigger_id: "trigger-1",
      actions: [{
        action_id: "corgtex_meeting_review_edit",
        value: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }),
      }],
    })).resolves.toEqual({});

    expect(meetingReviewEditViewMock).toHaveBeenCalledWith(expect.any(Object), {
      workspaceId: "workspace-1",
      reviewId: "review-1",
      insightId: "insight-1",
    });
    expect(slackWebClientMock.views.open).toHaveBeenCalledWith(expect.objectContaining({
      trigger_id: "trigger-1",
      view: expect.objectContaining({ type: "modal" }),
    }));
  });

  it("updates the meeting-review Slack post after modal submissions", async () => {
    const { handleSlackInteraction } = await import("./communication");
    const installation = {
      id: "install-1",
      workspaceId: "workspace-1",
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: "enc:bot-token",
      externalWorkspaceId: "T1",
    };
    prismaMock.communicationInstallation.findUnique.mockResolvedValue(installation);
    prismaMock.communicationExternalUser.findUnique.mockResolvedValue({ userId: "user-1" });
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      globalRole: "USER",
    });

    await expect(handleSlackInteraction({
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U1" },
      view: {
        callback_id: "corgtex_meeting_review_edit_modal",
        private_metadata: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }),
        state: { values: { title: { value: { value: "Edited title" } } } },
      },
    })).resolves.toEqual({});

    expect(meetingReviewModalUpdateMock).toHaveBeenCalledWith(expect.any(Object), {
      workspaceId: "workspace-1",
      privateMetadata: JSON.stringify({ reviewId: "review-1", insightId: "insight-1" }),
      values: { title: { value: { value: "Edited title" } } },
    });
    expect(slackWebClientMock.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C1",
      ts: "1714320000.000100",
    }));
  });

  it("purges expired raw message content while preserving rows", async () => {
    const { purgeExpiredCommunicationMessages } = await import("./communication");
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([
      { id: "message-1" },
      { id: "message-2" },
    ]);

    await purgeExpiredCommunicationMessages("workspace-1");

    expect(prismaMock.communicationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        textRedactedAt: null,
      }),
      select: { id: true },
    }));
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
    expect(prismaMock.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: {
        sourceType: "SLACK",
        sourceId: { in: ["message-1", "message-2"] },
      },
    });
  });
});
