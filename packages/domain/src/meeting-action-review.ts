import { env, prisma, toInputJson, type AppActor } from "@corgtex/shared";
import { createAction, publishAction } from "./actions";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

export const SLACK_MEETING_ACTION_REVIEW_FLAG = "SLACK_MEETING_ACTION_REVIEW";
export const DEFAULT_WEEKLY_PROGRESS_REVIEW_SERIES_EXTERNAL_ID = "ops:weekly-progress-review";
export const SLACK_MEETING_ACTION_REVIEW_EDIT_CALLBACK_ID = "corgtex_meeting_review_edit_modal";

const DEFAULT_REVIEW_EXPIRY_HOURS = 48;
const DEFAULT_REVIEW_TIMEZONE = "America/Los_Angeles";
const DEFAULT_MAX_PROPOSALS = 5;
const MAX_PROPOSALS = 5;
const SLACK_SECTION_LIMIT = 2900;
const SLACK_BLOCK_LIMIT = 50;

type JsonRecord = Record<string, unknown>;

export type SlackMeetingActionReviewConfig = {
  meetingSeriesExternalId: string;
  installationId: string | null;
  channelId: string;
  threadTs: string | null;
  maxProposals: number;
  expiresAfterHours: number;
  timezone: string;
};

type MeetingForReview = {
  id: string;
  workspaceId: string;
  title: string | null;
  summaryMd: string | null;
  summaryPostedAt?: Date | null;
  recordedAt: Date;
  seriesId: string | null;
  series: { externalId: string | null } | null;
};

type ReviewInsight = {
  id: string;
  title: string;
  bodyMd: string;
  assigneeHint: string | null;
  dueAt: Date | null;
  confidence: number | null;
  sourceQuote: string | null;
  status: string;
  appliedEntityId?: string | null;
};

type ReviewMessage = {
  text: string;
  mainBlocks: unknown[];
  overflowBlocks: unknown[][];
};

export type SlackMeetingActionReviewPostPreparation =
  | null
  | {
    configured: true;
    skipped: true;
    reason: string;
  }
  | {
    configured: true;
    skipped: false;
    workspaceId: string;
    meetingId: string;
    installationId: string;
    channelId: string;
    threadTs: string | null;
    reviewId: string;
    message: ReviewMessage;
  };

