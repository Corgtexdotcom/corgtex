import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => {
  const mock = {
    $transaction: vi.fn(),
    crmAccount: {
      findFirst: vi.fn(),
    },
    crmActivity: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    crmContact: {
      findFirst: vi.fn(),
    },
    crmConversation: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    meeting: {
      findFirst: vi.fn(),
    },
    meetingInsight: {
      createMany: vi.fn(),
      findFirst: vi.fn(),
    },
  };
  mock.$transaction.mockImplementation((fn: any) => fn(mock));
  return mock;
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

import {
  createCrmMeetingReviewInsights,
  materializeCrmCalendarTouchpoints,
  materializeCrmEmailTouchpoints,
  safeCrmEmailFilters,
} from "./crm-information-gathering";

describe("crm information gathering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock));
    prismaMock.crmContact.findFirst.mockResolvedValue(null);
    prismaMock.crmAccount.findFirst.mockResolvedValue(null);
    prismaMock.crmActivity.findUnique.mockResolvedValue(null);
    prismaMock.crmActivity.create.mockResolvedValue({ id: "activity-1" });
    prismaMock.crmActivity.update.mockResolvedValue({ id: "activity-1" });
    prismaMock.crmConversation.findUnique.mockResolvedValue(null);
    prismaMock.crmConversation.create.mockResolvedValue({ id: "conversation-1" });
    prismaMock.crmConversation.update.mockResolvedValue({ id: "conversation-1" });
    prismaMock.meeting.findFirst.mockResolvedValue(null);
    prismaMock.meetingInsight.createMany.mockResolvedValue({ count: 1 });
    prismaMock.meetingInsight.findFirst.mockResolvedValue({
      id: "insight-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      type: "CRM_ACTIVITY",
      status: "SUGGESTED",
    });
  });

  it("keeps CRM email materialization behind explicit business email filters", () => {
    expect(safeCrmEmailFilters([
      "",
      "newer_than:30d",
      "from:person@gmail.com",
      "from:buyer@example.test",
      "to:@customer.io",
      "FROM:BUYER@example.test",
    ])).toEqual(["from:buyer@example.test", "to:@customer.io"]);
  });

  it("materializes matched OAuth email once and updates on repeated sync without duplicate conversations", async () => {
    prismaMock.crmContact.findFirst.mockResolvedValue({
      id: "contact-1",
      name: "Buyer",
      email: "buyer@example.test",
      company: "Example",
      account: { id: "account-1", name: "Example", domain: "example.test" },
    });
    prismaMock.crmActivity.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "activity-1" });
    prismaMock.crmConversation.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "conversation-1" });
    const message = {
      id: "msg-1",
      provider: "GOOGLE" as const,
      subject: "Pilot next steps",
      from: "Buyer <buyer@example.test>",
      receivedAt: new Date("2026-06-18T09:00:00.000Z"),
      webUrl: "https://mail.test/msg-1",
      snippet: "Let's continue the pilot.",
      filter: "from:buyer@example.test",
    };

    const first = await materializeCrmEmailTouchpoints({
      workspaceId: "workspace-1",
      connectionId: "conn-1",
      messages: [message],
    });
    const second = await materializeCrmEmailTouchpoints({
      workspaceId: "workspace-1",
      connectionId: "conn-1",
      messages: [message],
    });

    expect(first).toMatchObject({ activitiesCreated: 1, conversationsCreated: 1 });
    expect(second).toMatchObject({ activitiesUpdated: 1, conversationsUpdated: 1 });
    expect(prismaMock.crmConversation.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.crmConversation.update).toHaveBeenCalledTimes(1);
  });

  it("skips unsafe email filters before matching CRM records", async () => {
    await materializeCrmEmailTouchpoints({
      workspaceId: "workspace-1",
      connectionId: "conn-1",
      messages: [{
        id: "msg-1",
        provider: "MICROSOFT",
        subject: "Broad result",
        from: "buyer@example.test",
        receivedAt: null,
        webUrl: null,
        snippet: "This came from a broad query.",
        filter: "newer_than:30d",
      }],
    });

    expect(prismaMock.crmContact.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.crmConversation.create).not.toHaveBeenCalled();
  });

  it("matches calendar events by existing business-domain accounts", async () => {
    prismaMock.crmContact.findFirst.mockResolvedValue(null);
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: "account-1", name: "Example", domain: "example.test" });

    const result = await materializeCrmCalendarTouchpoints({
      workspaceId: "workspace-1",
      connectionId: "conn-1",
      events: [{
        id: "event-1",
        provider: "GOOGLE",
        title: "Pilot kickoff",
        description: "Discuss kickoff",
        startTime: new Date("2026-06-18T10:00:00.000Z"),
        endTime: new Date("2026-06-18T10:30:00.000Z"),
        attendees: ["buyer@example.test"],
        organizerEmail: "owner@corgtex.com",
        meetingUrl: null,
        htmlLink: "https://calendar.test/event-1",
        status: null,
      }],
    });

    expect(result).toMatchObject({ activitiesCreated: 1 });
    expect(prismaMock.crmActivity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        accountId: "account-1",
        contactId: null,
        type: "MEETING",
        source: "oauth_calendar",
      }),
    }));
  });

  it("creates reviewable CRM meeting suggestions from matched meeting participants", async () => {
    prismaMock.meeting.findFirst.mockResolvedValue({
      id: "meeting-1",
      title: "Pilot review",
      transcript: "We should send the next step and discuss pricing for the pilot.",
      summaryMd: "Pilot pricing and follow up.",
      recordedAt: new Date("2026-06-18T10:00:00.000Z"),
      participantEmails: ["buyer@example.test"],
    });
    prismaMock.crmContact.findFirst.mockResolvedValue({
      id: "contact-1",
      name: "Buyer",
      email: "buyer@example.test",
      company: "Example",
      account: { id: "account-1", name: "Example", domain: "example.test" },
    });

    await createCrmMeetingReviewInsights({ workspaceId: "workspace-1", meetingId: "meeting-1" });

    expect(prismaMock.meetingInsight.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        type: "CRM_ACTIVITY",
        metadataJson: expect.objectContaining({
          crm: expect.objectContaining({ accountId: "account-1", contactId: "contact-1" }),
        }),
      })],
      skipDuplicates: true,
    }));
    expect(prismaMock.meetingInsight.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        type: "CRM_DEAL",
        metadataJson: expect.objectContaining({
          crm: expect.objectContaining({ recordType: "CRM_DEAL", contactId: "contact-1" }),
        }),
      })],
      skipDuplicates: true,
    }));
  });
});
