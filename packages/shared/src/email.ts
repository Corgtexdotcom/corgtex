import { env } from "./env";
import { Resend } from "resend";

export type EmailSendResult =
  | { status: "SENT"; providerMessageId: string | null }
  | { status: "SKIPPED"; reason: string };

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<EmailSendResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not set — skipping email send. Would have sent to:", params.to);
    console.warn("[email] Subject:", params.subject);
    return { status: "SKIPPED", reason: "RESEND_API_KEY missing" };
  }

  const resend = new Resend(apiKey);
  const replyTo = params.replyTo ?? env.EMAIL_REPLY_TO;

  const { data, error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to: params.to,
    subject: params.subject,
    html: params.html,
    ...(replyTo ? { reply_to: replyTo } : {}),
  });

  if (error) {
    console.error("[email] Resend API error:", error);
    throw new Error(`Email send failed: ${error.message}`);
  }

  return { status: "SENT", providerMessageId: data?.id ?? null };
}
