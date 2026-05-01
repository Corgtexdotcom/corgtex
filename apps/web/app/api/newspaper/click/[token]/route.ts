import { NextRequest, NextResponse } from "next/server";
import { AppError, recordNewspaperLinkClick } from "@corgtex/domain";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ token: string }>;
};

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { token } = await params;

  try {
    const result = await recordNewspaperLinkClick(token);
    return NextResponse.redirect(result.targetUrl, 302);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      return new NextResponse("Not found", { status: 404 });
    }
    throw error;
  }
}
