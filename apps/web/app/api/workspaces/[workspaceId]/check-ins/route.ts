import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@corgtex/shared";
import { requireWorkspaceMembership, respondToCheckIn } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    
    // Ensure membership and get the memberId
    const membership = await requireWorkspaceMembership({ actor, workspaceId });

    // Agent actors get null membership (by design) — they don't have personal check-ins
    if (!membership) {
      return NextResponse.json({ checkIns: [] });
    }

    // Return the member's check-ins
    const checkIns = await prisma.checkIn.findMany({
      where: {
        workspaceId,
        memberId: membership.id,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ checkIns });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await request.json();

    const checkInId = String(body.checkInId ?? "");
    const responseMd = String(body.responseMd ?? "");
    const sentiment = typeof body.sentiment === "string" ? body.sentiment : undefined;

    const checkIn = await respondToCheckIn(actor, {
      workspaceId,
      checkInId,
      responseMd,
      sentiment,
    });

    return NextResponse.json({ checkIn });
  } catch (error) {
    return handleRouteError(error);
  }
}
