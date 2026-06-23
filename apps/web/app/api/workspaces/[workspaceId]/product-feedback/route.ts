import { NextRequest, NextResponse } from "next/server";
import { AppError } from "@corgtex/domain";
import { checkRateLimit, prisma, RATE_LIMITS } from "@corgtex/shared";
import { ingestFile } from "@corgtex/knowledge";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import {
  buildProductFeedbackActionBody,
  buildProductFeedbackActionTitle,
  createProductFeedbackAction,
  linkProductFeedbackEvidence,
  normalizeProductFeedbackMessage,
  productFeedbackAgentActor,
  requireProductFeedbackTargetWorkspace,
  validateProductFeedbackScreenshots,
} from "@/lib/product-feedback";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : null;
}

function screenshotFiles(formData: FormData) {
  return formData.getAll("screenshots").flatMap((entry) => {
    if (entry instanceof File) {
      return entry.size > 0 ? [entry] : [];
    }
    if (typeof entry === "string" && entry.trim().length === 0) {
      return [];
    }
    throw new AppError(400, "INVALID_INPUT", "Screenshots must be uploaded files.");
  });
}

async function uploadFeedbackScreenshot(params: {
  file: File;
  index: number;
  targetWorkspaceId: string;
  sourceWorkspaceId: string;
  actionTitle: string;
}) {
  const buffer = Buffer.from(await params.file.arrayBuffer());
  const actor = productFeedbackAgentActor(params.targetWorkspaceId);
  const result = await ingestFile(actor, {
    workspaceId: params.targetWorkspaceId,
    fileBuffer: buffer,
    fileName: params.file.name || `feedback-screenshot-${params.index + 1}.png`,
    mimeType: params.file.type,
    uploadSource: "product-feedback",
    documentTitle: `Product feedback screenshot ${params.index + 1}`,
    ingestionGuidanceMd: `Screenshot context for internal product feedback action: ${params.actionTitle}.`,
    documentMetadata: {
      feedbackSource: "product-feedback-widget",
      sourceWorkspaceId: params.sourceWorkspaceId,
      screenshotIndex: params.index + 1,
      size: params.file.size,
    },
  });
  return result.document.id;
}

export const POST = withWorkspaceRoute(async (request: NextRequest, { actor, workspaceId }) => {
  if (actor.kind !== "user") {
    throw new AppError(403, "FORBIDDEN", "Only signed-in users can submit product feedback.");
  }

  await checkApiDemoGuard(workspaceId);

  const rateLimit = await checkRateLimit(
    `ws:${workspaceId}:user:${actor.user.id}:product-feedback`,
    RATE_LIMITS.PRODUCT_FEEDBACK_PER_USER,
  );
  if (!rateLimit.allowed) {
    throw new AppError(429, "RATE_LIMITED", "Product feedback rate limit exceeded.");
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw new AppError(400, "INVALID_INPUT", "Feedback submissions must use multipart form data.");
  }

  const targetWorkspace = await requireProductFeedbackTargetWorkspace();
  const sourceWorkspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, slug: true, name: true },
  }).catch(() => null);
  const formData = await request.formData();
  const screenshots = screenshotFiles(formData);
  validateProductFeedbackScreenshots(screenshots);

  const message = normalizeProductFeedbackMessage(formString(formData, "message"));
  const submittedAt = new Date();
  const bodyMd = buildProductFeedbackActionBody({
    message,
    screenshotCount: screenshots.length,
    context: {
      sourceWorkspaceId: workspaceId,
      sourceWorkspaceName: sourceWorkspace?.name ?? null,
      sourceWorkspaceSlug: sourceWorkspace?.slug ?? null,
      submitterEmail: actor.user.email,
      submitterName: actor.user.displayName,
      submitterUserId: actor.user.id,
      submittedAt,
      locale: formString(formData, "locale"),
      pagePath: formString(formData, "path"),
      pageTitle: formString(formData, "title"),
      pageUrl: formString(formData, "url"),
      viewportJson: formString(formData, "viewport_json"),
    },
  });
  const actionTitle = buildProductFeedbackActionTitle(message);
  const documentIds = await Promise.all(screenshots.map((file, index) => uploadFeedbackScreenshot({
    file,
    index,
    targetWorkspaceId: targetWorkspace.id,
    sourceWorkspaceId: workspaceId,
    actionTitle,
  })));
  const action = await createProductFeedbackAction({
    targetWorkspace,
    message,
    bodyMd,
  });
  await linkProductFeedbackEvidence({
    targetWorkspaceId: targetWorkspace.id,
    actionId: action.id,
    documentIds,
  });

  return NextResponse.json({
    ok: true,
    actionId: action.id,
    actionUrl: `/workspaces/${targetWorkspace.id}/actions/${action.id}`,
    targetWorkspaceId: targetWorkspace.id,
    screenshotCount: screenshots.length,
  }, { status: 201 });
});
