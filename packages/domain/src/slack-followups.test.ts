import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  communicationEntityLink: { findFirst: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
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
    prismaMock.communicationEntityLink.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.communicationEntityLink.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.communicationMessage.findMany.mockResolvedValue([]);
  });

  it.each(["STOP", "<@UBOT> STOP!", "Stop. Do nothing", "STOP ALL FOLLOW UP", "Can you stop the reminders?", "Please stop follow-ups?", "Ignore", "ignore this Corgtex", "solved", "delete it", "working on it <@UBOT>", "it's already being tracked on our action item list. please stop the reminders", "ack", "acknowledged", "got it!", "thanks <@UBOT>", "thank you."])("recognizes a thread-level human stop: %s", (text) => {
    expect(slackFollowupStopIntent(text)).toBe(true);
  });

  it.each(["FYI, should we discuss this?", "Please review this proposal", "Do not stop the migration", "Do not stop the reminders", "Never stop the nudges", "Don't ignore Corgtex", "Ignore the spelling mistake in this draft", "Stop the migration now", "Thanks, can you send the file?", "Got it, but keep reminding me", "Is this already being tracked?", "This is not already being tracked", "Nobody is working on it", "Working on it?", "<@UBOT> ack?"])("does not treat ordinary discussion as a stop: %s", (text) => {
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

  it("finds a historical stop beyond the newest 100 replies", async () => {
    const newest = Array.from({ length: 100 }, (_, index) => ({ id: `reply-${index}`, externalUserId: "U-member", text: "An ordinary update" }));
    prismaMock.communicationMessage.findMany
      .mockResolvedValueOnce(newest)
      .mockResolvedValueOnce([{ id: "older-stop", externalUserId: "U-unmatched", text: "ack" }]);
    await expect(isSlackThreadFollowupSuppressed(scope)).resolves.toBe(true);
    expect(prismaMock.communicationMessage.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: { id: "reply-99" },
      skip: 1,
    }));
    expect(prismaMock.communicationEntityLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ messageId: "older-stop", externalUserId: "U-unmatched" }),
    }));
  });

  it("removes a stop marker when its originating message is corrected", async () => {
    prismaMock.communicationEntityLink.findFirst.mockResolvedValueOnce({ id: "marker-1", messageId: "reply-1" });
    const { reconcileSlackThreadFollowupsAfterMessageChange } = await import("./slack-followups");
    await reconcileSlackThreadFollowupsAfterMessageChange({ ...scope, messageId: "reply-1" });
    expect(prismaMock.communicationEntityLink.deleteMany).toHaveBeenCalledWith({ where: { id: "marker-1", messageId: "reply-1" } });
  });

  it("keeps suppression when another stop remains after a correction", async () => {
    prismaMock.communicationEntityLink.findFirst.mockResolvedValueOnce({ id: "marker-1", messageId: "reply-1" });
    prismaMock.communicationMessage.findMany.mockResolvedValueOnce([{ id: "reply-2", externalUserId: "U-other", text: "STOP" }]);
    const { reconcileSlackThreadFollowupsAfterMessageChange } = await import("./slack-followups");
    await reconcileSlackThreadFollowupsAfterMessageChange({ ...scope, messageId: "reply-1" });
    expect(prismaMock.communicationEntityLink.updateMany).toHaveBeenCalledWith({
      where: { id: "marker-1", messageId: "reply-1" },
      data: { messageId: "reply-2", externalUserId: "U-other" },
    });
    expect(prismaMock.communicationEntityLink.deleteMany).not.toHaveBeenCalled();
  });
});
