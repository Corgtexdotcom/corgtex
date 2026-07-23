import { createHmac, timingSafeEqual } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { Prisma, type CommunicationProvider } from "@prisma/client";
import {
  decryptSecret,
  encryptSecret,
  env,
  prisma,
  randomOpaqueToken,
  toInputJson,
} from "@corgtex/shared";
import type { AppActor, HumanActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { createAction, publishAction } from "./actions";
import { ingestSource } from "./brain";
import { AppError, invariant } from "./errors";
import {
  buildSlackMeetingActionReviewEditView,
  confirmSlackMeetingActionReviewProposal,
  dismissSlackMeetingActionReviewProposal,
  isSlackMeetingActionReviewAction,
  parseSlackMeetingActionReviewActionValue,
  SLACK_MEETING_ACTION_REVIEW_EDIT_CALLBACK_ID,
  updateSlackMeetingActionReviewProposalFromModal,
} from "./meeting-action-review";
import { createProposal, submitProposal } from "./proposals";
import { createTension, publishTension } from "./tensions";

export type CommunicationWorkItemKind = "ACTION" | "TENSION" | "PROPOSAL" | "BRAIN_NOTE";
export type SlackAgentSource = "slash_command" | "app_mention" | "message_shortcut";

export type SlackAgentJobPayload = {
  source: SlackAgentSource;
  installationId: string;
  workspaceId: string;
  actorUserId: string;
  externalUserId: string;
  prompt: string;
  channelId?: string | null;
  threadTs?: string | null;
  messageTs?: string | null;
  messageText?: string | null;
  sourceMessageId?: string | null;
  inboundEventId?: string | null;
  responseUrlEnc?: string | null;
};

export type SlackAgentDelivery = {
  text: string;
  blocks?: unknown[];
};

export type SlackPostTargetValidation = {
  ok: true;
  channelId: string;
  channelName: string | null;
} | {
  ok: false;
  code: string;
  message: string;
};

const SLACK_REQUIRED_SCOPES = [
  "commands",
  "chat:write",
  "app_mentions:read",
  "users:read",
  "users:read.email",
  "channels:read",
  "reactions:read",
] as const;

const SLACK_BROAD_INGESTION_SCOPES = ["channels:history", "channels:join"] as const;
const SLACK_RAW_RETENTION_DAYS = 30;
const SLACK_PUBLIC_ARCHIVE_RETENTION_DAYS = 3650;
const SLACK_PUBLIC_ARCHIVE_LOOKBACK_DAYS = 120;
const SLACK_PUBLIC_ARCHIVE_PAGE_LIMIT = 200;
const SLACK_CONTEXT_SUMMARY_DEBOUNCE_MS = 5 * 60 * 1000;
const INACTIVE_SLACK_INSTALLATION_ERROR = "Slack installation is not active.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appUrl(path = "") {
  return `${env.APP_URL.replace(/\/$/, "")}${path}`;
}

function entityUrl(workspaceId: string, entityType: string, entityId: string) {
  const base = `/workspaces/${workspaceId}`;
  if (entityType === "Action") return appUrl(`${base}/actions/${entityId}`);
  if (entityType === "Tension") return appUrl(`${base}/tensions/${entityId}`);
  if (entityType === "Proposal") return appUrl(`${base}/proposals/${entityId}`);
  if (entityType === "BrainSource") return appUrl(`${base}/brain`);
  return appUrl(base);
}

function slackClient(token?: string | null) {
  return new WebClient(token ?? undefined);
}

function encryptedBotToken(installation: { botTokenEnc: string | null }) {
  invariant(installation.botTokenEnc, 400, "SLACK_NOT_CONNECTED", "Slack installation does not have an active bot token.");
  return decryptSecret(installation.botTokenEnc);
}

function slackTimestampToDate(ts: string | null) {
  if (!ts) return null;
  const [secondsRaw, microsRaw = "0"] = ts.split(".");
  const seconds = Number.parseInt(secondsRaw, 10);
  const millis = Number.parseInt(microsRaw.padEnd(3, "0").slice(0, 3), 10);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000 + (Number.isFinite(millis) ? millis : 0));
}

function dateKey(date: Date) {
  return date.toISOString().split("T")[0];
}

function slackContextSummaryKey(channelId: string, threadTs: string | null | undefined, dayISO: string) {
  return `channel:${channelId}:thread:${threadTs || "channel"}:day:${dayISO}`;
}

function slackArchiveSettings(grantedScopes: string[]) {
  const broadPublicIngestion = grantedScopes.includes("channels:history");
  return {
    broadPublicIngestion,
    autoJoinPublicChannels: broadPublicIngestion && grantedScopes.includes("channels:join"),
    rawRetentionDays: broadPublicIngestion ? SLACK_PUBLIC_ARCHIVE_RETENTION_DAYS : SLACK_RAW_RETENTION_DAYS,
    publicIngestionEnabled: true,
    proactiveEnabled: true,
    proactiveConfidenceThreshold: 0.9,
    unansweredFollowupDelayMinutes: 1440,
    unansweredActionCreationDelayMinutes: 1440,
    staleActionFollowupDelayMinutes: 4320,
    mutedChannelIds: [],
    label: broadPublicIngestion ? "Public Channel Archive" : "Enhanced Org Briefing",
  };
}

function rawRetentionDays(settings?: Prisma.JsonValue | null) {
  if (isRecord(settings) && typeof settings.rawRetentionDays === "number" && Number.isFinite(settings.rawRetentionDays)) {
    return Math.max(1, Math.floor(settings.rawRetentionDays));
  }
  return SLACK_RAW_RETENTION_DAYS;
}

function rawRetentionDate(days = SLACK_RAW_RETENTION_DAYS) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function unixSecondsAgo(days: number) {
  if (days <= 0) return undefined;
  return String(Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000));
}

function shouldSkipSlackArchiveMessage(message: Record<string, unknown>) {
  const subtype = asString(message.subtype);
  return Boolean(message.hidden)
    || subtype === "message_deleted"
    || subtype === "bot_message"
    || Boolean(message.bot_id);
}

function compactJsonObject<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function normalizeSlackChannelId(value: string) {
  const trimmed = value.trim();
  const mention = trimmed.match(/^<#([^|>]+)(?:\|[^>]+)?>$/);
  return mention?.[1] ?? trimmed;
}

export function stripSlackBotMention(text: string, botUserId?: string | null) {
  const mentionPattern = botUserId
    ? new RegExp(`<@${escapeRegExp(botUserId)}(?:\\|[^>]+)?>`, "g")
    : /^<@[A-Z0-9]+(?:\|[^>]+)?>\s*/g;
  return text.replace(mentionPattern, "").trim();
}

export function slackOAuthScopes() {
  return [...SLACK_REQUIRED_SCOPES, ...SLACK_BROAD_INGESTION_SCOPES].join(",");
}

export type SlackOAuthFlowKind = "workspace" | "control_plane";

export type SlackOAuthStateFlow = {
  kind: SlackOAuthFlowKind;
  deploymentId?: string | null;
  initiatedByUserId?: string | null;
};

export type SlackOAuthStatePayload = {
  version: number;
  workspaceId: string;
  nonce: string;
  expectedTeamId: string | null;
  flow: SlackOAuthStateFlow;
};

function normalizeSlackTeamId(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

export function createSlackOAuthState(workspaceId: string, params: {
  expectedTeamId?: string | null;
  flow?: SlackOAuthStateFlow;
} = {}) {
  const nonce = randomOpaqueToken(24);
  const expectedTeamId = normalizeSlackTeamId(params.expectedTeamId);
  const flow = params.flow ?? { kind: "workspace" };
  return {
    nonce,
    expectedTeamId,
    value: Buffer.from(JSON.stringify(compactJsonObject({
      v: 1,
      workspaceId,
      nonce,
      expectedTeamId: expectedTeamId ?? undefined,
      flow: flow.kind,
      deploymentId: flow.deploymentId ?? undefined,
      initiatedByUserId: flow.initiatedByUserId ?? undefined,
    }))).toString("base64url"),
  };
}

export function readSlackOAuthState(state: string) {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed)) return null;
    const workspaceId = asString(parsed.workspaceId);
    const nonce = asString(parsed.nonce);
    if (!workspaceId || !nonce) return null;
    const rawFlow = asString(parsed.flow);
    const flow: SlackOAuthStateFlow = rawFlow === "control_plane"
      ? {
        kind: "control_plane",
        deploymentId: asString(parsed.deploymentId) || null,
        initiatedByUserId: asString(parsed.initiatedByUserId) || null,
      }
      : { kind: "workspace" };
    return {
      version: Number(parsed.v) === 1 ? 1 : 0,
      workspaceId,
      nonce,
      expectedTeamId: normalizeSlackTeamId(asString(parsed.expectedTeamId)),
      flow,
    } satisfies SlackOAuthStatePayload;
  } catch {
    return null;
  }
}

export function verifySlackRequest(rawBody: string, headers: Headers | Record<string, string | string[] | undefined>) {
  invariant(env.SLACK_SIGNING_SECRET, 500, "SLACK_NOT_CONFIGURED", "SLACK_SIGNING_SECRET is not configured.");

  const readHeader = (name: string) => {
    if (headers instanceof Headers) {
      return headers.get(name) ?? headers.get(name.toLowerCase()) ?? "";
    }
    const value = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] ?? "" : value ?? "";
  };

  const timestamp = readHeader("x-slack-request-timestamp");
  const signature = readHeader("x-slack-signature");
  const timestampSeconds = Number.parseInt(timestamp, 10);
  invariant(Number.isFinite(timestampSeconds), 401, "INVALID_SLACK_SIGNATURE", "Missing Slack request timestamp.");
  invariant(Math.abs(Date.now() / 1000 - timestampSeconds) <= 300, 401, "INVALID_SLACK_SIGNATURE", "Slack request timestamp is outside the allowed window.");

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", env.SLACK_SIGNING_SECRET).update(base).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  invariant(actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer), 401, "INVALID_SLACK_SIGNATURE", "Slack request signature is invalid.");
  return true;
}

