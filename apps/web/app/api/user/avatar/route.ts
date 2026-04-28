import { NextRequest, NextResponse } from "next/server";
import { processAvatarUpload, updateUserProfile, AppError } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const contentType = request.headers.get("content-type") ?? "";

    if (!contentType.includes("multipart/form-data")) {
      throw new AppError(400, "INVALID_INPUT", "Must use multipart/form-data");
    }

    const formData = await request.formData();
    const fileEntry = formData.get("file");

    if (!(fileEntry instanceof File) || fileEntry.size === 0) {
      throw new AppError(400, "INVALID_INPUT", "Image file is required.");
    }

    const buffer = Buffer.from(await fileEntry.arrayBuffer());
    const avatarUrl = await processAvatarUpload(buffer);

    const updated = await updateUserProfile(actor, { avatarUrl });
    return NextResponse.json(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const updated = await updateUserProfile(actor, { avatarUrl: null });
    return NextResponse.json(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}
