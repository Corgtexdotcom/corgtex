import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { createGoal, getWorkspacePermanentPathForEntity, listGoals } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";
import { serializeGoalWorkItem } from "@/lib/work-item-api";
import type { GoalCadence, GoalLevel, GoalStatus } from "@prisma/client";

function optionalDate(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? new Date(value) : undefined;
}

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId, actor } = sessionCtx;
    const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "GOALS");
    if (disabled) return disabled;

    const take = parseInt(request.nextUrl.searchParams.get("take") || "20", 10);
    const skip = parseInt(request.nextUrl.searchParams.get("skip") || "0", 10);
    const cadence = request.nextUrl.searchParams.get("cadence") as GoalCadence | null;
    const level = request.nextUrl.searchParams.get("level") as GoalLevel | null;
    const status = request.nextUrl.searchParams.get("status") as GoalStatus | null;

    const goals = await listGoals(actor, {
      workspaceId,
      take,
      skip,
      cadence: cadence ?? undefined,
      level: level ?? undefined,
      status: status ?? undefined,
    });

    const simplified = goals.map((goal) => {
      const item = serializeGoalWorkItem(goal);
      return {
        id: goal.id,
        title: goal.title,
        descriptionMd: goal.descriptionMd,
        cadence: goal.cadence,
        level: goal.level,
        status: goal.status,
        progressPercent: goal.progressPercent,
        startDate: goal.startDate,
        targetDate: goal.targetDate,
        circle: goal.circle?.name ?? null,
        ownerMemberId: item.ownerMemberId,
        ownerMemberName: item.ownerMemberName,
        owner: item.owner,
        keyResults: goal.keyResults.map((keyResult) => ({
          id: keyResult.id,
          title: keyResult.title,
          targetValue: keyResult.targetValue,
          currentValue: keyResult.currentValue,
          unit: keyResult.unit,
          progressPercent: keyResult.progressPercent,
        })),
        createdAt: goal.createdAt,
      };
    });

    return NextResponse.json({ items: simplified, total: simplified.length });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "write");
    const { workspaceId, actor } = sessionCtx;
    const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "GOALS");
    if (disabled) return disabled;

    const body = await request.json();

    if (!body.title) {
      return NextResponse.json({ error: "Missing required fields (title)" }, { status: 400 });
    }

    const goal = await createGoal(actor, {
      workspaceId,
      title: body.title,
      descriptionMd: body.descriptionMd,
      cadence: body.cadence as GoalCadence | undefined,
      level: body.level as GoalLevel | undefined,
      status: body.status as GoalStatus | undefined,
      startDate: optionalDate(body.startDate),
      targetDate: optionalDate(body.targetDate),
      parentGoalId: body.parentGoalId ?? null,
      circleId: body.circleId ?? null,
      ownerMemberId: body.ownerMemberId ?? null,
      keyResults: Array.isArray(body.keyResults) ? body.keyResults : undefined,
    });

    const origin = env.APP_URL.replace(/\/$/, "");
    const permanentPath = await getWorkspacePermanentPathForEntity({
      workspaceId,
      entityType: "Goal",
      entityId: goal.id,
    });

    const item = serializeGoalWorkItem(goal);

    return NextResponse.json({
      id: goal.id,
      title: goal.title,
      status: goal.status,
      ownerMemberId: item.ownerMemberId,
      ownerMemberName: item.ownerMemberName,
      webUrl: `${origin}/workspaces/${workspaceId}/goals?view=tree&cadence=${goal.cadence}&goalId=${goal.id}`,
      permanentUrl: permanentPath ? `${origin}${permanentPath}` : null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
