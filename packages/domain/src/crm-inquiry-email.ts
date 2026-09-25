import { env, prisma, sendEmail, toInputJson } from "@corgtex/shared";
import { appendEvents } from "./events";

export const CRM_INQUIRY_ACKNOWLEDGEMENT_JOB_TYPE = "email.crm-inquiry-acknowledgement";
const CRM_INQUIRY_SOURCE = "corporate_rebels_website";
const INQUIRY_CONTEXT = {
  OWNER: { label: "Business owner", answerKey: "goals", answerLabel: "Primary goals" },
  EMPLOYEE: { label: "Employee / manager", answerKey: "concern", answerLabel: "Reason for reaching out" },
  TRANSFORMER: { label: "Transformer / operator / advisor", answerKey: "whatBroughtYouHere", answerLabel: "What brought them here" },
  INVESTOR: { label: "Investor / capital partner", answerKey: "mandate", answerLabel: "Mandate or thesis" },
  PARTNER: { label: "Partner / ecosystem", answerKey: "idea", answerLabel: "Partnership idea" },
  GENERAL: { label: "General / press / research", answerKey: "question", answerLabel: "Question or request" },
} as const;

function inquiryContext(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("CRM inquiry context is missing.");
  }
  const record = payload as Record<string, unknown>;
  const persona = record.persona;
  if (typeof persona !== "string" || !(persona in INQUIRY_CONTEXT)) {
    throw new Error("CRM inquiry persona is missing.");
  }
  const definition = INQUIRY_CONTEXT[persona as keyof typeof INQUIRY_CONTEXT];
  const answers = record.answers;
  const answer = answers && typeof answers === "object" && !Array.isArray(answers)
    ? (answers as Record<string, unknown>)[definition.answerKey]
    : null;
  const cleanedAnswer = typeof answer === "string" ? answer.trim().replace(/\s+/g, " ") : "";
  return {
    persona: definition.label,
    answerLabel: definition.answerLabel,
    answer: cleanedAnswer.length > 500 ? `${cleanedAnswer.slice(0, 497)}...` : cleanedAnswer,
  };
}

function acknowledgementCcRecipients(value: string | undefined) {
  return [...new Set((value ?? "")
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean))];
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function acknowledgementContent(name: string, context: ReturnType<typeof inquiryContext>) {
  const displayName = name.trim() || "there";
  const answerHtml = context.answer
    ? `<p><strong>${escapeHtml(context.answerLabel)}:</strong> ${escapeHtml(context.answer)}</p>`
    : "";
  return {
    subject: "We received your Corporate Rebels inquiry",
    html: [
      "<!doctype html>",
      '<html><body style="font-family:Arial,sans-serif;color:#1f1d1a;line-height:1.6;">',
      `<p>Hi ${escapeHtml(displayName)},</p>`,
      "<p>Thank you for contacting Corporate Rebels. We received your inquiry and a colleague will follow up with you.</p>",
      `<p><strong>Inquiry type:</strong> ${escapeHtml(context.persona)}</p>`,
      answerHtml,
      "<p>You can reply to this email if you would like to add anything.</p>",
      "<p>Corporate Rebels</p>",
      "</body></html>",
    ].join(""),
    text: [
      `Hi ${displayName},`,
      "",
      "Thank you for contacting Corporate Rebels. We received your inquiry and a colleague will follow up with you.",
      "",
      `Inquiry type: ${context.persona}`,
      ...(context.answer ? [`${context.answerLabel}: ${context.answer}`] : []),
      "",
      "You can reply to this email if you would like to add anything.",
      "",
      "Corporate Rebels",
    ].join("\n"),
  };
}

export async function sendCrmInquiryAcknowledgement(params: {
  workspaceId: string;
  conversationId: string;
}) {
  const ccRecipients = acknowledgementCcRecipients(env.CRM_INQUIRY_ACKNOWLEDGEMENT_CC_EMAIL);
  if (ccRecipients.length === 0) {
    throw new Error("CRM_INQUIRY_ACKNOWLEDGEMENT_CC_EMAIL is not configured.");
  }

  const conversation = await prisma.crmConversation.findFirst({
    where: {
      id: params.conversationId,
      workspaceId: params.workspaceId,
      source: CRM_INQUIRY_SOURCE,
    },
    select: {
      id: true,
      sourceExternalId: true,
      contact: {
        select: {
          email: true,
          name: true,
        },
      },
    },
  });
  if (!conversation?.contact?.email) {
    throw new Error("CRM inquiry acknowledgement target was not found.");
  }

  const inquiryEvent = await prisma.event.findFirst({
    where: {
      workspaceId: params.workspaceId,
      type: "crm.inquiry.captured",
      aggregateType: "CrmConversation",
      aggregateId: conversation.id,
    },
    select: { payload: true },
    orderBy: { createdAt: "asc" },
  });
  const content = acknowledgementContent(conversation.contact.name ?? "", inquiryContext(inquiryEvent?.payload));
  const result = await sendEmail({
    to: conversation.contact.email,
    cc: ccRecipients,
    subject: content.subject,
    html: content.html,
    text: content.text,
    idempotencyKey: `crm-inquiry-acknowledgement/${conversation.id}`,
    tracking: {
      emailType: "crm_inquiry_acknowledgement",
      workspaceId: params.workspaceId,
      metadata: {
        conversationId: conversation.id,
        sourceExternalId: conversation.sourceExternalId,
      },
    },
    trackingRequired: true,
  });
  if (result.status !== "SENT") {
    throw new Error(`CRM inquiry acknowledgement was skipped: ${result.reason}`);
  }

  await prisma.$transaction(async (tx) => {
    await appendEvents(tx, [{
      workspaceId: params.workspaceId,
      type: "crm.inquiry.acknowledgement_sent",
      aggregateType: "CrmConversation",
      aggregateId: conversation.id,
      payload: toInputJson({
        conversationId: conversation.id,
        providerMessageId: result.providerMessageId,
      }),
    }]);
  });

  return result;
}
