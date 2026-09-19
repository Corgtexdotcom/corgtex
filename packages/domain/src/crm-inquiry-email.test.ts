import { beforeEach, describe, expect, it, vi } from "vitest";

const { appendEventsMock, findConversationMock, sendEmailMock, transactionMock } = vi.hoisted(() => ({
  appendEventsMock: vi.fn(),
  findConversationMock: vi.fn(),
  sendEmailMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    CRM_INQUIRY_ACKNOWLEDGEMENT_CC_EMAIL: " First@example.com,second@example.com,first@example.com ",
  },
  prisma: {
    crmConversation: {
      findFirst: findConversationMock,
    },
    $transaction: transactionMock,
  },
  sendEmail: sendEmailMock,
  toInputJson: (value: unknown) => value,
}));

vi.mock("./events", () => ({
  appendEvents: appendEventsMock,
}));

describe("sendCrmInquiryAcknowledgement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findConversationMock.mockResolvedValue({
      id: "conversation-1",
      sourceExternalId: "submission-1",
      contact: {
        email: "lead@example.com",
        name: "Ava <Owner>",
      },
    });
    sendEmailMock.mockResolvedValue({
      status: "SENT",
      providerMessageId: "resend-1",
    });
    transactionMock.mockImplementation(async (callback) => callback({ event: { createMany: vi.fn() } }));
  });

  it("sends an idempotent acknowledgement with the configured colleagues copied", async () => {
    const { sendCrmInquiryAcknowledgement } = await import("./crm-inquiry-email");

    await expect(sendCrmInquiryAcknowledgement({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
    })).resolves.toEqual({
      status: "SENT",
      providerMessageId: "resend-1",
    });

    expect(findConversationMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "conversation-1",
        workspaceId: "workspace-1",
        source: "corporate_rebels_website",
      },
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "lead@example.com",
      cc: ["first@example.com", "second@example.com"],
      subject: "We received your Corporate Rebels inquiry",
      html: expect.stringContaining("Ava &lt;Owner&gt;"),
      idempotencyKey: "crm-inquiry-acknowledgement/conversation-1",
      tracking: expect.objectContaining({
        emailType: "crm_inquiry_acknowledgement",
        workspaceId: "workspace-1",
      }),
      trackingRequired: true,
    }));
    expect(appendEventsMock).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
      workspaceId: "workspace-1",
      type: "crm.inquiry.acknowledgement_sent",
      aggregateId: "conversation-1",
      payload: {
        conversationId: "conversation-1",
        providerMessageId: "resend-1",
      },
    })]);
  });

  it("fails for retry when Resend is unavailable after CRM storage", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("provider unavailable"));
    const { sendCrmInquiryAcknowledgement } = await import("./crm-inquiry-email");

    await expect(sendCrmInquiryAcknowledgement({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
    })).rejects.toThrow("provider unavailable");
    expect(appendEventsMock).not.toHaveBeenCalled();
  });
});
