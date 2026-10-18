import { NextRequest, NextResponse } from "next/server";
import { AppError, recordNewspaperLinkClick } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { newspaperClickContinuation } from "@/lib/newspaper-click-continuation";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ token: string }>;
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { token } = await params;

  let actor;
  try {
    actor = await resolveRequestActor(request);
  } catch (error) {
    if (error instanceof AppError && error.status === 401) {
      const next = newspaperClickContinuation(`/api/newspaper/click/${token}`);
      if (next) {
        const login = new URL("/login", request.url);
        login.searchParams.set("next", next);
        return NextResponse.redirect(login, 302);
      }
    }
    if (error instanceof AppError && [401, 403, 404].includes(error.status)) {
      return new NextResponse("Not found", { status: 404 });
    }
    throw error;
  }

  try {
    const result = await recordNewspaperLinkClick(actor, token);
    return NextResponse.redirect(result.targetUrl, 302);
  } catch (error) {
    if (error instanceof AppError && [401, 403, 404].includes(error.status)) {
      return new NextResponse("Not found", { status: 404 });
    }
    throw error;
  }
}