export type SlackMeetingActionReviewUpdate = {
  channelId: string;
  messageTs: string;
  blocks: unknown[];
  text: string;
  responseText: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberValue(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseSlackMeetingActionReviewConfig(raw: unknown): SlackMeetingActionReviewConfig | null {
  if (!isRecord(raw)) return null;

  const meetingSeriesExternalId = stringValue(raw, ["meetingSeriesExternalId", "seriesExternalId", "meetingSeriesId"])
    ?? DEFAULT_WEEKLY_PROGRESS_REVIEW_SERIES_EXTERNAL_ID;
  const channelId = stringValue(raw, ["channelId", "approvedChannelId", "slackChannelId"]);
  if (!channelId) return null;

  return {
    meetingSeriesExternalId,
    installationId: stringValue(raw, ["installationId", "slackInstallationId"]),
    channelId,
    threadTs: stringValue(raw, ["threadTs", "approvedThreadTs", "slackThreadTs"]),
    maxProposals: clampInteger(numberValue(raw, ["maxProposals", "maxActionProposals"]) ?? DEFAULT_MAX_PROPOSALS, 1, MAX_PROPOSALS),
    expiresAfterHours: clampInteger(numberValue(raw, ["expiresAfterHours", "expiryHours"]) ?? DEFAULT_REVIEW_EXPIRY_HOURS, 1, 168),
    timezone: stringValue(raw, ["timezone", "timeZone"]) ?? DEFAULT_REVIEW_TIMEZONE,
  };
}

export async function slackMeetingActionReviewConfigForMeeting(
  workspaceId: string,
  meeting: { series: { externalId: string | null } | null },
): Promise<SlackMeetingActionReviewConfig | null> {
  const flag = await prisma.workspaceFeatureFlag.findUnique({
    where: { workspaceId_flag: { workspaceId, flag: SLACK_MEETING_ACTION_REVIEW_FLAG } },
    select: { enabled: true, config: true },
  });
  if (!flag?.enabled) return null;

  const config = parseSlackMeetingActionReviewConfig(flag.config);
  if (!config) return null;
  if (meeting.series?.externalId !== config.meetingSeriesExternalId) return null;
  return config;
}

export async function shouldBypassAutoApplyForSlackMeetingActionReview(params: {
  workspaceId: string;
  meetingId: string;
}) {
  const meeting = await prisma.meeting.findFirst({
    where: { id: params.meetingId, workspaceId: params.workspaceId },
    select: { series: { select: { externalId: true } } },
  });
  if (!meeting) return false;
  return Boolean(await slackMeetingActionReviewConfigForMeeting(params.workspaceId, meeting));
}

async function resolveReviewInstallation(workspaceId: string, config: SlackMeetingActionReviewConfig) {
  return prisma.communicationInstallation.findFirst({
    where: {
      workspaceId,
      provider: "SLACK",
      status: "ACTIVE",
      ...(config.installationId ? { id: config.installationId } : {}),
    },
    select: { id: true },
  });
}

export async function listMeetingFollowUpProposals(params: {
  workspaceId: string;
  meetingId: string;
  maxProposals?: number;
  includeReviewed?: boolean;
}) {
  return prisma.meetingInsight.findMany({
    where: {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      type: "ACTION_ITEM",
      operation: "CREATE",
      status: { in: params.includeReviewed ? ["SUGGESTED", "CONFIRMED", "APPLIED", "DISMISSED"] : ["SUGGESTED", "CONFIRMED"] },
    },
    orderBy: [
      { confidence: "desc" },
      { createdAt: "asc" },
    ],
    take: params.maxProposals ?? DEFAULT_MAX_PROPOSALS,
    select: {
      id: true,
      title: true,
      bodyMd: true,
      assigneeHint: true,
      dueAt: true,
      confidence: true,
      sourceQuote: true,
      status: true,
      appliedEntityId: true,
    },
  });
}

async function reviewExpiresAt(meeting: Pick<MeetingForReview, "workspaceId" | "seriesId" | "recordedAt">, expiresAfterHours: number) {
  const timeExpiry = new Date(Date.now() + expiresAfterHours * 60 * 60 * 1000);
  if (!meeting.seriesId) return timeExpiry;

  const nextMeeting = await prisma.meeting.findFirst({
    where: {
      workspaceId: meeting.workspaceId,
      seriesId: meeting.seriesId,
      archivedAt: null,
      recordedAt: { gt: meeting.recordedAt },
    },
    orderBy: { recordedAt: "asc" },
    select: { recordedAt: true },
  });
  if (nextMeeting?.recordedAt && nextMeeting.recordedAt < timeExpiry) {
    return nextMeeting.recordedAt;
  }
  return timeExpiry;
}

export async function prepareSlackMeetingActionReviewPost(params: {
  workspaceId: string;
  meetingId: string;
}): Promise<SlackMeetingActionReviewPostPreparation> {
  const meeting = await prisma.meeting.findFirst({
    where: { id: params.meetingId, workspaceId: params.workspaceId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      summaryMd: true,
      summaryPostedAt: true,
      recordedAt: true,
      seriesId: true,
      series: { select: { externalId: true } },
    },
  });
  if (!meeting) return null;

  const config = await slackMeetingActionReviewConfigForMeeting(params.workspaceId, meeting);
  if (!config) return null;

  if (!meeting.summaryMd || meeting.summaryPostedAt) {
    return { configured: true, skipped: true, reason: "summary_review_not_ready" };
  }

  const installation = await resolveReviewInstallation(params.workspaceId, config);
  if (!installation) {
    return { configured: true, skipped: true, reason: "slack_not_connected" };
  }

  const existingReview = await prisma.meetingFollowUpReview.findUnique({
    where: { meetingId: meeting.id },
    select: { id: true, messageTs: true },
  });
  if (existingReview?.messageTs) {
    return { configured: true, skipped: true, reason: "review_already_posted" };
  }

  const expiresAt = await reviewExpiresAt(meeting, config.expiresAfterHours);
  const review = await prisma.meetingFollowUpReview.upsert({
    where: { meetingId: meeting.id },
    update: {
      workspaceId: params.workspaceId,
      installationId: installation.id,
      provider: "SLACK",
      channelId: config.channelId,
      threadTs: config.threadTs,
      status: "OPEN",
      expiresAt,
      closedAt: null,
    },
    create: {
      workspaceId: params.workspaceId,
      meetingId: meeting.id,
      installationId: installation.id,
      provider: "SLACK",
      channelId: config.channelId,
      threadTs: config.threadTs,
      status: "OPEN",
      expiresAt,
    },
    select: { id: true },
  });
  const insights = await listMeetingFollowUpProposals({
    workspaceId: params.workspaceId,
    meetingId: meeting.id,
    maxProposals: config.maxProposals,
  });

  return {
    configured: true,
    skipped: false,
    workspaceId: params.workspaceId,
    meetingId: meeting.id,
    installationId: installation.id,
    channelId: config.channelId,
    threadTs: config.threadTs,
    reviewId: review.id,
    message: buildSlackMeetingActionReviewMessage({
      meeting,
      reviewId: review.id,
      insights,
      expiresAt,
      timezone: config.timezone,
      maxProposals: config.maxProposals,
    }),
  };
}

function appUrl(path = "") {
  return `${env.APP_URL.replace(/\/$/, "")}${path}`;
}

function meetingUrl(workspaceId: string, meetingId: string) {
  return appUrl(`/workspaces/${workspaceId}/meetings/${meetingId}`);
}

function insightUrl(workspaceId: string, meetingId: string, insightId: string) {
  return `${meetingUrl(workspaceId, meetingId)}?insight=${encodeURIComponent(insightId)}`;
}

function truncate(text: string, max = SLACK_SECTION_LIMIT) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function plainText(text: string, max = 140) {
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

function slackText(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function splitSlackText(text: string, max = SLACK_SECTION_LIMIT) {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    const piece = paragraph.trim();
    if (!piece) continue;
    if (piece.length > max) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let index = 0; index < piece.length; index += max) {
        chunks.push(piece.slice(index, index + max));
      }
      continue;
    }
    const next = current ? `${current}\n\n${piece}` : piece;
    if (next.length > max) {
      if (current) chunks.push(current);
      current = piece;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : ["Summary is not available yet."];
}

function formatDate(date: Date | null | undefined, timezone: string) {
  if (!date) return "_Not set_";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: timezone,
  }).format(date);
}

function formatDateTime(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(date);
}

function confidenceLabel(confidence: number | null) {
  return typeof confidence === "number" && Number.isFinite(confidence)
    ? `${Math.round(confidence * 100)}%`
    : "_Unknown_";
}

function insightStatusLabel(status: string) {
  if (status === "APPLIED") return "Confirmed";
  if (status === "DISMISSED") return "Dismissed";
  if (status === "CONFIRMED") return "Ready";
  return "Proposed";
}

function reviewActionValue(reviewId: string, insightId: string) {
  return JSON.stringify({ reviewId, insightId });
}

function buildProposalBlocks(params: {
  workspaceId: string;
  meetingId: string;
  reviewId: string;
  insights: ReviewInsight[];
  timezone: string;
  maxProposals: number;
}) {
  if (params.insights.length === 0) {
    return [{
      type: "section",
      text: { type: "mrkdwn", text: "No action-item proposals are waiting for Slack confirmation." },
    }];
  }

  const blocks: unknown[] = [];
  params.insights.slice(0, params.maxProposals).forEach((insight, index) => {
    const evidence = insight.sourceQuote?.trim()
      ? `\n*Evidence:* ${slackText(truncate(insight.sourceQuote.trim().replace(/\s+/g, " "), 180))}`
      : "";
    const status = insightStatusLabel(insight.status);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate([
          `*${index + 1}. <${insightUrl(params.workspaceId, params.meetingId, insight.id)}|${slackText(insight.title)}>*`,
          `*Status:* ${status}  |  *Owner:* ${slackText(insight.assigneeHint || "Unassigned")}  |  *Due:* ${formatDate(insight.dueAt, params.timezone)}  |  *Confidence:* ${confidenceLabel(insight.confidence)}`,
          insight.bodyMd ? slackText(truncate(insight.bodyMd.replace(/\s+/g, " "), 450)) : null,
          evidence,
        ].filter(Boolean).join("\n")),
      },
    });

    if (insight.status === "SUGGESTED" || insight.status === "CONFIRMED") {
      blocks.push({
        type: "actions",
        block_id: `meeting_review_${insight.id}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Confirm" },
            style: "primary",
            action_id: "corgtex_meeting_review_confirm",
            value: reviewActionValue(params.reviewId, insight.id),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Edit" },
            action_id: "corgtex_meeting_review_edit",
            value: reviewActionValue(params.reviewId, insight.id),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Dismiss" },
            style: "danger",
            action_id: "corgtex_meeting_review_dismiss",
            value: reviewActionValue(params.reviewId, insight.id),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Open in Corgtex" },
            action_id: "corgtex_open_meeting_insight",
            url: insightUrl(params.workspaceId, params.meetingId, insight.id),
            value: reviewActionValue(params.reviewId, insight.id),
          },
        ],
      });
    }
  });
  return blocks;
}

export function buildSlackMeetingActionReviewMessage(params: {
  meeting: MeetingForReview;
  reviewId: string;
  insights: ReviewInsight[];
  expiresAt: Date;
  timezone: string;
  maxProposals: number;
}): ReviewMessage {
  const title = params.meeting.title || "Untitled meeting";
  const summaryChunks = splitSlackText(params.meeting.summaryMd || "Summary is not available yet.");
  const proposalBlocks = buildProposalBlocks({
    workspaceId: params.meeting.workspaceId,
    meetingId: params.meeting.id,
    reviewId: params.reviewId,
    insights: params.insights,
    timezone: params.timezone,
    maxProposals: params.maxProposals,
  });
  const introBlocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: plainText(`Meeting review: ${title}`) },
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `<${meetingUrl(params.meeting.workspaceId, params.meeting.id)}|Open meeting in Corgtex>  |  Expires ${formatDateTime(params.expiresAt, params.timezone)}`,
      }],
    },
    { type: "divider" },
  ];
  const proposalIntroBlocks: unknown[] = [
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Proposed follow-ups*\nOnly \`ACTION_ITEM\` insights are shown here. Other meeting intelligence remains in Corgtex.` },
    },
  ];

  const remainingBlockBudget = Math.max(1, SLACK_BLOCK_LIMIT - introBlocks.length - proposalIntroBlocks.length - proposalBlocks.length);
  const summaryBlocks = summaryChunks.map((chunk, index) => ({
    type: "section",
    text: { type: "mrkdwn", text: index === 0 ? `*Meeting summary*\n${chunk}` : chunk },
  }));
  const mainSummaryBlocks = summaryBlocks.slice(0, remainingBlockBudget);
  const overflowSummaryBlocks = summaryBlocks.slice(remainingBlockBudget);
  const overflowBlocks: unknown[][] = [];
  for (let index = 0; index < overflowSummaryBlocks.length; index += 8) {
    overflowBlocks.push([
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Meeting summary continued*" },
      },
      ...overflowSummaryBlocks.slice(index, index + 8),
    ]);
  }

  return {
    text: `Corgtex meeting follow-up review: ${title}`,
    mainBlocks: [
      ...introBlocks,
      ...mainSummaryBlocks,
      ...proposalIntroBlocks,
      ...proposalBlocks,
    ],
    overflowBlocks,
  };
}