export async function listCommunicationInstallations(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });

  return prisma.communicationInstallation.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      provider: true,
      externalWorkspaceId: true,
      externalTeamName: true,
      botUserId: true,
      scopes: true,
      optionalScopes: true,
      settings: true,
      status: true,
      installedAt: true,
      disconnectedAt: true,
      lastEventAt: true,
      lastError: true,
      _count: { select: { channels: true, externalUsers: true, messages: true } },
    },
  });
}

export async function disconnectCommunicationInstallation(actor: AppActor, installationId: string) {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
    select: { id: true, workspaceId: true },
  });
  invariant(installation, 404, "NOT_FOUND", "Communication installation not found.");
  await requireWorkspaceMembership({ actor, workspaceId: installation.workspaceId, allowedRoles: ["ADMIN"] });

  return prisma.communicationInstallation.update({
    where: { id: installationId },
    data: {
      status: "DISCONNECTED",
      botTokenEnc: null,
      disconnectedAt: new Date(),
    },
  });
}

export async function updateCommunicationSettings(actor: AppActor, installationId: string, settings: Prisma.InputJsonObject) {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
    select: { id: true, workspaceId: true },
  });
  invariant(installation, 404, "NOT_FOUND", "Communication installation not found.");
  await requireWorkspaceMembership({ actor, workspaceId: installation.workspaceId, allowedRoles: ["ADMIN"] });

  return prisma.communicationInstallation.update({
    where: { id: installationId },
    data: { settings },
  });
}

export async function exchangeSlackOAuthCode(code: string, redirectUri: string) {
  invariant(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET, 500, "SLACK_NOT_CONFIGURED", "Slack OAuth is not configured.");

  const response = await slackClient().oauth.v2.access({
    client_id: env.SLACK_CLIENT_ID,
    client_secret: env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });

  if (!response.ok || !response.team?.id || !response.access_token) {
    throw new Error(`Slack OAuth failed: ${response.error ?? "missing installation data"}`);
  }

  return response;
}

export type SlackOAuthResponse = Awaited<ReturnType<typeof exchangeSlackOAuthCode>>;

const SLACK_TENANT_BINDING_ERROR_CODES = new Set([
  "SLACK_TEAM_MISMATCH",
  "SLACK_TEAM_ALREADY_CONNECTED",
  "SLACK_WORKSPACE_ALREADY_BOUND",
]);

type SlackBindingPrismaClient = Pick<Prisma.TransactionClient, "communicationInstallation" | "workspaceIntegrationBinding">;

function slackTeamIdFromOAuthResponse(oauthResponse: SlackOAuthResponse) {
  return normalizeSlackTeamId(oauthResponse.team?.id ?? null);
}

function isPrismaUniqueConstraintError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2002";
  }
  return isRecord(error) && error.code === "P2002";
}

async function findSlackWorkspaceExpectedTeamId(client: SlackBindingPrismaClient, workspaceId: string) {
  const binding = await client.workspaceIntegrationBinding.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "SLACK" } },
    select: { externalWorkspaceId: true },
  });
  if (binding) return binding.externalWorkspaceId;

  const activeInstallation = await client.communicationInstallation.findFirst({
    where: {
      workspaceId,
      provider: "SLACK",
      status: "ACTIVE",
    },
    orderBy: { updatedAt: "desc" },
    select: { externalWorkspaceId: true },
  });
  if (activeInstallation) return activeInstallation.externalWorkspaceId;

  const latestInstallation = await client.communicationInstallation.findFirst({
    where: {
      workspaceId,
      provider: "SLACK",
    },
    orderBy: { updatedAt: "desc" },
    select: { externalWorkspaceId: true },
  });
  return latestInstallation?.externalWorkspaceId ?? null;
}

export async function getSlackExpectedTeamIdForWorkspace(workspaceId: string) {
  return findSlackWorkspaceExpectedTeamId(prisma, workspaceId);
}

export async function getSlackOAuthInstallTarget(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });
  return {
    workspaceId,
    expectedTeamId: await getSlackExpectedTeamIdForWorkspace(workspaceId),
  };
}

export function isSlackTenantBindingError(error: unknown) {
  return error instanceof AppError && SLACK_TENANT_BINDING_ERROR_CODES.has(error.code);
}

export async function saveSlackInstallationForWorkspace(params: {
  workspaceId: string;
  oauthResponse: SlackOAuthResponse;
  installedByUserId?: string | null;
  expectedTeamId?: string | null;
}) {
  const teamId = slackTeamIdFromOAuthResponse(params.oauthResponse);
  invariant(teamId, 400, "INVALID_SLACK_INSTALLATION", "Slack OAuth response did not include a team id.");

  const grantedScopes = typeof params.oauthResponse.scope === "string"
    ? params.oauthResponse.scope.split(",").map((scope) => scope.trim()).filter(Boolean)
    : [];

  const optionalScopes = grantedScopes.filter((scope) => (SLACK_BROAD_INGESTION_SCOPES as readonly string[]).includes(scope));
  const botTokenEnc = encryptSecret(String(params.oauthResponse.access_token));

  try {
    return await prisma.$transaction(async (tx) => {
      const currentWorkspaceTeamId = await findSlackWorkspaceExpectedTeamId(tx, params.workspaceId);
      const expectedTeamId = normalizeSlackTeamId(params.expectedTeamId) ?? currentWorkspaceTeamId;

      if (expectedTeamId && expectedTeamId !== teamId) {
        throw new AppError(409, "SLACK_TEAM_MISMATCH", "The selected Slack workspace does not match the Corgtex workspace binding.");
      }
      if (currentWorkspaceTeamId && currentWorkspaceTeamId !== teamId) {
        throw new AppError(409, "SLACK_WORKSPACE_ALREADY_BOUND", "This Corgtex workspace is already bound to another Slack workspace.");
      }

      const [existingTeamInstallation, existingTeamBinding] = await Promise.all([
        tx.communicationInstallation.findUnique({
          where: { provider_externalWorkspaceId: { provider: "SLACK", externalWorkspaceId: teamId } },
          select: { workspaceId: true },
        }),
        tx.workspaceIntegrationBinding.findUnique({
          where: { provider_externalWorkspaceId: { provider: "SLACK", externalWorkspaceId: teamId } },
          select: { workspaceId: true },
        }),
      ]);

      if (existingTeamInstallation && existingTeamInstallation.workspaceId !== params.workspaceId) {
        throw new AppError(409, "SLACK_TEAM_ALREADY_CONNECTED", "That Slack workspace is already connected to another Corgtex workspace.");
      }
      if (existingTeamBinding && existingTeamBinding.workspaceId !== params.workspaceId) {
        throw new AppError(409, "SLACK_TEAM_ALREADY_CONNECTED", "That Slack workspace is already bound to another Corgtex workspace.");
      }

      const persistedBinding = await tx.workspaceIntegrationBinding.upsert({
        where: { workspaceId_provider: { workspaceId: params.workspaceId, provider: "SLACK" } },
        update: {
          externalOrgId: params.oauthResponse.enterprise?.id ?? null,
          externalTeamName: params.oauthResponse.team?.name ?? null,
          appId: params.oauthResponse.app_id ?? env.SLACK_APP_ID ?? null,
          installedByUserId: params.installedByUserId ?? null,
        },
        create: {
          workspaceId: params.workspaceId,
          provider: "SLACK",
          externalWorkspaceId: teamId,
          externalOrgId: params.oauthResponse.enterprise?.id ?? null,
          externalTeamName: params.oauthResponse.team?.name ?? null,
          appId: params.oauthResponse.app_id ?? env.SLACK_APP_ID ?? null,
          installedByUserId: params.installedByUserId ?? null,
        },
        select: { externalWorkspaceId: true },
      });
      if (persistedBinding.externalWorkspaceId !== teamId) {
        throw new AppError(409, "SLACK_WORKSPACE_ALREADY_BOUND", "This Corgtex workspace is already bound to another Slack workspace.");
      }

      return tx.communicationInstallation.upsert({
        where: { provider_externalWorkspaceId: { provider: "SLACK", externalWorkspaceId: teamId } },
        update: {
          externalOrgId: params.oauthResponse.enterprise?.id ?? null,
          externalTeamName: params.oauthResponse.team?.name ?? null,
          appId: params.oauthResponse.app_id ?? env.SLACK_APP_ID ?? null,
          botUserId: params.oauthResponse.bot_user_id ?? null,
          botTokenEnc,
          scopes: grantedScopes,
          optionalScopes,
          status: "ACTIVE",
          installedByUserId: params.installedByUserId ?? null,
          installedAt: new Date(),
          disconnectedAt: null,
          lastError: null,
          settings: slackArchiveSettings(grantedScopes),
        },
        create: {
          workspaceId: params.workspaceId,
          provider: "SLACK",
          externalWorkspaceId: teamId,
          externalOrgId: params.oauthResponse.enterprise?.id ?? null,
          externalTeamName: params.oauthResponse.team?.name ?? null,
          appId: params.oauthResponse.app_id ?? env.SLACK_APP_ID ?? null,
          botUserId: params.oauthResponse.bot_user_id ?? null,
          botTokenEnc,
          scopes: grantedScopes,
          optionalScopes,
          installedByUserId: params.installedByUserId ?? null,
          settings: slackArchiveSettings(grantedScopes),
        },
      });
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new AppError(409, "SLACK_TEAM_ALREADY_CONNECTED", "That Slack workspace is already connected to another Corgtex workspace.");
    }
    throw error;
  }
}

export async function saveSlackInstallation(actor: AppActor, params: {
  workspaceId: string;
  oauthResponse: SlackOAuthResponse;
  expectedTeamId?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  return saveSlackInstallationForWorkspace({
    workspaceId: params.workspaceId,
    oauthResponse: params.oauthResponse,
    installedByUserId: actor.kind === "user" ? actor.user.id : null,
    expectedTeamId: params.expectedTeamId,
  });
}

async function slackInstallationByTeam(teamId: string) {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { provider_externalWorkspaceId: { provider: "SLACK", externalWorkspaceId: teamId } },
  });
  if (!installation) return null;

  const binding = await prisma.workspaceIntegrationBinding.findUnique({
    where: { workspaceId_provider: { workspaceId: installation.workspaceId, provider: "SLACK" } },
    select: { externalWorkspaceId: true },
  });
  if (binding && binding.externalWorkspaceId !== teamId) return null;

  return installation;
}

