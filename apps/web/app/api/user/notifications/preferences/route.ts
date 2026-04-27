import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getUserNotificationPreferences, updateNotificationPreference } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const updatePrefSchema = z.object({
  notifType: z.string().min(1),
  channel: z.enum(["IN_APP", "EMAIL", "BOTH", "OFF"]),
});

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const prefs = await getUserNotificationPreferences(actor);
    return NextResponse.json({ preferences: prefs });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const body = await validateBody(request, updatePrefSchema);

    const updated = await updateNotificationPreference(actor, body);
    return NextResponse.json(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}
