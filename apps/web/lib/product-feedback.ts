import { AppError, createAction, createWorkItemEvidenceLinks } from "@corgtex/domain";
import { env, prisma, type AppActor } from "@corgtex/shared";

export const PRODUCT_FEEDBACK_DEFAULT_TARGET_WORKSPACE_SLUG = "corgtex";
export const PRODUCT_FEEDBACK_EVIDENCE_PURPOSE = "feedback_context";
export const PRODUCT_FEEDBACK_MAX_MESSAGE_LENGTH = 4000;
export const PRODUCT_FEEDBACK_MAX_SCREENSHOTS = 5;
export const PRODUCT_FEEDBACK_MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
export const PRODUCT_FEEDBACK_MAX_TOTAL_SCREENSHOT_BYTES = 25 * 1024 * 1024;
export const PRODUCT_FEEDBACK_ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type ProductFeedbackTargetWorkspace = {
  id: string;
  slug: string;
  name: string;
};

export type ProductFeedbackScreenshotLike = {
  name: string;
  size: number;
  type: string;
};

export type ProductFeedbackContext = {
  locale?: string | null;
  pagePath?: string | null;
  pageTitle?: string | null;
  pageUrl?: string | null;
  sourceWorkspaceId: string;
  sourceWorkspaceName?: string | null;
  sourceWorkspaceSlug?: string | null;
  submittedAt: Date;
  submitterEmail: string;
  submitterName?: string | null;
  submitterUserId: string;
  viewportJson?: string | null;
};

function clip(value: string | null | undefined, maxLength: number) {
  const normalized = value?.replace(/\r\n/g, "\n").trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? normalized.slice(0, maxLength).trim() : normalized;
}

function singleLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function markdownLine(label: string, value: string | null | undefined) {
  return value ? `- ${label}: ${value}` : null;
}

export function productFeedbackAgentActor(targetWorkspaceId: string): AppActor {
  return {
    kind: "agent",
    authProvider: "bootstrap",
    label: "Corgtex Product Feedback",
    workspaceIds: [targetWorkspaceId],
    scopes: ["actions:write"],
  };
}

export async function getProductFeedbackTargetWorkspace(): Promise<ProductFeedbackTargetWorkspace | null> {
  const configuredId = env.PRODUCT_FEEDBACK_TARGET_WORKSPACE_ID;
  if (configuredId) {
    return prisma.workspace.findUnique({
      where: { id: configuredId },
      select: { id: true, slug: true, name: true },
    });
  }

  const configuredSlug = env.PRODUCT_FEEDBACK_TARGET_WORKSPACE_SLUG ?? PRODUCT_FEEDBACK_DEFAULT_TARGET_WORKSPACE_SLUG;
  return prisma.workspace.findUnique({
    where: { slug: configuredSlug },
    select: { id: true, slug: true, name: true },
  });
}

export async function requireProductFeedbackTargetWorkspace() {
  const target = await getProductFeedbackTargetWorkspace();
  if (!target) {
    throw new AppError(503, "PRODUCT_FEEDBACK_TARGET_NOT_CONFIGURED", "Product feedback target workspace is not configured.");
  }
  return target;
}

export function normalizeProductFeedbackMessage(message: string | null | undefined) {
  const normalized = clip(message, PRODUCT_FEEDBACK_MAX_MESSAGE_LENGTH + 1);
  if (!normalized) {
    throw new AppError(400, "INVALID_INPUT", "Feedback message is required.");
  }
  if (normalized.length > PRODUCT_FEEDBACK_MAX_MESSAGE_LENGTH) {
    throw new AppError(400, "INVALID_INPUT", "Feedback message is too long.");
  }
  return normalized;
}