export async function ingestCommunicationEvent(provider: CommunicationProvider, rawEvent: Record<string, unknown>) {
  if (provider !== "SLACK") {
    throw new Error(`Unsupported communication provider: ${provider}`);
  }

  const teamId = asString(rawEvent.team_id) || (isRecord(rawEvent.team) ? asString(rawEvent.team.id) : "");
  const event = isRecord(rawEvent.event) ? rawEvent.event : rawEvent;
  const eventType = asString(event.type) || asString(rawEvent.type) || "unknown";
  const externalEventId = asString(rawEvent.event_id) || asString(event.event_ts) || null;
  const dedupeKey = externalEventId
    ? `SLACK:${teamId}:${externalEventId}`
    : `SLACK:${teamId}:${createHmac("sha256", "slack-event").update(JSON.stringify(rawEvent)).digest("hex")}`;

  const existing = await prisma.communicationInboundEvent.findUnique({
    where: { dedupeKey },
  });
  if (existing) {
    return { inboundEventId: existing.id, duplicate: true };
  }

  const installation = teamId ? await slackInstallationByTeam(teamId) : null;
  const activeInstallation = installation?.status === "ACTIVE" ? installation : null;
  const ignoredReason = installation ? INACTIVE_SLACK_INSTALLATION_ERROR : "No Corgtex Slack installation matched this event.";
  const inbound = await prisma.communicationInboundEvent.create({
    data: {
      provider: "SLACK",
      installationId: installation?.id ?? null,
      workspaceId: installation?.workspaceId ?? null,
      externalEventId,
      eventType,
      dedupeKey,
      payload: toInputJson(rawEvent),
      status: activeInstallation ? "PENDING" : "IGNORED",
      error: activeInstallation ? null : ignoredReason,
    },
  });

  if (!activeInstallation) {
    return { inboundEventId: inbound.id, duplicate: false, ignored: true };
  }

  await prisma.$transaction(async (tx) => {
    await tx.communicationInstallation.update({
      where: { id: activeInstallation.id },
      data: { lastEventAt: new Date(), lastError: null },
    });
    await tx.workflowJob.upsert({
      where: { dedupeKey: `${inbound.id}:communication-slack-event` },
      update: {},
      create: {
        workspaceId: activeInstallation.workspaceId,
        type: "communication.slack.event",
        payload: { inboundEventId: inbound.id },
        dedupeKey: `${inbound.id}:communication-slack-event`,
      },
    });
  });

  return { inboundEventId: inbound.id, duplicate: false };
}

async function resolveHumanActorForSlackUser(installationId: string, externalUserId: string): Promise<HumanActor | null> {
  const mapped = await prisma.communicationExternalUser.findUnique({
    where: { installationId_externalUserId: { installationId, externalUserId } },
  });

  if (mapped?.userId) {
    const user = await prisma.user.findUnique({
      where: { id: mapped.userId },
      select: { id: true, email: true, displayName: true, globalRole: true },
    });
    if (user) return { kind: "user", user };
  }

  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
  });
  if (!installation || installation.provider !== "SLACK" || installation.status !== "ACTIVE") return null;

  try {
    const profile = await slackClient(encryptedBotToken(installation)).users.info({
      user: externalUserId,
      include_locale: false,
    });
    const userProfile = isRecord(profile.user?.profile) ? profile.user.profile : {};
    const email = asString(userProfile.email);
    const displayName = asString(userProfile.display_name) || asString(userProfile.real_name) || asString(profile.user?.name);
    const user = email
      ? await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, displayName: true, globalRole: true },
      })
      : null;
    const member = user
      ? await prisma.member.findUnique({
        where: { workspaceId_userId: { workspaceId: installation.workspaceId, userId: user.id } },
        select: { id: true },
      })
      : null;

    await prisma.communicationExternalUser.upsert({
      where: { installationId_externalUserId: { installationId, externalUserId } },
      update: {
        userId: user?.id ?? null,
        memberId: member?.id ?? null,
        email: email || null,
        displayName: displayName || null,
        isBot: Boolean(profile.user?.is_bot),
        isDeleted: Boolean(profile.user?.deleted),
        rawProfile: toInputJson(profile.user ?? {}),
        lastSeenAt: new Date(),
      },
      create: {
        installationId,
        workspaceId: installation.workspaceId,
        provider: "SLACK",
        externalUserId,
        userId: user?.id ?? null,
        memberId: member?.id ?? null,
        email: email || null,
        displayName: displayName || null,
        isBot: Boolean(profile.user?.is_bot),
        isDeleted: Boolean(profile.user?.deleted),
        rawProfile: toInputJson(profile.user ?? {}),
        lastSeenAt: new Date(),
      },
    });

    return user ? { kind: "user", user } : null;
  } catch {
    return null;
  }
}

export type SlackNotificationRecipient = {
  installationId: string;
  externalUserId: string;
};

export async function resolveSlackNotificationRecipient(params: {
  workspaceId: string;
  userId: string;
  email?: string | null;
}): Promise<SlackNotificationRecipient | null> {
  const installation = await prisma.communicationInstallation.findFirst({
    where: {
      workspaceId: params.workspaceId,
      provider: "SLACK",
      status: "ACTIVE",
      botTokenEnc: { not: null },
    },
    orderBy: { installedAt: "desc" },
    select: {
      id: true,
      workspaceId: true,
      botTokenEnc: true,
    },
  });
  if (!installation) return null;

  const cached = await prisma.communicationExternalUser.findFirst({
    where: {
      installationId: installation.id,
      workspaceId: params.workspaceId,
      provider: "SLACK",
      userId: params.userId,
      isBot: false,
      isDeleted: false,
    },
    orderBy: { updatedAt: "desc" },
    select: { externalUserId: true },
  });
  if (cached?.externalUserId) {
    return {
      installationId: installation.id,
      externalUserId: cached.externalUserId,
    };
  }

  const email = params.email?.trim();
  if (!email) return null;

  try {
    const profile = await slackClient(encryptedBotToken(installation)).users.lookupByEmail({ email });
    const slackUser = isRecord(profile.user) ? profile.user : null;
    if (!slackUser) return null;
    const externalUserId = asString(slackUser?.id);
    if (!externalUserId) return null;

    const userProfile = isRecord(slackUser?.profile) ? slackUser.profile : {};
    const displayName = asString(userProfile.display_name) || asString(userProfile.real_name) || asString(slackUser.name);
    const isBot = Boolean(slackUser.is_bot);
    const isDeleted = Boolean(slackUser.deleted);

    await prisma.communicationExternalUser.upsert({
      where: { installationId_externalUserId: { installationId: installation.id, externalUserId } },
      update: {
        userId: params.userId,
        email,
        displayName: displayName || null,
        isBot,
        isDeleted,
        rawProfile: toInputJson(slackUser),
        lastSeenAt: new Date(),
      },
      create: {
        installationId: installation.id,
        workspaceId: params.workspaceId,
        provider: "SLACK",
        externalUserId,
        userId: params.userId,
        email,
        displayName: displayName || null,
        isBot,
        isDeleted,
        rawProfile: toInputJson(slackUser),
        lastSeenAt: new Date(),
      },
    });

    if (isBot || isDeleted) return null;
    return {
      installationId: installation.id,
      externalUserId,
    };
  } catch (error) {
    const slackCode = (error as { data?: { error?: string } }).data?.error;
    if (slackCode === "users_not_found" || slackCode === "user_not_found") {
      return null;
    }
    throw error;
  }
}

async function ensureSlackChannel(installation: { id: string; workspaceId: string }, event: Record<string, unknown>) {
  const externalChannelId = asString(event.channel);
  if (!externalChannelId) return null;
  const channelType = asString(event.channel_type);
  const kind = channelType === "channel"
    ? "PUBLIC"
    : channelType === "group"
      ? "PRIVATE"
      : channelType === "im"
        ? "DIRECT"
        : externalChannelId.startsWith("C")
          ? "PUBLIC"
          : externalChannelId.startsWith("G")
            ? "PRIVATE"
            : externalChannelId.startsWith("D")
              ? "DIRECT"
              : "UNKNOWN";

  return prisma.communicationChannel.upsert({
    where: { installationId_externalChannelId: { installationId: installation.id, externalChannelId } },
    update: {
      kind,
      lastSeenAt: new Date(),
    },
    create: {
      installationId: installation.id,
      workspaceId: installation.workspaceId,
      provider: "SLACK",
      externalChannelId,
      kind,
      isIngestEnabled: kind === "PUBLIC",
      lastSeenAt: new Date(),
    },
  });
}

