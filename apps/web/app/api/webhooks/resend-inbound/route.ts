import { NextRequest, NextResponse } from "next/server";
import { receiveEmailReply, syncEmailReplyToConversation } from "@corgtex/domain";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (payload.type !== "email.received" || !payload.data) {
      return NextResponse.json({ ok: true }); // Ignore non-inbound events
    }
    
    const { from, subject, text } = payload.data;
    
    if (!from || !text) {
      return NextResponse.json({ error: "Missing from or text" }, { status: 400 });
    }

    // Extract email from "Name <email@domain.com>" or "email@domain.com"
    const emailMatch = from.match(/<([^>]+)>/);
    const fromEmail = emailMatch ? emailMatch[1] : from;

    // Run both domain functions concurrently
    await Promise.all([
      receiveEmailReply({
        fromEmail,
        subject: subject || "No Subject",
        bodyText: text,
      }).catch(err => console.error("Error receiving email reply:", err)),
      
      syncEmailReplyToConversation({
        fromEmail,
        subject: subject || "No Subject",
        bodyText: text,
      }).catch(err => console.error("Error syncing conversation:", err)),
    ]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[resend-inbound] Error processing webhook:", error);
    // Return 200 anyway so Resend doesn't retry infinitely on domain logic failures
    return NextResponse.json({ ok: true, error: "Internal processing error" });
  }
}
