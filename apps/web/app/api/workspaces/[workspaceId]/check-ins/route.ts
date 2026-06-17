import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@corgtex/shared";
import { requireWorkspaceMembership, respondToCheckIn, skipCompanyUnderstandingQuestion, startCompanyUnderstandingQuestionConversation } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

const DEFAULT_CHECK_INS_TAKE = 50;
const MAX_CHECK_INS_TAKE = 100;

function boundedTake(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CHECK_INS_TAKE;
  return Math.min(Math.max(parsed, 1), MAX_CHECK_INS_TAKE);
}

function optionalCursor(value: string | null) {
  const trimmed = value?.trim();
  return trimmed || null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    
    // Ensure membership and get the memberId
    const membership = await requireWorkspaceMembership({ actor, workspaceId });

    // Agent actors get null membership (by design) — they don't have personal check-ins
    if (!membership) {
      return NextResponse.json({ checkIns: [], nextCursor: null });
    }

    const take = boundedTake(request.nextUrl.searchParams.get("take"));
    const cursor = optionalCursor(request.nextUrl.searchParams.get("cursor"));

    // Return the member's check-ins
    const checkIns = await prisma.checkIn.findMany({
      where: {
        workspaceId,
        memberId: membership.id,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const page = checkIns.slice(0, take);
    const nextCursor = checkIns.length > take ? page.at(-1)?.id ?? null : null;

    return NextResponse.json({ checkIns: page, nextCursor });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await request.json();

    const action = String(body.action ?? "answer");
    const checkInId = String(body.checkInId ?? "");
    if (action === "start_company_understanding_conversation") {
      const conversation = await startCompanyUnderstandingQuestionConversation(actor, {
        workspaceId,
        checkInId,
      });
      return NextResponse.json({ conversation });
    }

    if (action === "skip_company_understanding") {
      const checkIn = await skipCompanyUnderstandingQuestion(actor, {
        workspaceId,
        checkInId,
      });
      return NextResponse.json({ checkIn });
    }

    const responseMd = String(body.responseMd ?? "");
    const sentiment = typeof body.sentiment === "string" ? body.sentiment : undefined;
    const relatedConversationId = typeof body.relatedConversationId === "string" ? body.relatedConversationId : null;

    const checkIn = await respondToCheckIn(actor, {
      workspaceId,
      checkInId,
      responseMd,
      sentiment,
      relatedConversationId,
    });

    return NextResponse.json({ checkIn });
  } catch (error) {
    return handleRouteError(error);
  }
}