function normalizeSlackMessageEvent(event: Record<string, unknown>) {
  const subtype = asString(event.subtype);
  const changedMessage = subtype === "message_changed" && isRecord(event.message) ? event.message : null;
  const previousMessage = isRecord(event.previous_message) ? event.previous_message : null;
  const source = changedMessage ?? event;
  const deletedTs = subtype === "message_deleted" ? asString(event.deleted_ts) || asString(previousMessage?.ts) : "";
  const externalChannelId = asString(event.channel) || asString(source.channel) || asString(previousMessage?.channel);
  const ts = deletedTs || asString(source.ts) || asString(event.ts) || asString(event.event_ts);
  const threadTs = asString(source.thread_ts) || asString(previousMessage?.thread_ts) || null;
  const sourceSubtype = asString(source.subtype) || subtype;
  const isDeleted = subtype === "message_deleted";

  return {
    source,
    subtype,
    externalChannelId,
    ts,
    externalUserId: asString(source.user) || asString(previousMessage?.user) || null,
    threadTs,
    text: isDeleted ? "" : asString(source.text),
    hidden: Boolean(event.hidden) || Boolean(source.hidden),
    isBot: Boolean(source.bot_id) || sourceSubtype === "bot_message",
    isDeleted,
  };
}

async function deleteSlackMessageKnowledge(messageId: string) {
  await prisma.knowledgeChunk.deleteMany({
    where: {
      sourceType: "SLACK",
      sourceId: messageId,
    },
  });
}

async function enqueueSlackMessageContextJobs(params: {
  installation: { id: string; workspaceId: string };
  message: { id: string; externalChannelId: string; externalMessageId: string; threadExternalId: string | null; messageTs: Date | null; updatedAt?: Date };
  syncKnowledge?: boolean;
  syncExternalResources?: boolean;
}) {
  const dayISO = dateKey(params.message.messageTs ?? slackTimestampToDate(params.message.externalMessageId) ?? new Date());
  const threadTs = params.message.threadExternalId || params.message.externalMessageId;
  const runAfter = new Date(Date.now() + SLACK_CONTEXT_SUMMARY_DEBOUNCE_MS);

  if (params.syncKnowledge ?? true) {
    const knowledgeDedupeKey = `${params.message.id}:knowledge-sync-slack-message${params.message.updatedAt ? `:${params.message.updatedAt.getTime()}` : ""}`;
    await prisma.workflowJob.upsert({
      where: { dedupeKey: knowledgeDedupeKey },
      update: {},
      create: {
        workspaceId: params.installation.workspaceId,
        type: "knowledge.sync.slack-message",
        payload: toInputJson({ messageId: params.message.id }) as Prisma.InputJsonObject,
        dedupeKey: knowledgeDedupeKey,
      },
    });
  }

  if (params.syncExternalResources ?? true) {
    const revision = params.message.updatedAt?.getTime() ?? Date.now();
    const dedupeKey = `external-resource:SLACK_MESSAGE:${params.message.id}:capture:${revision}`;
    await prisma.workflowJob.upsert({
      where: { dedupeKey },
      update: {},
      create: {
        workspaceId: params.installation.workspaceId,
        type: "external-resource.capture-source",
        payload: toInputJson({
          sourceType: "SLACK_MESSAGE",
          sourceId: params.message.id,
        }) as Prisma.InputJsonObject,
        dedupeKey,
      },
    });
  }

  for (const summaryThreadTs of [threadTs, null]) {
    const summaryKey = slackContextSummaryKey(params.message.externalChannelId, summaryThreadTs, dayISO);
    await prisma.workflowJob.upsert({
      where: { dedupeKey: `${params.installation.id}:slack-context-summary:${summaryKey}` },
      update: {
        payload: toInputJson({
          installationId: params.installation.id,
          channelId: params.message.externalChannelId,
          threadTs: summaryThreadTs,
          dayISO,
        }) as Prisma.InputJsonObject,
        runAfter,
        status: "PENDING",
        completedAt: null,
        error: null,
      },
      create: {
        workspaceId: params.installation.workspaceId,
        type: "communication.slack.context-summary",
        payload: toInputJson({
          installationId: params.installation.id,
          channelId: params.message.externalChannelId,
          threadTs: summaryThreadTs,
          dayISO,
        }) as Prisma.InputJsonObject,
        runAfter,
        dedupeKey: `${params.installation.id}:slack-context-summary:${summaryKey}`,
      },
    });
  }
}

async function ingestSlackMessage(installation: { id: string; workspaceId: string; provider: CommunicationProvider; settings?: Prisma.JsonValue | null }, event: Record<string, unknown>) {
  const normalized = normalizeSlackMessageEvent(event);
  const externalChannelId = normalized.externalChannelId;
  const ts = normalized.ts;
  if (!externalChannelId || !ts) return { skipped: true, reason: "missing_channel_or_ts" };

  const channel = await ensureSlackChannel(installation, {
    ...event,
    channel: externalChannelId,
  });
  if (!channel || channel.kind !== "PUBLIC" || !channel.isIngestEnabled) {
    return { skipped: true, reason: "channel_not_ingested" };
  }

  if (normalized.isDeleted) {
    const existing = await prisma.communicationMessage.findUnique({
      where: {
        installationId_externalChannelId_externalMessageId: {
          installationId: installation.id,
          externalChannelId,
          externalMessageId: ts,
        },
      },
      select: { id: true, externalChannelId: true, externalMessageId: true, threadExternalId: true, messageTs: true, updatedAt: true },
    });

    await prisma.communicationMessage.updateMany({
      where: {
        installationId: installation.id,
        externalChannelId,
        externalMessageId: ts,
      },
      data: {
        text: null,
        raw: toInputJson(event),
        textRedactedAt: new Date(),
        isDeleted: true,
        isHidden: true,
      },
    });

    if (existing) {
      await deleteSlackMessageKnowledge(existing.id);
      await enqueueSlackMessageContextJobs({
        installation,
        message: { ...existing, updatedAt: new Date() },
        syncKnowledge: false,
      });
    }
    return { skipped: true, reason: "message_deleted" };
  }

  if (normalized.hidden || normalized.isBot) {
    return { skipped: true, reason: "excluded_message_type" };
  }

  const text = normalized.text;
  const expiresRawAt = rawRetentionDate(rawRetentionDays(installation.settings));
  const message = await prisma.communicationMessage.upsert({
    where: {
      installationId_externalChannelId_externalMessageId: {
        installationId: installation.id,
        externalChannelId,
        externalMessageId: ts,
      },
    },
    update: {
      externalUserId: normalized.externalUserId,
      threadExternalId: normalized.threadTs,
      text: text || null,
      raw: toInputJson(normalized.source),
      messageTs: slackTimestampToDate(ts),
      expiresRawAt,
      isBot: normalized.isBot,
      isHidden: normalized.hidden,
      isDeleted: false,
      textRedactedAt: null,
    },
    create: {
      installationId: installation.id,
      workspaceId: installation.workspaceId,
      provider: "SLACK",
      externalMessageId: ts,
      externalChannelId,
      externalUserId: normalized.externalUserId,
      threadExternalId: normalized.threadTs,
      text: text || null,
      raw: toInputJson(normalized.source),
      messageTs: slackTimestampToDate(ts),
      expiresRawAt,
      isBot: normalized.isBot,
      isHidden: normalized.hidden,
      isDeleted: false,
    },
  });

  if (text) {
    await enqueueSlackMessageContextJobs({ installation, message });
  }

  return message;
}

async function persistSlackSourceMessage(installation: {
  id: string;
  workspaceId: string;
  provider: CommunicationProvider;
  settings?: Prisma.JsonValue | null;
}, params: {
  channelId: string;
  messageTs: string;
  externalUserId?: string | null;
  threadTs?: string | null;
  text?: string | null;
  raw?: Record<string, unknown>;
}) {
  if (!params.channelId || !params.messageTs) return null;

  await ensureSlackChannel(installation, {
    channel: params.channelId,
  });

  const expiresRawAt = rawRetentionDate(rawRetentionDays(installation.settings));
  const message = await prisma.communicationMessage.upsert({
    where: {
      installationId_externalChannelId_externalMessageId: {
        installationId: installation.id,
        externalChannelId: params.channelId,
        externalMessageId: params.messageTs,
      },
    },
    update: {
      externalUserId: params.externalUserId || null,
      threadExternalId: params.threadTs || null,
      text: params.text || null,
      raw: toInputJson(params.raw ?? {}),
      messageTs: slackTimestampToDate(params.messageTs),
      expiresRawAt,
      isBot: false,
      isHidden: false,
      isDeleted: false,
      textRedactedAt: null,
    },
    create: {
      installationId: installation.id,
      workspaceId: installation.workspaceId,
      provider: "SLACK",
      externalMessageId: params.messageTs,
      externalChannelId: params.channelId,
      externalUserId: params.externalUserId || null,
      threadExternalId: params.threadTs || null,
      text: params.text || null,
      raw: toInputJson(params.raw ?? {}),
      messageTs: slackTimestampToDate(params.messageTs),
      expiresRawAt,
      isBot: false,
      isHidden: false,
      isDeleted: false,
    },
    select: { id: true, externalChannelId: true, externalMessageId: true, threadExternalId: true, messageTs: true, updatedAt: true },
  });

  if (params.text?.trim()) {
    await enqueueSlackMessageContextJobs({ installation, message });
  }

  return { id: message.id };
}