function slackTimestampToDate(ts: string | null) {
  if (!ts) return null;
  const [secondsRaw, microsRaw = "0"] = ts.split(".");
  const seconds = Number.parseInt(secondsRaw, 10);
  const millis = Number.parseInt(microsRaw.padEnd(3, "0").slice(0, 3), 10);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000 + (Number.isFinite(millis) ? millis : 0));
}

export async function markSlackMeetingActionReviewPosted(params: {
  workspaceId: string;
  meetingId: string;
  reviewId: string;
  installationId: string;
  channelId: string;
  messageTs: string;
  threadTs: string | null;
  text: string;
  raw?: unknown;
}) {
  const message = await prisma.communicationMessage.upsert({
    where: {
      installationId_externalChannelId_externalMessageId: {
        installationId: params.installationId,
        externalChannelId: params.channelId,
        externalMessageId: params.messageTs,
      },
    },
    update: {
      threadExternalId: params.threadTs || params.messageTs,
      text: params.text,
      messageTs: slackTimestampToDate(params.messageTs),
      isBot: true,
      raw: toInputJson(params.raw ?? {}),
    },
    create: {
      installationId: params.installationId,
      workspaceId: params.workspaceId,
      provider: "SLACK",
      externalChannelId: params.channelId,
      externalMessageId: params.messageTs,
      threadExternalId: params.threadTs || params.messageTs,
      text: params.text,
      messageTs: slackTimestampToDate(params.messageTs),
      raw: toInputJson(params.raw ?? {}),
      isBot: true,
    },
    select: { id: true },
  });

  await prisma.meetingFollowUpReview.update({
    where: { id: params.reviewId },
    data: {
      messageTs: params.messageTs,
      threadTs: params.threadTs || params.messageTs,
      postedAt: new Date(),
    },
  });

  await prisma.communicationEntityLink.create({
    data: {
      installationId: params.installationId,
      workspaceId: params.workspaceId,
      provider: "SLACK",
      messageId: message.id,
      externalUserId: null,
      entityType: "Meeting",
      entityId: params.meetingId,
      action: "meeting_follow_up_review_posted",
    },
  });
}

