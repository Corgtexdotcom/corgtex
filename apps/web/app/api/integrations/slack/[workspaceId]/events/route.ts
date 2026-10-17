import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { ingestCommunicationEvent, captureSlackSignedIngress, verifySlackWorkspaceInstallation } from "@corgtex/domain";

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await context.params;
    const rawBody = await request.text();
    const signedIngress = captureSlackSignedIngress(rawBody, request.headers, workspaceId);
    const payload = JSON.parse(rawBody) as Record<string, unknown>;

    if (payload.type === "url_verification" && typeof payload.challenge === "string") {
      return new Response(payload.challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    await verifySlackWorkspaceInstallation(workspaceId, payload);
    await ingestCommunicationEvent("SLACK", payload, signedIngress);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