type SlackArchiveInstallation = {
  id: string;
  workspaceId: string;
  provider: CommunicationProvider;
  botTokenEnc: string | null;
  scopes: string[];
  settings?: Prisma.JsonValue | null;
};

export type SlackPublicArchiveSyncSummary = {
  workspaceId: string;
  installationId: string;
  channelsSeen: number;
  channelsJoined: number;
  channelsArchived: number;
  channelsSkippedNotMember: number;
  channelsWithReadErrors: number;
  messagesScanned: number;
  messagesUpserted: number;
  cappedChannels: number;
  lookbackDays: number;
  retentionDays: number;
};

async function upsertSlackArchiveMessage(params: {
  installation: SlackArchiveInstallation;
  channelId: string;
  message: Record<string, unknown>;
  expiresRawAt: Date;
}) {
  const ts = asString(params.message.ts);
  if (!ts || shouldSkipSlackArchiveMessage(params.message)) {
    return false;
  }

  const message = await prisma.communicationMessage.upsert({
    where: {
      installationId_externalChannelId_externalMessageId: {
        installationId: params.installation.id,
        externalChannelId: params.channelId,
        externalMessageId: ts,
      },
    },
    update: {
      externalUserId: asString(params.message.user) || null,
      threadExternalId: asString(params.message.thread_ts) || null,
      text: asString(params.message.text) || null,
      raw: toInputJson(params.message),
      messageTs: slackTimestampToDate(ts),
      expiresRawAt: params.expiresRawAt,
      isBot: false,
      isHidden: false,
      isDeleted: false,
      textRedactedAt: null,
    },
    create: {
      installationId: params.installation.id,
      workspaceId: params.installation.workspaceId,
      provider: "SLACK",
      externalMessageId: ts,
      externalChannelId: params.channelId,
      externalUserId: asString(params.message.user) || null,
      threadExternalId: asString(params.message.thread_ts) || null,
      text: asString(params.message.text) || null,
      raw: toInputJson(params.message),
      messageTs: slackTimestampToDate(ts),
      expiresRawAt: params.expiresRawAt,
      isBot: false,
      isHidden: false,
      isDeleted: false,
    },
  });

  if (asString(params.message.text)) {
    await enqueueSlackMessageContextJobs({
      installation: params.installation,
      message,
    });
  }

  return true;
}

