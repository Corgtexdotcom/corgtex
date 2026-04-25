import type { BrainArticleAuthority, BrainArticleType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { createArticle, listArticles } from "@corgtex/domain";
import type { ArchiveFilter } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const url = new URL(request.url);
    const type = url.searchParams.get("type") as BrainArticleType | null;
    const authority = url.searchParams.get("authority") as BrainArticleAuthority | null;
    const stale = url.searchParams.get("stale") === "true";
    const take = Number(url.searchParams.get("take")) || undefined;
    const skip = Number(url.searchParams.get("skip")) || undefined;
    const archiveFilter = url.searchParams.get("archiveFilter") as ArchiveFilter | null;

    const result = await listArticles(actor, {
      workspaceId,
      type: type ?? undefined,
      authority: authority ?? undefined,
      stale: stale || undefined,
      take,
      skip,
      archiveFilter: archiveFilter ?? undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const article = await createArticle(actor, {
      workspaceId,
      slug: typeof body.slug === "string" ? body.slug : undefined,
      title: String(body.title ?? ""),
      type: String(body.type ?? "GLOSSARY") as BrainArticleType,
      authority: typeof body.authority === "string" ? (body.authority as BrainArticleAuthority) : undefined,
      bodyMd: String(body.bodyMd ?? ""),
      frontmatterJson: body.frontmatterJson && typeof body.frontmatterJson === "object" ? body.frontmatterJson : undefined,
      ownerMemberId: typeof body.ownerMemberId === "string" ? body.ownerMemberId : null,
      staleAfterDays: typeof body.staleAfterDays === "number" ? body.staleAfterDays : undefined,
      sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds.map(String) : undefined,
    });
    return NextResponse.json({ article }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
