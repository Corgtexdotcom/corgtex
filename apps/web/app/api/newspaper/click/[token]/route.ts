import { NextRequest, NextResponse } from "next/server";
import { AppError, recordNewspaperLinkClick } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ token: string }>;
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { token } = await params;

  try {
    const actor = await resolveRequestActor(request);
    const result = await recordNewspaperLinkClick(actor, token);
    return NextResponse.redirect(result.targetUrl, 302);
  } catch (error) {
    if (error instanceof AppError && [401, 403, 404].includes(error.status)) {
      return new NextResponse("Not found", { status: 404 });
    }
    throw error;
  }
}
