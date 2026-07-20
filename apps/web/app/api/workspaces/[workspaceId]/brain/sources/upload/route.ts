import { NextRequest, NextResponse } from "next/server";
import { AppError } from "@corgtex/domain";
import type { DuplicateGuardOptions, DuplicateGuardResolution } from "@corgtex/domain";
import { ingestFile } from "@corgtex/knowledge";
import { resolveRequestActor } from "@/lib/auth";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { handleRouteError } from "@/lib/http";

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

const DUPLICATE_GUARD_RESOLUTIONS: DuplicateGuardResolution[] = [
  "use_existing",
  "update_existing",
  "create_new",
];

function duplicateGuardFromFormData(formData: FormData): DuplicateGuardOptions | undefined {
  const resolution = formString(formData, "duplicateResolution");
  if (!DUPLICATE_GUARD_RESOLUTIONS.includes(resolution as DuplicateGuardResolution)) {
    return undefined;
  }
  const targetEntityId = formString(formData, "duplicateTargetEntityId");
  return {
    resolution: resolution as DuplicateGuardResolution,
    targetEntityId: targetEntityId || null,
  };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await checkApiDemoGuard(workspaceId);
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
    const title = formString(formData, "title");
    const ingestionGuidanceMd = formString(formData, "ingestionGuidanceMd");
    const buffer = Buffer.from(await file.arrayBuffer());

    await ingestFile(actor, {
      workspaceId,
      fileBuffer: buffer,
      fileName: originalName,
      mimeType: file.type || "application/octet-stream",
      uploadSource: "brain-ui",
      documentTitle: title || originalName,
      ingestionGuidanceMd: ingestionGuidanceMd || undefined,
      duplicateGuard: duplicateGuardFromFormData(formData),
    });

    return NextResponse.redirect(new URL(`/workspaces/${workspaceId}/brain/sources`, request.url), 303);
  } catch (error) {
    return handleRouteError(error);
  }
}
