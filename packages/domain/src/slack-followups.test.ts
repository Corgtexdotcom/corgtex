import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  communicationEntityLink: { findFirst: vi.fn(), upsert: vi.fn() },
  communicationMessage: { findMany: vi.fn() },
}));

vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));

import { isSlackThreadFollowupSuppressed, slackFollowupStopIntent, suppressSlackThreadFollowups } from "./slack-followups";

const scope = { workspaceId: "workspace-1", installationId: "install-1", channelId: "C1", threadTs: "1788205758.060039" };

describe("Slack follow-up suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.communicationEntityLink.findFirst.mockResolvedValue(null);
    prismaMock.communicationEntityLink.upsert.mockResolvedValue({ id: "marker-1" });
    prismaMock.communicationMessage.findMany.mockResolvedValue([]);
  });

  it.each(["Stop. Do nothing", "STOP ALL FOLLOW UP", "Ignore", "ignore this Corgtex", "solved", "delete it", "working on it <@UBOT>", "it's already being tracked on our action item list. please stop the reminders"])("recognizes a thread-level human stop: %s", (text) => {
    expect(slackFollowupStopIntent(text)).toBe(true);
  });

  it.each(["FYI, should we discuss this?", "Please review this proposal", "Do not stop the migration", "Ignore the spelling mistake in this draft"])("does not treat ordinary discussion as a stop: %s", (text) => {
    expect(slackFollowupStopIntent(text)).toBe(false);
  });

  it("records an unmatched Slack user command against only its installation and thread", async () => {
    await suppressSlackThreadFollowups({ ...scope, messageId: "reply-1", externalUserId: "U-unmatched" });
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledWith({
      where: { workspaceId_claimKey: { workspaceId: "workspace-1", claimKey: "slack-followup-stop:install-1:C1:1788205758.060039" } },
      update: {},
      create: expect.objectContaining({ workspaceId: "workspace-1", installationId: "install-1", messageId: "reply-1", externalUserId: "U-unmatched", entityType: "SlackThread", entityId: "C1:1788205758.060039", action: "slack_followup_suppressed" }),
    });
  });

  it("reconciles old STOP replies before another reminder can be sent", async () => {
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([{ id: "reply-1", externalUserId: "U-unmatched", text: "Stop. Do nothing" }]);
    await expect(isSlackThreadFollowupSuppressed(scope)).resolves.toBe(true);
    expect(prismaMock.communicationMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "workspace-1", installationId: "install-1", externalChannelId: "C1", OR: [{ externalMessageId: scope.threadTs }, { threadExternalId: scope.threadTs }] }) }));
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledTimes(1);
  });
});
