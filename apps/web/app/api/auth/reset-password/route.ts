import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consumePasswordReset } from "@corgtex/domain";
import { handleRouteError, validateBody } from "@/lib/http";

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export async function POST(request: NextRequest) {
  try {
    const body = await validateBody(request, resetPasswordSchema);

    const result = await consumePasswordReset({
      token: body.token,
      newPassword: body.password,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
