import { NextResponse } from "next/server";
import { AppError, addBuildArtifactAsset } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

function asAssetKind(value: FormDataEntryValue | null) {
  const kind = typeof value === "string" ? value : "";
  return kind === "SCREENSHOT" || kind === "VIDEO" || kind === "DOCUMENT" || kind === "LOG" || kind === "OTHER"
    ? kind
    : "SCREENSHOT";
}

function asOptionalString(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asOptionalNumber(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "BUILD_ARTIFACTS");
  if (disabled) return disabled;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw new AppError(400, "INVALID_INPUT", "Must be multipart/form-data.");
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new AppError(400, "INVALID_INPUT", "file is required.");
  }

  const result = await addBuildArtifactAsset(actor, {
    workspaceId,
    artifactId: params.artifactId,
    fileBuffer: Buffer.from(await file.arrayBuffer()),
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    kind: asAssetKind(formData.get("kind")),
    label: asOptionalString(formData.get("label")),
    captionMd: asOptionalString(formData.get("captionMd")),
    sortOrder: asOptionalNumber(formData.get("sortOrder")),
    width: asOptionalNumber(formData.get("width")),
    height: asOptionalNumber(formData.get("height")),
  });

  return NextResponse.json(result, { status: 201 });
});
