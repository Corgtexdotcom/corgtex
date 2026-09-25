import { beforeEach, describe, expect, it, vi } from "vitest";

const { appendEventsMock, findConversationMock, findEventMock, sendEmailMock, transactionMock } = vi.hoisted(() => ({
  appendEventsMock: vi.fn(),
  findConversationMock: vi.fn(),
  findEventMock: vi.fn(),
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
    event: {
      findFirst: findEventMock,
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
    findEventMock.mockResolvedValue({
      payload: {
        persona: "TRANSFORMER",
        answers: { whatBroughtYouHere: "Interested in helping owner-led companies transition." },
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
      text: expect.stringContaining("Inquiry type: Transformer / operator / advisor"),
      idempotencyKey: "crm-inquiry-acknowledgement/conversation-1",
      tracking: expect.objectContaining({
        emailType: "crm_inquiry_acknowledgement",
        workspaceId: "workspace-1",
      }),
      trackingRequired: true,
    }));
    expect(findEventMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: "workspace-1",
        type: "crm.inquiry.captured",
        aggregateType: "CrmConversation",
        aggregateId: "conversation-1",
      },
    }));
    expect(sendEmailMock.mock.calls[0]?.[0].text).toContain(
      "What brought them here: Interested in helping owner-led companies transition.",
    );
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

  it.each([
    ["OWNER", "goals", "Business owner", "Primary goals"],
    ["EMPLOYEE", "concern", "Employee / manager", "Reason for reaching out"],
    ["TRANSFORMER", "whatBroughtYouHere", "Transformer / operator / advisor", "What brought them here"],
    ["INVESTOR", "mandate", "Investor / capital partner", "Mandate or thesis"],
    ["PARTNER", "idea", "Partner / ecosystem", "Partnership idea"],
    ["GENERAL", "question", "General / press / research", "Question or request"],
  ])("uses the submitted %s answer for the summary", async (persona, answerKey, label, answerLabel) => {
    findEventMock.mockResolvedValueOnce({
      payload: { persona, answers: { [answerKey]: "  Need <help> & advice.  " } },
    });
    const { sendCrmInquiryAcknowledgement } = await import("./crm-inquiry-email");

    await sendCrmInquiryAcknowledgement({ workspaceId: "workspace-1", conversationId: "conversation-1" });

    const sent = sendEmailMock.mock.calls[0]?.[0];
    expect(sent.text).toContain(`Inquiry type: ${label}`);
    expect(sent.text).toContain(`${answerLabel}: Need <help> & advice.`);
    expect(sent.html).toContain("Need &lt;help&gt; &amp; advice.");
    expect(sent.html).not.toContain("Need <help>");
  });

  it("keeps the category when the submitted answer is absent", async () => {
    findEventMock.mockResolvedValueOnce({ payload: { persona: "GENERAL", answers: {} } });
    const { sendCrmInquiryAcknowledgement } = await import("./crm-inquiry-email");

    await sendCrmInquiryAcknowledgement({ workspaceId: "workspace-1", conversationId: "conversation-1" });

    expect(sendEmailMock.mock.calls[0]?.[0].text).toContain("Inquiry type: General / press / research");
    expect(sendEmailMock.mock.calls[0]?.[0].text).not.toContain("Question or request:");
  });

  it("does not send an unclassified inquiry when its capture event is missing", async () => {
    findEventMock.mockResolvedValueOnce(null);
    const { sendCrmInquiryAcknowledgement } = await import("./crm-inquiry-email");

    await expect(sendCrmInquiryAcknowledgement({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
    })).rejects.toThrow("CRM inquiry context is missing.");
    expect(sendEmailMock).not.toHaveBeenCalled();
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