type ReviewContext = {
  review: {
    id: string;
    workspaceId: string;
    meetingId: string;
    installationId: string;
    channelId: string;
    messageTs: string | null;
    threadTs: string | null;
    status: string;
    expiresAt: Date;
    meeting: MeetingForReview;
  };
  config: SlackMeetingActionReviewConfig | null;
};

async function loadReviewContext(workspaceId: string, reviewId: string): Promise<ReviewContext> {
  const review = await prisma.meetingFollowUpReview.findFirst({
    where: { id: reviewId, workspaceId },
    include: {
      meeting: {
        select: {
          id: true,
          workspaceId: true,
          title: true,
          summaryMd: true,
          recordedAt: true,
          seriesId: true,
          series: { select: { externalId: true } },
        },
      },
    },
  });
  invariant(review, 404, "NOT_FOUND", "Meeting follow-up review not found.");
  const config = await slackMeetingActionReviewConfigForMeeting(workspaceId, review.meeting);
  return { review, config };
}

async function ensureReviewOpen(review: ReviewContext["review"]) {
  if (review.status === "OPEN" && review.expiresAt <= new Date()) {
    await prisma.meetingFollowUpReview.update({
      where: { id: review.id },
      data: { status: "EXPIRED", closedAt: new Date() },
    });
    invariant(false, 400, "REVIEW_EXPIRED", "This meeting follow-up review has expired.");
  }
  invariant(review.status === "OPEN", 400, "INVALID_STATE", "This meeting follow-up review is no longer open.");
  invariant(review.messageTs, 400, "INVALID_STATE", "This meeting follow-up review has not been posted to Slack.");
}