async function syncSlackArchiveChannelHistory(params: {
  client: WebClient;
  installation: SlackArchiveInstallation;
  channelId: string;
  oldest?: string;
  expiresRawAt: Date;
  maxMessagesPerChannel: number;
}) {
  let cursor: string | undefined;
  let scanned = 0;
  let upserted = 0;

  do {
    const response = await params.client.conversations.history({
      channel: params.channelId,
      cursor,
      limit: SLACK_PUBLIC_ARCHIVE_PAGE_LIMIT,
      ...(params.oldest ? { oldest: params.oldest } : {}),
    });
    const messages = Array.isArray(response.messages)
      ? response.messages.filter((message): message is Record<string, unknown> => isRecord(message))
      : [];

    for (const message of messages) {
      if (params.maxMessagesPerChannel > 0 && scanned >= params.maxMessagesPerChannel) {
        return { scanned, upserted, capped: true };
      }
      scanned += 1;
      const persisted = await upsertSlackArchiveMessage({
        installation: params.installation,
        channelId: params.channelId,
        message,
        expiresRawAt: params.expiresRawAt,
      });
      if (persisted) upserted += 1;
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return { scanned, upserted, capped: false };
}

export async function syncSlackPublicArchiveForWorkspace(workspaceId: string, options: {
  lookbackDays?: number;
  retentionDays?: number;
  maxMessagesPerChannel?: number;
} = {}): Promise<SlackPublicArchiveSyncSummary> {
  const installation = await prisma.communicationInstallation.findFirst({
    where: {
      workspaceId,
      provider: "SLACK",
      status: "ACTIVE",
    },
    orderBy: { installedAt: "desc" },
  });
  invariant(installation, 404, "SLACK_NOT_CONNECTED", "Active Slack installation was not found.");
  invariant(installation.scopes.includes("channels:history"), 400, "SLACK_SCOPE_MISSING", "Slack installation is missing channels:history.");

  const lookbackDays = Math.max(0, Math.floor(options.lookbackDays ?? SLACK_PUBLIC_ARCHIVE_LOOKBACK_DAYS));
  const retentionDays = Math.max(1, Math.floor(options.retentionDays ?? rawRetentionDays(installation.settings)));
  const maxMessagesPerChannel = Math.max(0, Math.floor(options.maxMessagesPerChannel ?? 0));
  const autoJoinPublicChannels = installation.scopes.includes("channels:join");
  const client = slackClient(encryptedBotToken(installation));
  const oldest = unixSecondsAgo(lookbackDays);
  const expiresRawAt = rawRetentionDate(retentionDays);
  const archiveInstallation: SlackArchiveInstallation = installation;

  const summary: SlackPublicArchiveSyncSummary = {
    workspaceId,
    installationId: installation.id,
    channelsSeen: 0,
    channelsJoined: 0,
    channelsArchived: 0,
    channelsSkippedNotMember: 0,
    channelsWithReadErrors: 0,
    messagesScanned: 0,
    messagesUpserted: 0,
    cappedChannels: 0,
    lookbackDays,
    retentionDays,
  };

  let cursor: string | undefined;
  do {
    const response = await client.conversations.list({
      types: "public_channel",
      exclude_archived: false,
      limit: SLACK_PUBLIC_ARCHIVE_PAGE_LIMIT,
      cursor,
    });
    const channels = Array.isArray(response.channels)
      ? response.channels.filter((channel): channel is Record<string, unknown> => isRecord(channel))
      : [];

    for (const channel of channels) {
      const channelId = asString(channel.id);
      if (!channelId) continue;
      summary.channelsSeen += 1;

      const isArchived = Boolean(channel.is_archived);
      await prisma.communicationChannel.upsert({
        where: { installationId_externalChannelId: { installationId: installation.id, externalChannelId: channelId } },
        update: {
          name: asString(channel.name) || null,
          kind: "PUBLIC",
          isArchived,
          isIngestEnabled: !isArchived,
          lastSeenAt: new Date(),
        },
        create: {
          installationId: installation.id,
          workspaceId: installation.workspaceId,
          provider: "SLACK",
          externalChannelId: channelId,
          name: asString(channel.name) || null,
          kind: "PUBLIC",
          isArchived,
          isIngestEnabled: !isArchived,
          lastSeenAt: new Date(),
        },
      });

      if (isArchived) {
        summary.channelsArchived += 1;
        continue;
      }

      let canRead = Boolean(channel.is_member);
      if (!canRead && autoJoinPublicChannels) {
        try {
          const join = await client.conversations.join({ channel: channelId });
          if (join.ok) {
            canRead = true;
            summary.channelsJoined += 1;
          }
        } catch (error) {
          const slackError = isRecord(error) && isRecord(error.data) ? asString(error.data.error) : "";
          if (slackError === "method_not_supported_for_channel_type" || slackError === "is_archived") {
            summary.channelsSkippedNotMember += 1;
            continue;
          }
          throw error;
        }
      }

      if (!canRead) {
        summary.channelsSkippedNotMember += 1;
        continue;
      }

      try {
        const result = await syncSlackArchiveChannelHistory({
          client,
          installation: archiveInstallation,
          channelId,
          oldest,
          expiresRawAt,
          maxMessagesPerChannel,
        });
        summary.messagesScanned += result.scanned;
        summary.messagesUpserted += result.upserted;
        if (result.capped) summary.cappedChannels += 1;
      } catch {
        summary.channelsWithReadErrors += 1;
      }
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const settings = isRecord(installation.settings) ? installation.settings : {};
  await prisma.communicationInstallation.update({
    where: { id: installation.id },
    data: {
      settings: {
        ...settings,
        broadPublicIngestion: true,
        autoJoinPublicChannels,
        rawRetentionDays: retentionDays,
        lastPublicArchiveSyncAt: new Date().toISOString(),
      },
      lastError: summary.channelsWithReadErrors > 0
        ? `Public archive sync had ${summary.channelsWithReadErrors} channel read errors.`
        : null,
    },
  });

  return summary;
}

function slackAgentDedupeKey(payload: SlackAgentJobPayload) {
  if (payload.inboundEventId) return `${payload.inboundEventId}:communication-slack-agent`;
  if (payload.sourceMessageId) return `${payload.sourceMessageId}:communication-slack-agent:${payload.source}`;
  const channel = payload.channelId ?? "no-channel";
  const message = payload.messageTs ?? payload.threadTs ?? createHmac("sha256", "slack-agent").update(payload.prompt).digest("hex");
  return `${payload.installationId}:${payload.source}:${channel}:${message}:communication-slack-agent`;
}

export async function enqueueSlackAgentJob(payload: SlackAgentJobPayload) {
  const normalized = compactJsonObject({
    ...payload,
    channelId: payload.channelId ?? null,
    threadTs: payload.threadTs ?? null,
    messageTs: payload.messageTs ?? null,
    messageText: payload.messageText ?? null,
    sourceMessageId: payload.sourceMessageId ?? null,
    inboundEventId: payload.inboundEventId ?? null,
    responseUrlEnc: payload.responseUrlEnc ?? null,
  });

  return prisma.workflowJob.upsert({
    where: { dedupeKey: slackAgentDedupeKey(payload) },
    update: {},
    create: {
      workspaceId: payload.workspaceId,
      type: "communication.slack.agent",
      payload: toInputJson(normalized) as Prisma.InputJsonObject,
      dedupeKey: slackAgentDedupeKey(payload),
    },
  });
}

async function agendaMeetingForSlackThread(workspaceId: string, channelId: string, threadTs: string) {
  if (!channelId || !threadTs) return null;
  return prisma.meeting.findFirst({
    where: {
      workspaceId,
      agendaChannelId: channelId,
      agendaMessageTs: threadTs,
      agendaPostedAt: { not: null },
      archivedAt: null,
    },
    select: { id: true },
  });
}

async function enqueueSlackAgendaEditJob(payload: {
  workspaceId: string;
  meetingId: string;
  actorUserId: string;
  installationId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  messageText: string;
  sourceMessageId?: string | null;
  inboundEventId: string;
}) {
  return prisma.workflowJob.upsert({
    where: { dedupeKey: `${payload.inboundEventId}:meeting-agenda-edit` },
    update: {},
    create: {
      workspaceId: payload.workspaceId,
      type: "meeting.agenda.edit",
      payload: toInputJson({
        meetingId: payload.meetingId,
        actorUserId: payload.actorUserId,
        installationId: payload.installationId,
        channelId: payload.channelId,
        threadTs: payload.threadTs,
        messageTs: payload.messageTs,
        messageText: payload.messageText,
        sourceMessageId: payload.sourceMessageId ?? null,
        inboundEventId: payload.inboundEventId,
      }) as Prisma.InputJsonObject,
      dedupeKey: `${payload.inboundEventId}:meeting-agenda-edit`,
    },
  });
}

function slackAgentWorkingResponse() {
  return {
    response_type: "ephemeral",
    text: "Corgtex is working on that.",
    blocks: [{
      type: "section",
      text: { type: "mrkdwn", text: "Corgtex is working on that. I will reply here with what I did." },
    }],
  };
}

export async function processSlackInboundEvent(inboundEventId: string) {
  const inbound = await prisma.communicationInboundEvent.findUnique({
    where: { id: inboundEventId },
    include: { installation: true },
  });
  if (!inbound || inbound.provider !== "SLACK" || !inbound.installation) return;

  const payload = inbound.payload as Record<string, unknown>;
  const event = isRecord(payload.event) ? payload.event : payload;
  const isDisconnectEvent = event.type === "app_uninstalled" || event.type === "tokens_revoked";

  if (!isDisconnectEvent && inbound.installation.status !== "ACTIVE") {
    await prisma.communicationInboundEvent.update({
      where: { id: inbound.id },
      data: { status: "IGNORED", processedAt: new Date(), error: INACTIVE_SLACK_INSTALLATION_ERROR },
    });
    return;
  }

  try {
    if (isDisconnectEvent) {
      await prisma.communicationInstallation.update({
        where: { id: inbound.installation.id },
        data: { status: "DISCONNECTED", botTokenEnc: null, disconnectedAt: new Date() },
      });
    } else if (event.type === "message") {
      await ingestSlackMessage(inbound.installation, event);
    } else if (event.type === "app_home_opened") {
      const externalUserId = asString(event.user);
      if (externalUserId) {
        await publishSlackHome(inbound.installation.id, externalUserId);
      }
    } else if (event.type === "app_mention") {
      const token = encryptedBotToken(inbound.installation);
      const externalUserId = asString(event.user);
      const actor = externalUserId ? await resolveHumanActorForSlackUser(inbound.installation.id, externalUserId) : null;
      const channelId = asString(event.channel);
      const messageTs = asString(event.ts) || asString(event.event_ts);
      const threadTs = asString(event.thread_ts) || messageTs;
      if (!actor) {
        const accountResponse = slackAccountLinkResponse(inbound.installation.workspaceId);
        if (channelId) {
          await sendSlackMessage(inbound.installation.id, {
            channel: channelId,
            threadTs: threadTs || undefined,
          }, accountResponse.blocks, token);
        }
      } else if (channelId && messageTs) {
        const text = asString(event.text);
        const prompt = stripSlackBotMention(text, inbound.installation.botUserId) || "brief";
        const sourceMessage = await persistSlackSourceMessage(inbound.installation, {
          channelId,
          messageTs,
          threadTs,
          externalUserId,
          text,
          raw: event,
        });
        const agendaMeeting = await agendaMeetingForSlackThread(inbound.installation.workspaceId, channelId, threadTs);
        if (agendaMeeting) {
          await enqueueSlackAgendaEditJob({
            workspaceId: inbound.installation.workspaceId,
            meetingId: agendaMeeting.id,
            actorUserId: actor.user.id,
            installationId: inbound.installation.id,
            channelId,
            threadTs,
            messageTs,
            messageText: prompt,
            sourceMessageId: sourceMessage?.id ?? null,
            inboundEventId: inbound.id,
          });
        } else {
          await enqueueSlackAgentJob({
            source: "app_mention",
            installationId: inbound.installation.id,
            workspaceId: inbound.installation.workspaceId,
            actorUserId: actor.user.id,
            externalUserId,
            prompt,
            channelId,
            threadTs,
            messageTs,
            messageText: text,
            sourceMessageId: sourceMessage?.id ?? null,
            inboundEventId: inbound.id,
          });
        }
      }
    }

    await prisma.communicationInboundEvent.update({
      where: { id: inbound.id },
      data: { status: "PROCESSED", processedAt: new Date(), error: null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Slack event processing error.";
    await prisma.communicationInboundEvent.update({
      where: { id: inbound.id },
      data: { status: "FAILED", error: message },
    });
    await prisma.communicationInstallation.update({
      where: { id: inbound.installation.id },
      data: { status: "ERROR", lastError: message },
    });
    throw error;
  }
}

export async function createWorkItemFromCommunicationSource(actor: AppActor, params: {
  workspaceId: string;
  provider: CommunicationProvider;
  installationId: string;
  kind: CommunicationWorkItemKind;
  title: string;
  bodyMd?: string | null;
  sourceMessageId?: string | null;
  externalUserId?: string | null;
  assigneeMemberId?: string | null;
  raisedByMemberId?: string | null;
  dueAt?: Date | string | null;
  open?: boolean;
}) {
  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Title is required.");
  const sourceNote = params.sourceMessageId ? `\n\n---\nCaptured from ${params.provider} source message.` : "";
  const bodyMd = `${params.bodyMd?.trim() || title}${sourceNote}`;
  const dueAt = typeof params.dueAt === "string" ? new Date(params.dueAt) : params.dueAt ?? null;
  const normalizedDueAt = dueAt instanceof Date && Number.isFinite(dueAt.getTime()) ? dueAt : null;

  let result: { entityType: string; entityId: string };
  if (params.kind === "ACTION") {
    const action = await createAction(actor, {
      workspaceId: params.workspaceId,
      title,
      bodyMd,
      assigneeMemberId: params.assigneeMemberId ?? null,
      dueAt: normalizedDueAt,
      isPrivate: true,
    });
    if (params.open) {
      await publishAction(actor, { workspaceId: params.workspaceId, actionId: action.id });
    }
    result = { entityType: "Action", entityId: action.id };
  } else if (params.kind === "TENSION") {
    const tension = await createTension(actor, {
      workspaceId: params.workspaceId,
      title,
      bodyMd,
      raisedByMemberId: params.raisedByMemberId ?? null,
      isPrivate: true,
    });
    if (params.open) {
      await publishTension(actor, { workspaceId: params.workspaceId, tensionId: tension.id });
    }
    result = { entityType: "Tension", entityId: tension.id };
  } else if (params.kind === "PROPOSAL") {
    const proposal = await createProposal(actor, { workspaceId: params.workspaceId, title, summary: title, bodyMd, isPrivate: true });
    if (params.open) {
      await submitProposal(actor, { workspaceId: params.workspaceId, proposalId: proposal.id });
    }
    result = { entityType: "Proposal", entityId: proposal.id };
  } else {
    const source = await ingestSource(actor, {
      workspaceId: params.workspaceId,
      sourceType: "SLACK",
      tier: 2,
      title,
      content: bodyMd,
      externalId: params.sourceMessageId ?? undefined,
      channel: "slack-capture",
      metadata: toInputJson({
        provider: params.provider,
        installationId: params.installationId,
        externalUserId: params.externalUserId ?? null,
      }),
    });
    result = { entityType: "BrainSource", entityId: source.id };
  }

  await prisma.communicationEntityLink.create({
    data: {
      installationId: params.installationId,
      workspaceId: params.workspaceId,
      provider: params.provider,
      messageId: params.sourceMessageId || null,
      externalUserId: params.externalUserId ?? null,
      entityType: result.entityType,
      entityId: result.entityId,
      action: `create_${params.kind.toLowerCase()}`,
    },
  });

  return {
    ...result,
    webUrl: entityUrl(params.workspaceId, result.entityType, result.entityId),
    opened: Boolean(params.open && params.kind !== "BRAIN_NOTE"),
  };
}

async function commandInstallation(payload: URLSearchParams | Record<string, unknown>) {
  const teamRecord = payload instanceof URLSearchParams ? null : (isRecord(payload.team) ? payload.team : null);
  const teamId = payload instanceof URLSearchParams ? payload.get("team_id") ?? "" : asString(teamRecord?.id) || asString(payload.team_id);
  const installation = teamId ? await slackInstallationByTeam(teamId) : null;
  invariant(installation && installation.status === "ACTIVE", 404, "SLACK_NOT_CONNECTED", "This Slack workspace is not connected to Corgtex.");
  return installation;
}

function slackAccountLinkResponse(workspaceId: string) {
  return {
    response_type: "ephemeral",
    text: "Connect your Corgtex account",
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: `I could not match your Slack account to a Corgtex member. Open ${appUrl(`/workspaces/${workspaceId}/settings`)} and make sure your Slack email matches your Corgtex account.`,
      },
    }],
  };
}

function createdResponse(entityType: string, title: string, url: string, extraBlocks: unknown[] = []) {
  return {
    response_type: "ephemeral",
    text: `${entityType} draft created: ${title}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `Created a private *${entityType}* draft: <${url}|${title}>` },
      },
      ...extraBlocks,
    ],
  };
}

function publishActionBlocks(entityType: string, entityId: string) {
  if (entityType !== "Action" && entityType !== "Tension") return [];
  return [{
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: entityType === "Action" ? "Open action" : "Open tension" },
      action_id: entityType === "Action" ? "corgtex_publish_action" : "corgtex_publish_tension",
      value: JSON.stringify({ entityType, entityId }),
    }],
  }];
}

export async function handleSlackCommand(payload: URLSearchParams) {
  const installation = await commandInstallation(payload);
  const externalUserId = payload.get("user_id") ?? "";
  const actor = await resolveHumanActorForSlackUser(installation.id, externalUserId);
  if (!actor) return slackAccountLinkResponse(installation.workspaceId);

  const rawText = (payload.get("text") ?? "").trim();
  const [commandRaw, ...rest] = rawText.split(/\s+/);
  const command = commandRaw?.toLowerCase() || "brief";
  const text = rest.join(" ").trim();
  const legacyCommands = new Set(["brief", "action", "tension", "proposal"]);

  if (command === "brief") {
    const [actions, tensions, proposals] = await Promise.all([
      prisma.action.findMany({ where: { workspaceId: installation.workspaceId, status: { in: ["OPEN", "IN_PROGRESS"] } }, take: 5, orderBy: { createdAt: "desc" } }),
      prisma.tension.findMany({ where: { workspaceId: installation.workspaceId, status: "OPEN" }, take: 5, orderBy: { createdAt: "desc" } }),
      prisma.proposal.findMany({ where: { workspaceId: installation.workspaceId, status: "OPEN" }, take: 5, orderBy: { createdAt: "desc" } }),
    ]);
    return {
      response_type: "ephemeral",
      text: "Your Corgtex brief",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Corgtex brief" } },
        { type: "section", text: { type: "mrkdwn", text: `*Open actions:* ${actions.length}\n*Open tensions:* ${tensions.length}\n*Open proposals:* ${proposals.length}` } },
        { type: "section", text: { type: "mrkdwn", text: `<${appUrl(`/workspaces/${installation.workspaceId}`)}|Open the full Corgtex newspaper>` } },
      ],
    };
  }

  const kind = command === "action" ? "ACTION" : command === "tension" ? "TENSION" : command === "proposal" ? "PROPOSAL" : null;
  if (!kind && rawText) {
    const responseUrl = payload.get("response_url") ?? "";
    await enqueueSlackAgentJob({
      source: "slash_command",
      installationId: installation.id,
      workspaceId: installation.workspaceId,
      actorUserId: actor.user.id,
      externalUserId,
      prompt: rawText,
      channelId: payload.get("channel_id") || null,
      responseUrlEnc: responseUrl ? encryptSecret(responseUrl) : null,
    });
    return slackAgentWorkingResponse();
  }

  if (!kind || !text || !legacyCommands.has(command)) {
    return {
      response_type: "ephemeral",
      text: "Use `/corgtex <plain text>`, `/corgtex brief`, `/corgtex action <text>`, `/corgtex tension <text>`, or `/corgtex proposal <text>`.",
    };
  }

  const item = await createWorkItemFromCommunicationSource(actor, {
    workspaceId: installation.workspaceId,
    provider: "SLACK",
    installationId: installation.id,
    kind,
    title: text.slice(0, 120),
    bodyMd: text,
    externalUserId,
  });

  return createdResponse(item.entityType, text.slice(0, 120), item.webUrl, publishActionBlocks(item.entityType, item.entityId));
}

export async function handleSlackInteraction(payload: Record<string, unknown>) {
  const installation = await commandInstallation(payload);
  const externalUserId = isRecord(payload.user) ? asString(payload.user.id) : "";
  const actor = await resolveHumanActorForSlackUser(installation.id, externalUserId);
  if (!actor) return slackAccountLinkResponse(installation.workspaceId);

  if (payload.type === "message_action") {
    const message = isRecord(payload.message) ? payload.message : {};
    const channel = isRecord(payload.channel) ? asString(payload.channel.id) : "";
    const messageTs = asString(message.ts);
    const messageText = asString(message.text);
    const threadTs = asString(message.thread_ts) || messageTs;
    const sourceMessage = channel && messageTs
      ? await persistSlackSourceMessage(installation, {
        channelId: channel,
        messageTs,
        threadTs,
        externalUserId: asString(message.user) || null,
        text: messageText,
        raw: { messageAction: true, message },
      })
      : null;
    const responseUrl = asString(payload.response_url);
    await enqueueSlackAgentJob({
      source: "message_shortcut",
      installationId: installation.id,
      workspaceId: installation.workspaceId,
      actorUserId: actor.user.id,
      externalUserId,
      prompt: messageText ? `Act on this Slack message:\n${messageText}` : "Capture this Slack message in Corgtex.",
      channelId: channel || null,
      threadTs,
      messageTs,
      messageText,
      sourceMessageId: sourceMessage?.id ?? null,
      responseUrlEnc: responseUrl ? encryptSecret(responseUrl) : null,
    });
    return slackAgentWorkingResponse();
  }

  if (payload.type === "view_submission") {
    const view = isRecord(payload.view) ? payload.view : {};
    const values = isRecord(isRecord(view.state) ? view.state.values : null) ? (view.state as Record<string, any>).values : {};
    const callbackId = asString(view.callback_id);
    if (callbackId === SLACK_MEETING_ACTION_REVIEW_EDIT_CALLBACK_ID) {
      const result = await updateSlackMeetingActionReviewProposalFromModal(actor, {
        workspaceId: installation.workspaceId,
        privateMetadata: asString(view.private_metadata),
        values,
      });
      await updateSlackMessage(installation.id, {
        channel: result.channelId,
        ts: result.messageTs,
      }, result.blocks, result.text);
      return {};
    }

    const metadata = JSON.parse(asString(view.private_metadata) || "{}") as Record<string, unknown>;
    const kind = asString(values.kind?.value?.selected_option?.value) as CommunicationWorkItemKind;
    const title = asString(values.title?.value?.value);
    const bodyMd = asString(values.body?.value?.value);
    const metadataChannel = asString(metadata.channel);
    const metadataMessageTs = asString(metadata.messageTs);
    const expiresRawAt = rawRetentionDate(rawRetentionDays(installation.settings));
    const sourceMessage = metadataChannel && metadataMessageTs
      ? await prisma.communicationMessage.upsert({
        where: {
          installationId_externalChannelId_externalMessageId: {
            installationId: installation.id,
            externalChannelId: metadataChannel,
            externalMessageId: metadataMessageTs,
          },
        },
        update: {
          externalUserId: asString(metadata.externalUserId) || externalUserId || null,
          text: asString(metadata.messageText) || null,
          messageTs: slackTimestampToDate(metadataMessageTs),
          expiresRawAt,
        },
        create: {
          installationId: installation.id,
          workspaceId: installation.workspaceId,
          provider: "SLACK",
          externalChannelId: metadataChannel,
          externalMessageId: metadataMessageTs,
          externalUserId: asString(metadata.externalUserId) || externalUserId || null,
          text: asString(metadata.messageText) || null,
          messageTs: slackTimestampToDate(metadataMessageTs),
          expiresRawAt,
          raw: toInputJson({ explicitCapture: true }),
        },
        select: { id: true },
      })
      : null;

    await createWorkItemFromCommunicationSource(actor, {
      workspaceId: installation.workspaceId,
      provider: "SLACK",
      installationId: installation.id,
      kind: kind || "ACTION",
      title,
      bodyMd,
      sourceMessageId: sourceMessage?.id ?? null,
      externalUserId,
    });
    return {};
  }

  if (payload.type === "block_actions") {
    const action = Array.isArray(payload.actions) && isRecord(payload.actions[0]) ? payload.actions[0] : null;
    const actionId = asString(action?.action_id);
    if (isSlackMeetingActionReviewAction(actionId)) {
      try {
        const { reviewId, insightId } = parseSlackMeetingActionReviewActionValue(asString(action?.value));
        invariant(reviewId && insightId, 400, "INVALID_INPUT", "Meeting follow-up review action metadata is missing.");

        if (actionId === "corgtex_meeting_review_edit") {
          const triggerId = asString(payload.trigger_id);
          invariant(triggerId, 400, "INVALID_INPUT", "Slack trigger is missing for the edit modal.");
          const view = await buildSlackMeetingActionReviewEditView(actor, {
            workspaceId: installation.workspaceId,
            reviewId,
            insightId,
          });
          await openSlackModal(installation.id, triggerId, view);
          return {};
        }

        const result = actionId === "corgtex_meeting_review_confirm"
          ? await confirmSlackMeetingActionReviewProposal(actor, {
            workspaceId: installation.workspaceId,
            installationId: installation.id,
            externalUserId,
            reviewId,
            insightId,
          })
          : await dismissSlackMeetingActionReviewProposal(actor, {
            workspaceId: installation.workspaceId,
            reviewId,
            insightId,
          });
        await updateSlackMessage(installation.id, {
          channel: result.channelId,
          ts: result.messageTs,
        }, result.blocks, result.text);
        return { response_type: "ephemeral", text: result.responseText };
      } catch (error) {
        if (error instanceof AppError) {
          return { response_type: "ephemeral", text: error.message };
        }
        throw error;
      }
    }

    const value = JSON.parse(asString(action?.value) || "{}") as { entityType?: string; entityId?: string };
    if (actionId === "corgtex_publish_action" && value.entityId) {
      await publishAction(actor, { workspaceId: installation.workspaceId, actionId: value.entityId });
      return { response_type: "ephemeral", text: "Action opened." };
    }
    if (actionId === "corgtex_publish_tension" && value.entityId) {
      await publishTension(actor, { workspaceId: installation.workspaceId, tensionId: value.entityId });
      return { response_type: "ephemeral", text: "Tension opened." };
    }
  }

  return {};
}

export async function sendSlackMessage(installationId: string, target: {
  channel: string;
  threadTs?: string;
  text?: string;
}, blocks: unknown[], tokenOverride?: string) {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
  });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found.");
  const token = tokenOverride ?? encryptedBotToken(installation);

  return slackClient(token).chat.postMessage({
    channel: target.channel,
    thread_ts: target.threadTs,
    text: target.text ?? "Corgtex update",
    blocks: blocks as any,
    unfurl_links: false,
    unfurl_media: false,
  });
}

export async function updateSlackMessage(installationId: string, target: {
  channel: string;
  ts: string;
}, blocks: unknown[], text = "Corgtex update") {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
  });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found.");

  return slackClient(encryptedBotToken(installation)).chat.update({
    channel: target.channel,
    ts: target.ts,
    text,
    blocks: blocks as any,
  });
}

async function openSlackModal(installationId: string, triggerId: string, view: unknown) {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
  });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found.");

  return slackClient(encryptedBotToken(installation)).views.open({
    trigger_id: triggerId,
    view: view as any,
  });
}

export async function validateSlackPostTarget(installationId: string, rawChannelId: string): Promise<SlackPostTargetValidation> {
  const channelId = normalizeSlackChannelId(rawChannelId);
  if (!channelId) {
    return {
      ok: false,
      code: "SLACK_CHANNEL_REQUIRED",
      message: "Choose a Slack channel for agenda posting.",
    };
  }

  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
    select: { id: true, botTokenEnc: true },
  });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found.");

  try {
    const response = await slackClient(encryptedBotToken(installation)).conversations.info({
      channel: channelId,
    });
    const channel = isRecord(response.channel) ? response.channel : null;
    if (!channel) {
      return {
        ok: false,
        code: "SLACK_CHANNEL_NOT_FOUND",
        message: "Slack channel not found. Use a channel ID like C0123456789.",
      };
    }
    if (Boolean(channel.is_archived)) {
      return {
        ok: false,
        code: "SLACK_CHANNEL_ARCHIVED",
        message: "Choose an active Slack channel for agenda posting.",
      };
    }
    if (!Boolean(channel.is_member)) {
      return {
        ok: false,
        code: "SLACK_CHANNEL_NOT_JOINED",
        message: "Invite Corgtex to this channel first, then save agenda posting again.",
      };
    }
    return {
      ok: true,
      channelId,
      channelName: asString(channel.name) || asString(channel.name_normalized) || null,
    };
  } catch (error) {
    const slackCode = (error as { data?: { error?: string } }).data?.error;
    if (slackCode === "not_in_channel") {
      return {
        ok: false,
        code: "SLACK_CHANNEL_NOT_JOINED",
        message: "Invite Corgtex to this channel first, then save agenda posting again.",
      };
    }
    if (slackCode === "channel_not_found") {
      return {
        ok: false,
        code: "SLACK_CHANNEL_NOT_FOUND",
        message: "Slack channel not found. Use a channel ID like C0123456789.",
      };
    }
    return {
      ok: false,
      code: "SLACK_CHANNEL_INVALID",
      message: "Corgtex could not validate that Slack channel. Confirm the channel ID and app membership.",
    };
  }
}

export async function sendSlackEphemeralMessage(installationId: string, target: {
  channel: string;
  user: string;
}, blocks: unknown[], text = "Corgtex update") {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
  });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found.");

  return slackClient(encryptedBotToken(installation)).chat.postEphemeral({
    channel: target.channel,
    user: target.user,
    text,
    blocks: blocks as any,
  });
}

async function postSlackResponseUrl(responseUrlEnc: string, delivery: SlackAgentDelivery) {
  const response = await fetch(decryptSecret(responseUrlEnc), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      response_type: "ephemeral",
      replace_original: false,
      text: delivery.text,
      blocks: delivery.blocks,
    }),
  });
  invariant(response.ok, 502, "SLACK_RESPONSE_FAILED", "Slack response URL rejected the agent reply.");
}

export async function deliverSlackAgentResponse(payload: SlackAgentJobPayload, delivery: SlackAgentDelivery) {
  if (payload.responseUrlEnc) {
    await postSlackResponseUrl(payload.responseUrlEnc, delivery);
    return;
  }

  if (payload.source === "app_mention" && payload.channelId) {
    await sendSlackMessage(payload.installationId, {
      channel: payload.channelId,
      threadTs: payload.threadTs ?? payload.messageTs ?? undefined,
    }, delivery.blocks ?? [{
      type: "section",
      text: { type: "mrkdwn", text: delivery.text },
    }]);
    return;
  }

  if (payload.channelId && payload.externalUserId) {
    await sendSlackEphemeralMessage(payload.installationId, {
      channel: payload.channelId,
      user: payload.externalUserId,
    }, delivery.blocks ?? [{
      type: "section",
      text: { type: "mrkdwn", text: delivery.text },
    }], delivery.text);
  }
}

export async function fetchSlackThreadMessages(installationId: string, params: {
  channelId: string;
  threadTs: string;
  limit?: number;
}) {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
  });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found.");

  try {
    const response = await slackClient(encryptedBotToken(installation)).conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      limit: params.limit ?? 20,
    });
    return (response.messages ?? []).map((message) => ({
      user: asString(message.user),
      text: asString(message.text),
      ts: asString(message.ts),
      threadTs: asString(message.thread_ts),
    })).filter((message) => message.text.length > 0);
  } catch {
    return [];
  }
}

export async function publishSlackHome(installationId: string, externalUserId: string) {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
  });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found.");

  const actor = await resolveHumanActorForSlackUser(installation.id, externalUserId);
  const blocks: any[] = [];
  if (!actor) {
    blocks.push(
      { type: "header", text: { type: "plain_text", text: "Corgtex" } },
      { type: "section", text: { type: "mrkdwn", text: `I could not match this Slack account to a Corgtex member. Open <${appUrl(`/workspaces/${installation.workspaceId}/settings`)}|workspace settings> to connect with a matching email.` } },
    );
  } else {
    const [actions, proposals, tensions, drafts] = await Promise.all([
      prisma.action.findMany({ where: { workspaceId: installation.workspaceId, status: { in: ["OPEN", "IN_PROGRESS"] } }, take: 5, orderBy: { createdAt: "desc" } }),
      prisma.proposal.findMany({ where: { workspaceId: installation.workspaceId, status: "OPEN" }, take: 5, orderBy: { createdAt: "desc" } }),
      prisma.tension.findMany({ where: { workspaceId: installation.workspaceId, status: "OPEN" }, take: 5, orderBy: { createdAt: "desc" } }),
      prisma.communicationEntityLink.findMany({ where: { workspaceId: installation.workspaceId, installationId }, take: 5, orderBy: { createdAt: "desc" } }),
    ]);
    blocks.push(
      { type: "header", text: { type: "plain_text", text: "Today in Corgtex" } },
      { type: "section", text: { type: "mrkdwn", text: `*Open actions:* ${actions.length}\n*Open proposals:* ${proposals.length}\n*Open tensions:* ${tensions.length}\n*Recent Slack captures:* ${drafts.length}` } },
      { type: "section", text: { type: "mrkdwn", text: `<${appUrl(`/workspaces/${installation.workspaceId}`)}|Open the full newspaper>` } },
    );
  }

  return slackClient(encryptedBotToken(installation)).views.publish({
    user_id: externalUserId,
    view: {
      type: "home",
      callback_id: "corgtex_home",
      blocks,
    },
  });
}

export async function purgeExpiredCommunicationMessages(workspaceId?: string) {
  const now = new Date();
  const where = {
      ...(workspaceId ? { workspaceId } : {}),
      expiresRawAt: { lte: now },
      textRedactedAt: null,
  };
  const expired = await prisma.communicationMessage.findMany({
    where,
    select: { id: true },
  });
  const result = await prisma.communicationMessage.updateMany({
    where,
    data: {
      text: null,
      raw: Prisma.DbNull,
      textRedactedAt: now,
    },
  });
  if (expired.length > 0) {
    await prisma.knowledgeChunk.deleteMany({
      where: {
        sourceType: "SLACK",
        sourceId: { in: expired.map((message) => message.id) },
      },
    });
  }
  return result;
}

export async function listSlackMessagesForDigest(workspaceId: string, since: Date, until?: Date) {
  return prisma.communicationMessage.findMany({
    where: {
      workspaceId,
      provider: "SLACK",
      receivedAt: until ? { gte: since, lte: until } : { gte: since },
      text: { not: null },
      isBot: false,
      isHidden: false,
      isDeleted: false,
    },
    orderBy: { receivedAt: "asc" },
    take: 500,
  });
}