export function parseProductFeedbackViewportJson(raw: string | null | undefined) {
  const normalized = clip(raw, 2000);
  if (!normalized) return null;

  try {
    const parsed = JSON.parse(normalized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Viewport JSON must be an object.");
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    throw new AppError(400, "INVALID_INPUT", "Viewport context must be valid JSON.");
  }
}

export function validateProductFeedbackScreenshots(files: readonly ProductFeedbackScreenshotLike[]) {
  if (files.length > PRODUCT_FEEDBACK_MAX_SCREENSHOTS) {
    throw new AppError(400, "INVALID_INPUT", "Too many screenshots attached.");
  }

  let totalBytes = 0;
  for (const file of files) {
    if (!PRODUCT_FEEDBACK_ALLOWED_IMAGE_TYPES.includes(file.type as typeof PRODUCT_FEEDBACK_ALLOWED_IMAGE_TYPES[number])) {
      throw new AppError(400, "INVALID_INPUT", "Screenshots must be PNG, JPEG, or WebP images.");
    }
    if (file.size > PRODUCT_FEEDBACK_MAX_SCREENSHOT_BYTES) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", "A screenshot is too large.");
    }
    totalBytes += file.size;
  }

  if (totalBytes > PRODUCT_FEEDBACK_MAX_TOTAL_SCREENSHOT_BYTES) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Screenshot attachments are too large.");
  }
}

export function buildProductFeedbackActionTitle(message: string) {
  const firstLine = singleLine(message.split("\n")[0] ?? message);
  const summary = firstLine.length > 90 ? `${firstLine.slice(0, 87).trim()}...` : firstLine;
  return `Product feedback: ${summary}`;
}

export function buildProductFeedbackActionBody(params: {
  context: ProductFeedbackContext;
  message: string;
  screenshotCount: number;
}) {
  const viewport = parseProductFeedbackViewportJson(params.context.viewportJson);
  const sourceWorkspaceLabel = [
    params.context.sourceWorkspaceName,
    params.context.sourceWorkspaceSlug ? `(${params.context.sourceWorkspaceSlug})` : null,
  ].filter(Boolean).join(" ") || params.context.sourceWorkspaceId;
  const submitterLabel = params.context.submitterName
    ? `${params.context.submitterName} <${params.context.submitterEmail}>`
    : params.context.submitterEmail;
  const contextLines = [
    markdownLine("Submitted by", submitterLabel),
    markdownLine("Submitter user ID", params.context.submitterUserId),
    markdownLine("Source workspace", sourceWorkspaceLabel),
    markdownLine("Source workspace ID", params.context.sourceWorkspaceId),
    markdownLine("Page", clip(params.context.pageTitle, 180)),
    markdownLine("Path", clip(params.context.pagePath, 300)),
    markdownLine("URL", clip(params.context.pageUrl, 600)),
    markdownLine("Locale", clip(params.context.locale, 12)),
    markdownLine("Screenshots", String(params.screenshotCount)),
    markdownLine("Submitted at", params.context.submittedAt.toISOString()),
  ].filter((line): line is string => Boolean(line));

  return [
    "## Feedback",
    "",
    params.message,
    "",
    "## Context",
    "",
    ...contextLines,
    ...(viewport ? ["", "```json", viewport, "```"] : []),
  ].join("\n");
}

export async function createProductFeedbackAction(params: {
  bodyMd: string;
  message: string;
  targetWorkspace: ProductFeedbackTargetWorkspace;
}) {
  return createAction(productFeedbackAgentActor(params.targetWorkspace.id), {
    workspaceId: params.targetWorkspace.id,
    title: buildProductFeedbackActionTitle(params.message),
    bodyMd: params.bodyMd,
    priority: 1,
    isPrivate: true,
  });
}

export async function linkProductFeedbackEvidence(params: {
  actionId: string;
  documentIds: string[];
  targetWorkspaceId: string;
}) {
  if (params.documentIds.length === 0) return [];

  return prisma.$transaction((tx) => createWorkItemEvidenceLinks(tx, {
    workspaceId: params.targetWorkspaceId,
    entityType: "Action",
    entityId: params.actionId,
    documentIds: params.documentIds,
    purpose: PRODUCT_FEEDBACK_EVIDENCE_PURPOSE,
  }));
}
