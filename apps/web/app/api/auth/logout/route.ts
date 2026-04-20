import { NextRequest, NextResponse } from "next/server";
import { clearSession } from "@corgtex/domain";
import { sessionCookieName } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const token = request.cookies.get(sessionCookieName())?.value;
    if (token) {
      await clearSession(token);
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.delete(sessionCookieName());
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
