import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { changeUserPassword } from "@corgtex/domain";
import { resolveRequestActor, logoutAction } from "@/lib/auth";
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

    // Changing password invalidates all sessions including current one,
    // so we need to logout the user via cookies
    // This API route will just return 200, the client can then reload
    // Or we can let server actions handle it.

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
