import { NextRequest, NextResponse } from "next/server";
import { listUserSessions, revokeUserSession, revokeAllOtherSessions } from "@corgtex/domain";
import { sessionCookieName } from "@corgtex/shared";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { sha256 } from "@corgtex/shared";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const token = request.cookies.get(sessionCookieName())?.value;
    const tokenHash = token ? sha256(token) : undefined;

    const sessions = await listUserSessions(actor, tokenHash);
    return NextResponse.json({ sessions });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");
    const revokeAllOther = url.searchParams.get("revokeAllOther") === "true";

    if (revokeAllOther) {
      const token = request.cookies.get(sessionCookieName())?.value;
      if (!token) return NextResponse.json({ success: false }, { status: 400 });
      await revokeAllOtherSessions(actor, sha256(token));
    } else if (sessionId) {
      await revokeUserSession(actor, sessionId);
    } else {
      return NextResponse.json({ success: false, error: "Must specify sessionId or revokeAllOther=true" }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