async function maybeCloseReview(reviewId: string, workspaceId: string, meetingId: string) {
  const remaining = await prisma.meetingInsight.count({
    where: {
      workspaceId,
      meetingId,
      type: "ACTION_ITEM",
      operation: "CREATE",
      status: { in: ["SUGGESTED", "CONFIRMED"] },
    },
  });
  if (remaining === 0) {
    await prisma.meetingFollowUpReview.update({
      where: { id: reviewId },
      data: { status: "CLOSED", closedAt: new Date() },
    });
  }
}

async function renderReviewUpdate(params: {
  workspaceId: string;
  reviewId: string;
  responseText: string;
}): Promise<SlackMeetingActionReviewUpdate> {
  const { review, config } = await loadReviewContext(params.workspaceId, params.reviewId);
  invariant(review.messageTs, 400, "INVALID_STATE", "This meeting follow-up review has not been posted to Slack.");
  const maxProposals = config?.maxProposals ?? DEFAULT_MAX_PROPOSALS;
  const timezone = config?.timezone ?? DEFAULT_REVIEW_TIMEZONE;
  const insights = await listMeetingFollowUpProposals({
    workspaceId: params.workspaceId,
    meetingId: review.meetingId,
    maxProposals,
    includeReviewed: true,
  });
  const message = buildSlackMeetingActionReviewMessage({
    meeting: review.meeting,
    reviewId: review.id,
    insights,
    expiresAt: review.expiresAt,
    timezone,
    maxProposals,
  });
  return {
    channelId: review.channelId,
    messageTs: review.messageTs,
    blocks: message.mainBlocks,
    text: message.text,
    responseText: params.responseText,
  };
}

