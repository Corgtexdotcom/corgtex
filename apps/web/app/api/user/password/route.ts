import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { changeUserPassword } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const body = await validateBody(request, passwordSchema);

    await changeUserPassword(actor, body);

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
