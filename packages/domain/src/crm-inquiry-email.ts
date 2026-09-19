import { env, prisma, sendEmail, toInputJson } from "@corgtex/shared";
import { appendEvents } from "./events";

export const CRM_INQUIRY_ACKNOWLEDGEMENT_JOB_TYPE = "email.crm-inquiry-acknowledgement";
const CRM_INQUIRY_SOURCE = "corporate_rebels_website";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function acknowledgementContent(name: string) {
  const displayName = name.trim() || "there";
  return {
    subject: "We received your Corporate Rebels inquiry",
    html: [
      "<!doctype html>",
      '<html><body style="font-family:Arial,sans-serif;color:#1f1d1a;line-height:1.6;">',
      `<p>Hi ${escapeHtml(displayName)},</p>`,
      "<p>Thank you for contacting Corporate Rebels. We received your inquiry and a colleague will follow up with you.</p>",
      "<p>You can reply to this email if you would like to add anything.</p>",
      "<p>Corporate Rebels</p>",
      "</body></html>",
    ].join(""),
    text: [
      `Hi ${displayName},`,
      "",
      "Thank you for contacting Corporate Rebels. We received your inquiry and a colleague will follow up with you.",
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
  const ccEmail = env.CRM_INQUIRY_ACKNOWLEDGEMENT_CC_EMAIL;
  if (!ccEmail) {
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

  const content = acknowledgementContent(conversation.contact.name ?? "");
  const result = await sendEmail({
    to: conversation.contact.email,
    cc: ccEmail,
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
