import { NextRequest, NextResponse } from "next/server";
import { AppError, requireWorkspaceMembership } from "@corgtex/domain";
import { ingestFile } from "@corgtex/knowledge";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const contentType = request.headers.get("content-type") ?? "";

    if (!contentType.includes("multipart/form-data")) {
        throw new AppError(400, "INVALID_INPUT", "Must be multipart/form-data");
    }

    const formData = await request.formData();
    const fileEntry = formData.get("file");

    if (!(fileEntry instanceof File) || fileEntry.size === 0) {
      throw new AppError(400, "INVALID_INPUT", "file is required.");
    }

    const file = fileEntry;
    const originalName = file.name.trim();
    const buffer = Buffer.from(await file.arrayBuffer());

    await ingestFile(actor, {
      workspaceId,
      fileBuffer: buffer,
      fileName: originalName,
      mimeType: file.type || "application/octet-stream",
      uploadSource: "brain-ui",
    });

    return NextResponse.redirect(new URL(`/workspaces/${workspaceId}/brain/sources`, request.url), 303);
  } catch (error) {
    return handleRouteError(error);
  }
}