async function loadReviewInsight(workspaceId: string, reviewId: string, insightId: string) {
  const { review } = await loadReviewContext(workspaceId, reviewId);
  await ensureReviewOpen(review);
  const insight = await prisma.meetingInsight.findFirst({
    where: {
      id: insightId,
      workspaceId,
      meetingId: review.meetingId,
      type: "ACTION_ITEM",
      operation: "CREATE",
    },
  });
  invariant(insight, 404, "NOT_FOUND", "Meeting follow-up proposal not found.");
  return { review, insight };
}

async function resolveAssigneeMemberId(workspaceId: string, assigneeHint: string | null) {
  const hint = assigneeHint?.trim().toLowerCase();
  if (!hint) return null;
  const members = await prisma.member.findMany({
    where: { workspaceId },
    include: { user: true },
  });
  const exact = members.find((member: { id: string; user: { displayName?: string | null; email: string } }) =>
    member.user.displayName?.toLowerCase() === hint
    || member.user.email.toLowerCase() === hint
  );
  if (exact) return exact.id;
  const fuzzy = members.find((member: { id: string; user: { displayName?: string | null; email: string } }) =>
    member.user.displayName?.toLowerCase().includes(hint)
    || member.user.email.toLowerCase().includes(hint)
  );
  return fuzzy?.id ?? null;
}

async function reviewSourceMessageId(review: ReviewContext["review"]) {
  if (!review.messageTs) return null;
  const message = await prisma.communicationMessage.findUnique({
    where: {
      installationId_externalChannelId_externalMessageId: {
        installationId: review.installationId,
        externalChannelId: review.channelId,
        externalMessageId: review.messageTs,
      },
    },
    select: { id: true },
  });
  return message?.id ?? null;
}

