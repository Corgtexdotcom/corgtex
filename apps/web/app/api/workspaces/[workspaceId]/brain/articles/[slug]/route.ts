import type { BrainArticleAuthority, BrainArticleType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { deleteArticle, getArticle, updateArticle } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type RouteParams = { params: Promise<{ workspaceId: string; slug: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, slug } = await params;
    const article = await getArticle(actor, { workspaceId, slug });
    return NextResponse.json({ article });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, slug } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const article = await updateArticle(actor, {
      workspaceId,
      slug,
      title: typeof body.title === "string" ? body.title : undefined,
      type: typeof body.type === "string" ? (body.type as BrainArticleType) : undefined,
      authority: typeof body.authority === "string" ? (body.authority as BrainArticleAuthority) : undefined,
      bodyMd: typeof body.bodyMd === "string" ? body.bodyMd : undefined,
      frontmatterJson: body.frontmatterJson && typeof body.frontmatterJson === "object" ? body.frontmatterJson : undefined,
      ownerMemberId: body.ownerMemberId === null ? null : typeof body.ownerMemberId === "string" ? body.ownerMemberId : undefined,
      staleAfterDays: typeof body.staleAfterDays === "number" ? body.staleAfterDays : undefined,
      sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds.map(String) : undefined,
      changeSummary: typeof body.changeSummary === "string" ? body.changeSummary : undefined,
    });
    return NextResponse.json({ article });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, slug } = await params;
    const result = await deleteArticle(actor, { workspaceId, slug });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
