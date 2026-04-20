import { NextRequest, NextResponse } from "next/server";
import { consumePasswordReset } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { token?: unknown; password?: unknown };

    const result = await consumePasswordReset({
      token: String(body.token ?? ""),
      newPassword: String(body.password ?? ""),
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