export async function confirmSlackMeetingActionReviewProposal(actor: AppActor, params: {
  workspaceId: string;
  installationId: string;
  externalUserId: string;
  reviewId: string;
  insightId: string;
}): Promise<SlackMeetingActionReviewUpdate> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const { review, insight } = await loadReviewInsight(params.workspaceId, params.reviewId, params.insightId);
  if (insight.status === "APPLIED") {
    return renderReviewUpdate({
      workspaceId: params.workspaceId,
      reviewId: review.id,
      responseText: "That follow-up was already confirmed.",
    });
  }
  invariant(insight.status === "SUGGESTED" || insight.status === "CONFIRMED", 400, "INVALID_STATE", "Only pending follow-up proposals can be confirmed.");

  const assigneeMemberId = await resolveAssigneeMemberId(params.workspaceId, insight.assigneeHint);
  const sourceMessageId = await reviewSourceMessageId(review);
  const fullBody = [
    insight.bodyMd,
    insight.sourceQuote ? `*Source evidence:* ${insight.sourceQuote}` : null,
    `*Created from meeting:* [${review.meeting.title || "Untitled meeting"}](${meetingUrl(params.workspaceId, review.meetingId)})`,
  ].filter(Boolean).join("\n\n");

  const action = await createAction(actor, {
    workspaceId: params.workspaceId,
    title: insight.title,
    bodyMd: fullBody,
    assigneeMemberId,
    dueAt: insight.dueAt,
    isPrivate: true,
  });
  const opened = await publishAction(actor, {
    workspaceId: params.workspaceId,
    actionId: action.id,
  });

  await prisma.meetingInsight.update({
    where: { id: insight.id },
    data: {
      status: "APPLIED",
      appliedEntityType: "Action",
      appliedEntityId: opened.id,
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
      autoApplyError: null,
    },
  });
  await prisma.communicationEntityLink.create({
    data: {
      installationId: params.installationId,
      workspaceId: params.workspaceId,
      provider: "SLACK",
      messageId: sourceMessageId,
      externalUserId: params.externalUserId,
      entityType: "Action",
      entityId: opened.id,
      action: "create_action",
    },
  });
  await maybeCloseReview(review.id, params.workspaceId, review.meetingId);

  return renderReviewUpdate({
    workspaceId: params.workspaceId,
    reviewId: review.id,
    responseText: `Created action: ${opened.title}. Undo is available by replying in this Slack context with "undo action" within 24 hours.`,
  });
}

export async function dismissSlackMeetingActionReviewProposal(actor: AppActor, params: {
  workspaceId: string;
  reviewId: string;
  insightId: string;
}): Promise<SlackMeetingActionReviewUpdate> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const { review, insight } = await loadReviewInsight(params.workspaceId, params.reviewId, params.insightId);
  if (insight.status === "DISMISSED") {
    return renderReviewUpdate({
      workspaceId: params.workspaceId,
      reviewId: review.id,
      responseText: "That follow-up was already dismissed.",
    });
  }
  invariant(insight.status === "SUGGESTED" || insight.status === "CONFIRMED", 400, "INVALID_STATE", "Only pending follow-up proposals can be dismissed.");

  await prisma.meetingInsight.update({
    where: { id: insight.id },
    data: {
      status: "DISMISSED",
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
    },
  });
  await maybeCloseReview(review.id, params.workspaceId, review.meetingId);
  return renderReviewUpdate({
    workspaceId: params.workspaceId,
    reviewId: review.id,
    responseText: "Dismissed the follow-up proposal.",
  });
}

function modalDateValue(date: Date | null | undefined) {
  return date ? date.toISOString().slice(0, 10) : undefined;
}

export async function buildSlackMeetingActionReviewEditView(actor: AppActor, params: {
  workspaceId: string;
  reviewId: string;
  insightId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const { insight } = await loadReviewInsight(params.workspaceId, params.reviewId, params.insightId);
  invariant(insight.status === "SUGGESTED" || insight.status === "CONFIRMED", 400, "INVALID_STATE", "Only pending follow-up proposals can be edited.");

  return {
    type: "modal",
    callback_id: SLACK_MEETING_ACTION_REVIEW_EDIT_CALLBACK_ID,
    title: { type: "plain_text", text: "Edit follow-up" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify({ reviewId: params.reviewId, insightId: params.insightId }),
    blocks: [
      {
        type: "input",
        block_id: "title",
        label: { type: "plain_text", text: "Title" },
        element: { type: "plain_text_input", action_id: "value", initial_value: insight.title },
      },
      {
        type: "input",
        block_id: "body",
        label: { type: "plain_text", text: "Details" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          initial_value: insight.bodyMd,
        },
      },
      {
        type: "input",
        block_id: "owner",
        optional: true,
        label: { type: "plain_text", text: "Owner" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: insight.assigneeHint ?? undefined,
        },
      },
      {
        type: "input",
        block_id: "due",
        optional: true,
        label: { type: "plain_text", text: "Due date" },
        element: {
          type: "datepicker",
          action_id: "value",
          initial_date: modalDateValue(insight.dueAt),
        },
      },
    ],
  };
}

function stateValue(values: JsonRecord, blockId: string, actionId = "value") {
  const block = isRecord(values[blockId]) ? values[blockId] : null;
  const action = block && isRecord(block[actionId]) ? block[actionId] : null;
  return action && typeof action.value === "string" ? action.value.trim() : "";
}

function stateDate(values: JsonRecord, blockId: string, actionId = "value") {
  const block = isRecord(values[blockId]) ? values[blockId] : null;
  const action = block && isRecord(block[actionId]) ? block[actionId] : null;
  return action && typeof action.selected_date === "string" ? action.selected_date.trim() : "";
}

function parseDateInput(value: string) {
  if (!value) return null;
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

export async function updateSlackMeetingActionReviewProposalFromModal(actor: AppActor, params: {
  workspaceId: string;
  privateMetadata: string;
  values: unknown;
}): Promise<SlackMeetingActionReviewUpdate> {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const metadata = JSON.parse(params.privateMetadata || "{}") as { reviewId?: string; insightId?: string };
  invariant(metadata.reviewId && metadata.insightId, 400, "INVALID_INPUT", "Meeting follow-up edit metadata is missing.");
  const { review, insight } = await loadReviewInsight(params.workspaceId, metadata.reviewId, metadata.insightId);
  invariant(insight.status === "SUGGESTED" || insight.status === "CONFIRMED", 400, "INVALID_STATE", "Only pending follow-up proposals can be edited.");

  const values = isRecord(params.values) ? params.values : {};
  const title = stateValue(values, "title");
  const bodyMd = stateValue(values, "body");
  const assigneeHint = stateValue(values, "owner");
  const dueAt = parseDateInput(stateDate(values, "due"));
  invariant(title.length > 0, 400, "INVALID_INPUT", "Follow-up title is required.");
  invariant(bodyMd.length > 0, 400, "INVALID_INPUT", "Follow-up details are required.");

  await prisma.meetingInsight.update({
    where: { id: insight.id },
    data: {
      title,
      bodyMd,
      assigneeHint: assigneeHint || null,
      dueAt,
      reviewedByUserId: actor.kind === "user" ? actor.user.id : null,
      reviewedAt: new Date(),
    },
  });
  return renderReviewUpdate({
    workspaceId: params.workspaceId,
    reviewId: review.id,
    responseText: "Updated the follow-up proposal. It still needs confirmation before an action is created.",
  });
}

export function parseSlackMeetingActionReviewActionValue(value: string) {
  const parsed = JSON.parse(value || "{}") as { reviewId?: unknown; insightId?: unknown };
  return {
    reviewId: typeof parsed.reviewId === "string" ? parsed.reviewId : "",
    insightId: typeof parsed.insightId === "string" ? parsed.insightId : "",
  };
}

export function isSlackMeetingActionReviewAction(actionId: string) {
  return actionId === "corgtex_meeting_review_confirm"
    || actionId === "corgtex_meeting_review_edit"
    || actionId === "corgtex_meeting_review_dismiss";
}
