import { createHmac } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { Prisma, type CommunicationInstallation, type CommunicationMessage, type CommunicationProvider } from "@prisma/client";
import {
  decryptSecret,
  encryptSecret,
  env,
  prisma,
  randomOpaqueToken,
  toInputJson,
} from "@corgtex/shared";
import type { AppActor, HumanActor } from "@corgtex/shared";
import { captureSlackSignedIngress, assertSlackSignedIngress, communicationCanonicalJson, communicationNativeHash,
  type SlackSignedIngress } from "./communication-native-ingress";
import { captureSlackNativeMessageFetch, communicationInstallationGrantHash, isCommunicationIngressInputCurrent,
  withSlackNativeCommitReceipt, slackNativeMessageProjection, type SlackNativeFetchReceipt } from "./communication-native-authority";
import { artifactPermissionEpochIdentities, capturePermissionEpochs } from "./source-permission-epochs";
import { requireWorkspaceMembership } from "./auth";
import { loadReadableDigestQuery, captureReadableDigestInputs, isDigestInputProofShared } from "./digest-lineage";
import { createAction, publishAction } from "./actions";
import { ingestSource } from "./brain";
import { mergeLineageInputRoot, withArtifactCountReleaseSnapshot, captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage, preserveUnknownArtifactInputSnapshot, type LineageRoot } from "./source-lineage";
import { AppError, invariant } from "./errors";
import {
  assertMeetingReviewPublicPublication,
  buildSlackMeetingActionReviewEditView,
  confirmSlackMeetingActionReviewProposal,
  dismissSlackMeetingActionReviewProposal,
  isSlackMeetingActionReviewAction,
  parseSlackMeetingActionReviewActionValue,
  refreshSlackMeetingActionReviewAfterWebApply,
  SLACK_MEETING_ACTION_REVIEW_EDIT_CALLBACK_ID,
  updateSlackMeetingActionReviewProposalFromModal,
} from "./meeting-action-review";
import { createProposal, submitProposal } from "./proposals";
import { getSlackWorkspaceBinding } from "./slack-workspace-bindings";
import { reconcileSlackThreadFollowupsAfterMessageChange, slackFollowupStopIntent, suppressSlackThreadFollowups } from "./slack-followups";
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
  requestInputId?: string | null;
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

export { captureSlackSignedIngress } from "./communication-native-ingress";
export function verifySlackRequest(rawBody: string, headers: Headers | Record<string, string | string[] | undefined>, workspaceId?: string) {
  captureSlackSignedIngress(rawBody, headers, workspaceId);
  return true;
}

/** Recheck persisted routing after signature verification, before accepting any scoped payload. */
export async function verifySlackWorkspaceInstallation(workspaceId: string, payload: Record<string, unknown>) {
  const binding = getSlackWorkspaceBinding(workspaceId);
  const teamId = asString(payload.team_id) || (isRecord(payload.team) ? asString(payload.team.id) : "");
  invariant(binding?.source === "workspace" && teamId === binding.teamId && asString(payload.api_app_id) === binding.appId,
    403, "SLACK_TENANT_MISMATCH", "Slack request does not match this workspace configuration.");
  const installation = await slackInstallationByTeam(teamId);
  invariant(installation?.workspaceId === workspaceId && installation.appId === binding.appId,
    403, "SLACK_TENANT_MISMATCH", "Slack installation does not match this workspace configuration.");
}

export async function listCommunicationInstallations(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });

  const installations = await prisma.communicationInstallation.findMany({
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
      _count: { select: { channels: true, externalUsers: true } },
    },
  });
  const counts = new Map<string, number>();
  const roots = new Map<string, LineageRoot>();
  let afterId: string | undefined;
  for (;;) {
    const batch = await prisma.communicationMessage.findMany({
      where: { workspaceId, ...(afterId ? {id: {gt: afterId}} : {}) }, orderBy: {id: "asc"}, take: 100,
    });
    const admitted = await captureReadableDigestInputs({ actor, workspaceId, kind: "CommunicationMessage", records: batch });
    for (const root of admitted.roots) {
      const key = `${root.kind}:${root.id}`;
      roots.set(key, mergeLineageInputRoot(roots.get(key), root));
    }
    for (const message of admitted.records) counts.set(message.installationId, (counts.get(message.installationId) ?? 0) + 1);
    if (batch.length < 100) break;
    afterId = batch[batch.length - 1].id;
  }
  return withArtifactCountReleaseSnapshot(actor, workspaceId, [...roots.values()], async () => undefined, async tx => {
    await requireWorkspaceMembership({actor, workspaceId, allowedRoles: ["ADMIN"], tx});
    return installations.map(installation => ({...installation, _count: {...installation._count, messages: counts.get(installation.id) ?? 0}}));
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

export async function exchangeSlackOAuthCode(code: string, redirectUri: string, workspaceId?: string) {
  const binding = getSlackWorkspaceBinding(workspaceId);
  invariant(binding?.clientId && binding.clientSecret, 503, "SLACK_NOT_CONFIGURED", "Slack OAuth is not configured for this workspace.");

  const response = await slackClient().oauth.v2.access({
    client_id: binding.clientId,
    client_secret: binding.clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  if (!response.ok || !response.team?.id || !response.access_token) {
    throw new Error(`Slack OAuth failed: ${response.error ?? "missing installation data"}`);
  }

  if (binding.source === "workspace") {
    invariant(response.team.id === binding.teamId && response.app_id === binding.appId,
      409, "SLACK_TEAM_MISMATCH", "Slack OAuth response does not match this workspace configuration.");
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

async function findSlackWorkspaceExpectedTeamId(client: SlackBindingPrismaClient, workspaceId: string, configuredTeamFallback?: string | null) {
  const binding = await client.workspaceIntegrationBinding.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "SLACK" } },
    select: { externalWorkspaceId: true },
  });
  if (binding) return binding.externalWorkspaceId;
  if (configuredTeamFallback) return configuredTeamFallback;

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
  const binding = getSlackWorkspaceBinding(workspaceId);
  return findSlackWorkspaceExpectedTeamId(prisma, workspaceId, binding?.source === "workspace" ? binding.teamId : null);
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

  const appBinding = getSlackWorkspaceBinding(params.workspaceId);
  if (appBinding?.source === "workspace") {
    invariant(teamId === appBinding.teamId && params.oauthResponse.app_id === appBinding.appId,
      409, "SLACK_TEAM_MISMATCH", "Slack OAuth response does not match this workspace configuration.");
  }
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
          select: { workspaceId: true, settings: true },
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

      const preservedSettings = existingTeamInstallation && isRecord(existingTeamInstallation.settings)
        ? existingTeamInstallation.settings : slackArchiveSettings(grantedScopes);
      const settings = appBinding?.source === "workspace"
        ? { ...preservedSettings, channelAdmissionMode: "selected", publicArchiveSyncEnabled: false,
          broadPublicIngestion: false, autoJoinPublicChannels: false }
        : preservedSettings;
      const persistedBinding = await tx.workspaceIntegrationBinding.upsert({
        where: { workspaceId_provider: { workspaceId: params.workspaceId, provider: "SLACK" } },
        update: {
          externalOrgId: params.oauthResponse.enterprise?.id ?? null,
          externalTeamName: params.oauthResponse.team?.name ?? null,
          appId: params.oauthResponse.app_id ?? appBinding?.appId ?? null,
          installedByUserId: params.installedByUserId ?? null,
        },
        create: {
          workspaceId: params.workspaceId,
          provider: "SLACK",
          externalWorkspaceId: teamId,
          externalOrgId: params.oauthResponse.enterprise?.id ?? null,
          externalTeamName: params.oauthResponse.team?.name ?? null,
          appId: params.oauthResponse.app_id ?? appBinding?.appId ?? null,
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
          appId: params.oauthResponse.app_id ?? appBinding?.appId ?? null,
          botUserId: params.oauthResponse.bot_user_id ?? null,
          botTokenEnc,
          scopes: grantedScopes,
          optionalScopes,
          status: "ACTIVE",
          installedByUserId: params.installedByUserId ?? null,
          installedAt: new Date(),
          disconnectedAt: null,
          lastError: null,
          settings,
        },
        create: {
          workspaceId: params.workspaceId,
          provider: "SLACK",
          externalWorkspaceId: teamId,
          externalOrgId: params.oauthResponse.enterprise?.id ?? null,
          externalTeamName: params.oauthResponse.team?.name ?? null,
          appId: params.oauthResponse.app_id ?? appBinding?.appId ?? null,
          botUserId: params.oauthResponse.bot_user_id ?? null,
          botTokenEnc,
          scopes: grantedScopes,
          optionalScopes,
          installedByUserId: params.installedByUserId ?? null,
          settings,
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
  const appBinding = getSlackWorkspaceBinding(installation.workspaceId);
  if (appBinding?.source === "workspace" && (appBinding.teamId !== teamId || appBinding.appId !== installation.appId)) return null;

  const binding = await prisma.workspaceIntegrationBinding.findUnique({
    where: { workspaceId_provider: { workspaceId: installation.workspaceId, provider: "SLACK" } },
    select: { externalWorkspaceId: true },
  });
  if (binding && binding.externalWorkspaceId !== teamId) return null;

  return installation;
}

export async function ingestCommunicationEvent(provider: CommunicationProvider, rawEvent: Record<string, unknown>, signedIngress?: SlackSignedIngress) {
  invariant(provider === "SLACK", 400, "UNSUPPORTED_PROVIDER", "Native communication verification is available for Slack only.");
  // Exact immutable signed bytes, rather than a caller-provided authentication flag.
  assertSlackSignedIngress(signedIngress, rawEvent, signedIngress?.workspaceId ?? undefined);
  rawEvent = signedIngress.payload as Record<string, unknown>;
  const teamId = asString(rawEvent.team_id) || (isRecord(rawEvent.team) ? asString(rawEvent.team.id) : "");
  const event = isRecord(rawEvent.event) ? rawEvent.event : rawEvent;
  const eventType = asString(event.type) || asString(rawEvent.type) || "unknown";
  const externalEventId = asString(rawEvent.event_id) || asString(event.event_ts) || null;
  const dedupeKey = `SLACK:${teamId}:${externalEventId ?? signedIngress.bodyHash}`;
  const installation = teamId ? await slackInstallationByTeam(teamId) : null;
  invariant(installation?.status === "ACTIVE" && installation.appId && installation.appId === asString(rawEvent.api_app_id),
    403, "SLACK_TENANT_MISMATCH", "An exact active Slack app installation is required.");
  assertSlackSignedIngress(signedIngress, rawEvent, installation.workspaceId);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "CommunicationInstallation" WHERE "id" = ${installation.id} FOR SHARE`;
    const current = await tx.communicationInstallation.findUnique({ where: { id: installation.id } });
    invariant(current && communicationInstallationGrantHash(current) === communicationInstallationGrantHash(installation),
      409, "SOURCE_CHANGED", "Slack installation changed before accepting the signed request.");
    assertSlackSignedIngress(signedIngress, rawEvent, installation.workspaceId);
    const existing = await tx.communicationInboundEvent.findUnique({ where: { dedupeKey } });
    if (existing) {
      // A historic raw dedupe row cannot be silently promoted into authenticated native ingress.
      invariant(existing.ingressInputId, 409, "UNKNOWN_LINEAGE", "The prior Slack event has no authenticated original receipt.");
      return { inboundEventId: existing.id, duplicate: true };
    }
    const permissionEpochsJson = await capturePermissionEpochs(tx, installation.workspaceId,
      artifactPermissionEpochIdentities("CommunicationIngressInput", { workspaceId: installation.workspaceId,
        installationId: installation.id, externalChannelId: asString(event.channel) || undefined }));
    const ingress = await tx.communicationIngressInput.create({ data: {
      workspaceId: installation.workspaceId, installationId: installation.id, provider: "SLACK",
      externalWorkspaceId: teamId, appId: installation.appId, ingressKind: "EVENT", externalEventId,
      requestTimestamp: signedIngress.requestTimestamp, signature: signedIngress.signature,
      signingBindingHash: signedIngress.signingBindingHash, installationGrantHash: communicationInstallationGrantHash(installation),
      encryptedRawBody: encryptSecret(signedIngress.rawBody), bodyHash: signedIngress.bodyHash,
      permissionEpochsJson: toInputJson(permissionEpochsJson), epochProofVersion: 1,
      expiresRawAt: rawRetentionDate(rawRetentionDays(installation.settings)), receivedAt: new Date(signedIngress.receivedAtMs),
    } });
    const inbound = await tx.communicationInboundEvent.create({ data: { provider: "SLACK", installationId: installation.id,
      workspaceId: installation.workspaceId, ingressInputId: ingress.id, externalEventId, eventType, dedupeKey,
      payload: toInputJson(rawEvent), status: "PENDING" } });
    await tx.communicationInstallation.update({ where: { id: installation.id }, data: { lastEventAt: new Date(), lastError: null } });
    await tx.workflowJob.upsert({ where: { dedupeKey: `${inbound.id}:communication-slack-event` }, update: {},
      create: { workspaceId: installation.workspaceId, type: "communication.slack.event",
        payload: { inboundEventId: inbound.id }, dedupeKey: `${inbound.id}:communication-slack-event` } });
    return { inboundEventId: inbound.id, duplicate: false };
  });
}

async function resolveHumanActorForSlackUser(installation: Pick<CommunicationInstallation, "id" | "workspaceId" | "provider" | "status" | "botTokenEnc">, externalUserId: string): Promise<HumanActor | null> {
  const installationId = installation.id;
  if (!externalUserId.trim() || installation.provider !== "SLACK" || installation.status !== "ACTIVE") return null;
  const authorizedActor = async (user: HumanActor["user"]): Promise<HumanActor | null> => {
    const actor: HumanActor = { kind: "user", user };
    try {
      await requireWorkspaceMembership({ actor, workspaceId: installation.workspaceId });
      return actor;
    } catch (error) {
      if (error instanceof AppError && error.status === 403) return null;
      throw error;
    }
  };
  const mapped = await prisma.communicationExternalUser.findUnique({
    where: { installationId_externalUserId: { installationId, externalUserId } },
  });

  if (mapped?.isBot || mapped?.isDeleted) return null;
  if (mapped?.userId) {
    const user = await prisma.user.findUnique({
      where: { id: mapped.userId },
      select: { id: true, email: true, displayName: true, globalRole: true, isSupportAccount: true },
    });
    if (user) return authorizedActor(user);
  }

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
        select: { id: true, email: true, displayName: true, globalRole: true, isSupportAccount: true },
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

    if (profile.user?.is_bot || profile.user?.deleted) return null;
    return user ? await authorizedActor(user) : null;
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

async function ensureSlackChannel(installation: { id: string; workspaceId: string; settings?: Prisma.JsonValue | null }, event: Record<string, unknown>) {
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
      isIngestEnabled: kind === "PUBLIC" && !(isRecord(installation.settings) && installation.settings.channelAdmissionMode === "selected"),
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

/** Atomically install a canonical native body and its complete authenticated-fetch receipt. */
async function persistNativeSlackMessage(actor: AppActor, receipt: SlackNativeFetchReceipt, expiresRawAt: Date, ingressInputId: string | null = null) {
  const target = receipt.target;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "CommunicationInstallation" WHERE "id" = ${target.installationId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "CommunicationChannel" WHERE "installationId" = ${target.installationId} AND "externalChannelId" = ${target.channelId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "CommunicationMessage" WHERE "installationId" = ${target.installationId} AND "externalChannelId" = ${target.channelId} AND "externalMessageId" = ${target.messageTs} FOR UPDATE`;
    const installation = await tx.communicationInstallation.findUnique({ where: { id: target.installationId } });
    invariant(installation && communicationInstallationGrantHash(installation) === receipt.installationGrantHash,
      409, "SOURCE_CHANGED", "Slack authority changed before native persistence.");
    const existing = await tx.communicationMessage.findFirst({ where: { workspaceId: target.workspaceId, installationId: target.installationId,
      externalChannelId: target.channelId, externalMessageId: target.messageTs } });
    invariant(!existing || (!existing.isBot && !existing.isHidden && !existing.isDeleted && !existing.textRedactedAt
      && (!existing.expiresRawAt || existing.expiresRawAt.getTime() > Date.now())),
    409, "SOURCE_CHANGED", "A retired Slack message cannot be revived by a refetch.");
    // Preserve exact unproven history without allowing it to influence the regenerated body.
    if (existing) await preserveUnknownArtifactInputSnapshot(tx, target.workspaceId, { kind: "CommunicationMessage", id: existing.id }, existing);
    const projected = receipt.projected;
    const values = { externalUserId: String(projected.user), threadExternalId: typeof projected.thread_ts === "string" ? projected.thread_ts : null,
      text: String(projected.text), raw: toInputJson(projected), messageTs: slackTimestampToDate(target.messageTs),
      receivedAt: slackTimestampToDate(target.messageTs)!,
      expiresRawAt: existing?.expiresRawAt && existing.expiresRawAt < expiresRawAt ? existing.expiresRawAt : expiresRawAt,
      permalink: null, isBot: false, isHidden: false, isDeleted: false, textRedactedAt: null };
    invariant(values.expiresRawAt.getTime() > Date.now(), 409, "SOURCE_RESTRICTED", "The Slack original retention period expired.");
    const unchanged = existing && existing.externalUserId === values.externalUserId && existing.threadExternalId === values.threadExternalId
      && existing.text === values.text && communicationCanonicalJson(existing.raw) === communicationCanonicalJson(values.raw)
      && existing.receivedAt.getTime() === values.receivedAt.getTime()
      && existing.messageTs?.getTime() === values.messageTs?.getTime() && existing.expiresRawAt?.getTime() === values.expiresRawAt.getTime()
      && existing.permalink === null;
    const message = unchanged ? existing : await tx.communicationMessage.upsert({ where: { installationId_externalChannelId_externalMessageId: {
      installationId: target.installationId, externalChannelId: target.channelId, externalMessageId: target.messageTs } }, update: values,
      create: { ...values, workspaceId: target.workspaceId, installationId: target.installationId, provider: "SLACK",
        externalChannelId: target.channelId, externalMessageId: target.messageTs } });
    // Message INSERT/UPDATE permission triggers have run before the epoch vector is captured.
    const permissionEpochsJson = await capturePermissionEpochs(tx, target.workspaceId,
      artifactPermissionEpochIdentities("CommunicationMessage", message));
    const input = await tx.communicationMessageNativeInput.create({ data: { workspaceId: target.workspaceId,
      installationId: target.installationId, communicationMessageId: message.id, provider: "SLACK",
      externalWorkspaceId: installation.externalWorkspaceId, appId: installation.appId, providerPrincipalId: receipt.providerPrincipalId,
      externalChannelId: target.channelId, externalMessageId: target.messageTs, externalUserId: message.externalUserId,
      threadExternalId: message.threadExternalId, mode: "AUTHENTICATED_FETCH", ingressInputId,
      requestJson: toInputJson({...receipt.request,messageContentFingerprint:lineageContentFingerprint("CommunicationMessage",message)}), encryptedPayloadJson: encryptSecret(communicationCanonicalJson(receipt.payload)),
      projectedContentJson: toInputJson(projected), projectionHash: communicationNativeHash(communicationCanonicalJson(projected)),
      installationGrantHash: receipt.installationGrantHash, channelGrantHash: receipt.channelGrantHash,
      permissionEpochsJson: toInputJson(permissionEpochsJson), epochProofVersion: 1, expiresRawAt: values.expiresRawAt,
      fetchedAt: new Date(receipt.capturedAtMs) } });
    await withSlackNativeCommitReceipt(actor, target.workspaceId, input.id, tx, receipt, async () => {
      await recordArtifactInputLineage({ tx, actor, workspaceId: target.workspaceId, artifact: { kind: "CommunicationMessage", id: message.id },
        content: message, origin: "DERIVED", inputs: [{ kind: "CommunicationMessageNativeInput", id: input.id }] });
    });
    return message;
  });
}
function slackNativeWorkerActor(workspaceId: string): AppActor {
  return { kind: "agent", authProvider: "bootstrap", label: "slack-native-public-ingestion", workspaceIds: [workspaceId] };
}

async function ingestSlackMessage(installation: { id: string; workspaceId: string; provider: CommunicationProvider; settings?: Prisma.JsonValue | null }, event: Record<string, unknown>) {
  const normalized = normalizeSlackMessageEvent(event);
  const externalChannelId = normalized.externalChannelId;
  const ts = normalized.ts;
  if (!externalChannelId || !ts) return { skipped: true, reason: "missing_channel_or_ts" };

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
      await reconcileSlackThreadFollowupsAfterMessageChange({
        workspaceId: installation.workspaceId,
        installationId: installation.id,
        channelId: externalChannelId,
        threadTs: existing.threadExternalId || existing.externalMessageId,
        messageId: existing.id,
      });
      await deleteSlackMessageKnowledge(existing.id);
      await enqueueSlackMessageContextJobs({
        installation,
        message: { ...existing, updatedAt: new Date() },
        syncKnowledge: false,
      });
    }
    return { skipped: true, reason: "message_deleted" };
  }

  // Edits to an already stored message must still correct its stop marker while
  // public ingestion or its channel is paused. Never admit a new message here.
  const reconcileHeldEdit = async () => {
    if (normalized.subtype !== "message_changed" || normalized.hidden || normalized.isBot) return;
    const existing = await prisma.communicationMessage.findUnique({
      where: {
        installationId_externalChannelId_externalMessageId: {
          installationId: installation.id,
          externalChannelId,
          externalMessageId: ts,
        },
      },
      select: { id: true, threadExternalId: true },
    });
    if (!existing) return;
    await prisma.communicationMessage.updateMany({
      where: { id: existing.id, installationId: installation.id },
      data: { text: null, raw: Prisma.DbNull, textRedactedAt: new Date() },
    });
    await deleteSlackMessageKnowledge(existing.id);
    const threadTs = existing.threadExternalId || ts;
    if (normalized.text && slackFollowupStopIntent(normalized.text)) {
      await suppressSlackThreadFollowups({
        workspaceId: installation.workspaceId,
        installationId: installation.id,
        channelId: externalChannelId,
        threadTs,
        messageId: existing.id,
        externalUserId: normalized.externalUserId,
      });
    } else {
      await reconcileSlackThreadFollowupsAfterMessageChange({
        workspaceId: installation.workspaceId,
        installationId: installation.id,
        channelId: externalChannelId,
        threadTs,
        messageId: existing.id,
      });
    }
  };

  if (isRecord(installation.settings) && installation.settings.publicIngestionEnabled === false) {
    await reconcileHeldEdit();
    return { skipped: true, reason: "public_ingestion_disabled" };
  }
  const channel = await ensureSlackChannel(installation, {
    ...event,
    channel: externalChannelId,
  });
  if (!channel || channel.kind !== "PUBLIC" || !channel.isIngestEnabled) {
    await reconcileHeldEdit();
    return { skipped: true, reason: "channel_not_ingested" };
  }

  if (normalized.hidden || normalized.isBot) {
    return { skipped: true, reason: "excluded_message_type" };
  }

  const text = normalized.text;
  const expiresRawAt = rawRetentionDate(rawRetentionDays(installation.settings));
  const receipt = await captureSlackNativeMessageFetch({ workspaceId: installation.workspaceId, installationId: installation.id,
    channelId: externalChannelId, messageTs: ts, threadTs: normalized.threadTs });
  invariant(receipt.projected.text === text && receipt.projected.user === normalized.externalUserId,
    409, "SOURCE_CHANGED", "The signed Slack event no longer matches the current original message.");
  const message = await persistNativeSlackMessage(slackNativeWorkerActor(installation.workspaceId), receipt, expiresRawAt);

  if (text && slackFollowupStopIntent(text)) {
    await suppressSlackThreadFollowups({
      workspaceId: installation.workspaceId,
      installationId: installation.id,
      channelId: externalChannelId,
      threadTs: normalized.threadTs || ts,
      messageId: message.id,
      externalUserId: normalized.externalUserId,
    });
  } else if (asString(event.subtype) === "message_changed") {
    await reconcileSlackThreadFollowupsAfterMessageChange({
      workspaceId: installation.workspaceId,
      installationId: installation.id,
      channelId: externalChannelId,
      threadTs: normalized.threadTs || ts,
      messageId: message.id,
    });
  }

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

  await ensureSlackChannel(installation, { channel: params.channelId });
  const receipt = await captureSlackNativeMessageFetch({ workspaceId: installation.workspaceId, installationId: installation.id,
    channelId: params.channelId, messageTs: params.messageTs, threadTs: params.threadTs });
  invariant(receipt.projected.text === (params.text ?? "") && receipt.projected.user === params.externalUserId,
    409, "SOURCE_CHANGED", "The authenticated Slack event changed before capture.");
  const message = await persistNativeSlackMessage(slackNativeWorkerActor(installation.workspaceId), receipt,
    rawRetentionDate(rawRetentionDays(installation.settings)));
  if (params.text?.trim()) await enqueueSlackMessageContextJobs({ installation, message });

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

  try { slackNativeMessageProjection(params.message, {workspaceId:params.installation.workspaceId,installationId:params.installation.id,
    channelId:params.channelId,messageTs:ts,threadTs:asString(params.message.thread_ts)||null}); }
  catch { return false; }
  const receipt = await captureSlackNativeMessageFetch({ workspaceId: params.installation.workspaceId, installationId: params.installation.id,
    channelId: params.channelId, messageTs: ts, threadTs: asString(params.message.thread_ts) || null });
  invariant(receipt.projected.text === asString(params.message.text) && receipt.projected.user === asString(params.message.user),
    409, "SOURCE_CHANGED", "The Slack archive source changed before persistence.");
  const message = await persistNativeSlackMessage(slackNativeWorkerActor(params.installation.workspaceId), receipt, params.expiresRawAt);

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

export function slackPublicArchiveEnabled(settings: unknown): boolean {
  return !isRecord(settings) || (settings.publicArchiveSyncEnabled !== false
    && settings.publicIngestionEnabled !== false && settings.broadPublicIngestion !== false
    && settings.channelAdmissionMode !== "selected");
}

export async function syncSlackPublicArchiveForWorkspace(workspaceId: string, options: {
  lookbackDays?: number;
  retentionDays?: number;
  maxMessagesPerChannel?: number;
} = {}): Promise<SlackPublicArchiveSyncSummary> {
  options = structuredClone(options);
  const installation = await prisma.communicationInstallation.findFirst({
    where: {
      workspaceId,
      provider: "SLACK",
      status: "ACTIVE",
    },
    orderBy: { installedAt: "desc" },
  });
  invariant(installation, 404, "SLACK_NOT_CONNECTED", "Active Slack installation was not found.");

  const lookbackDays = Math.max(0, Math.floor(options.lookbackDays ?? SLACK_PUBLIC_ARCHIVE_LOOKBACK_DAYS));
  const retentionDays = Math.max(1, Math.floor(options.retentionDays ?? rawRetentionDays(installation.settings)));
  const maxMessagesPerChannel = Math.max(0, Math.floor(options.maxMessagesPerChannel ?? 0));
  const autoJoinPublicChannels = installation.scopes.includes("channels:join")
    && !(isRecord(installation.settings) && installation.settings.autoJoinPublicChannels === false);
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

  // Also fence already-queued archive jobs after a reconnect or an administrator hold.
  if (!slackPublicArchiveEnabled(installation.settings)) return summary;
  invariant(installation.scopes.includes("channels:history"), 400, "SLACK_SCOPE_MISSING", "Slack installation is missing channels:history.");
  const client = slackClient(encryptedBotToken(installation));

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

  // Permission-bearing settings are configured before capture. A post-sync settings
  // mutation would revoke every receipt captured by this same archive pass.
  await prisma.communicationInstallation.update({
    where: { id: installation.id },
    data: {
      lastError: summary.channelsWithReadErrors > 0
        ? `Public archive sync had ${summary.channelsWithReadErrors} channel read errors.`
        : null,
    },
  });

  return summary;
}

function slackAgentDedupeKey(payload: SlackAgentJobPayload) {
  if (payload.requestInputId?.startsWith("slack-request:")) return `${payload.requestInputId}:communication-slack-agent`;
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
    requestInputId: payload.requestInputId ?? null,
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

  const workerActor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "slack-native-ingress", workspaceIds: [inbound.installation.workspaceId] };
  const ingress = inbound.ingressInputId ? await prisma.communicationIngressInput.findFirst({ where: {
    id: inbound.ingressInputId, workspaceId: inbound.installation.workspaceId, installationId: inbound.installation.id } }) : null;
  if (!ingress || !await isCommunicationIngressInputCurrent(workerActor, inbound.installation.workspaceId, ingress)
    || communicationCanonicalJson(inbound.payload) !== communicationCanonicalJson(JSON.parse(decryptSecret(ingress.encryptedRawBody)))) {
    await prisma.communicationInboundEvent.update({ where: { id: inbound.id }, data: {
      status: "IGNORED", processedAt: new Date(), error: "Authenticated Slack ingress is unavailable." } });
    return;
  }
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
      const channelId = asString(event.channel);
      const messageTs = asString(event.ts) || asString(event.event_ts);
      const threadTs = asString(event.thread_ts) || messageTs;
      const text = asString(event.text);
      const stopRequest = slackFollowupStopIntent(text);
      const actor = !stopRequest && externalUserId ? await resolveHumanActorForSlackUser(inbound.installation, externalUserId) : null;
      if (channelId && messageTs && stopRequest) {
        const sourceMessage = await persistSlackSourceMessage(inbound.installation, {
          channelId,
          messageTs,
          threadTs,
          externalUserId,
          text,
          raw: event,
        });
        if (sourceMessage) {
          await suppressSlackThreadFollowups({
            workspaceId: inbound.installation.workspaceId,
            installationId: inbound.installation.id,
            channelId,
            threadTs,
            messageId: sourceMessage.id,
            externalUserId,
          });
        }
        await sendSlackMessage(inbound.installation.id, {
          channel: channelId,
          threadTs,
          text: "I will stop Corgtex follow-ups in this thread.",
        }, [], token);
      } else if (!actor) {
        const accountResponse = slackAccountLinkResponse(inbound.installation.workspaceId);
        if (channelId) {
          await sendSlackMessage(inbound.installation.id, {
            channel: channelId,
            threadTs: threadTs || undefined,
          }, accountResponse.blocks, token);
        }
      } else if (channelId && messageTs) {
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
    const message = "Slack event processing failed.";
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
  lineageRoots?: LineageRoot[];
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
  claimKey?: string | null;
}) {
  if (params.lineageRoots) {
    invariant(params.lineageRoots.length > 0 && await isArtifactInputProofReadable(actor, params.workspaceId, params.lineageRoots),
      409, "SOURCE_CHANGED", "Communication inputs changed before persistence.");
  }
  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Title is required.");
  const claimKey = params.claimKey?.trim() || null;
  invariant(params.claimKey == null || claimKey, 400, "INVALID_INPUT", "Communication claim key cannot be blank.");
  invariant(!claimKey || claimKey.length <= 191, 400, "INVALID_INPUT", "Communication claim key must be 191 characters or fewer.");
  invariant(!claimKey || (params.kind === "ACTION" && params.open === true), 400, "INVALID_INPUT", "Communication claim keys require an open Action.");
  const sourceNote = params.sourceMessageId ? `\n\n---\nCaptured from ${params.provider} source message.` : "";
  const bodyMd = `${params.bodyMd?.trim() || title}${sourceNote}`;
  const dueAt = typeof params.dueAt === "string" ? new Date(params.dueAt) : params.dueAt ?? null;
  const normalizedDueAt = dueAt instanceof Date && Number.isFinite(dueAt.getTime()) ? dueAt : null;
  if (params.kind === "ACTION" && params.open) {
    invariant(params.assigneeMemberId, 400, "INVALID_INPUT", "Assign an active human member before opening this Action.");
  }

  if (claimKey) {
    try {
      const action = await prisma.$transaction(async (tx) => {
        const created = await createAction(actor, {
          workspaceId: params.workspaceId,
          lineageRoots: params.lineageRoots,
          title,
          bodyMd,
          assigneeMemberId: params.assigneeMemberId ?? null,
          dueAt: normalizedDueAt,
          isPrivate: false,
          source: { type: "COMMUNICATION_CLAIM", id: claimKey },
          _tx: tx,
        });
        await tx.communicationEntityLink.create({
          data: {
            installationId: params.installationId,
            workspaceId: params.workspaceId,
            provider: params.provider,
            messageId: params.sourceMessageId || null,
            externalUserId: params.externalUserId ?? null,
            claimKey,
            entityType: "Action",
            entityId: created.id,
            action: "create_action",
          },
        });
        return created;
      });
      return {
        entityType: "Action",
        entityId: action.id,
        webUrl: entityUrl(params.workspaceId, "Action", action.id),
        opened: true,
      };
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) throw error;
      const existing = await prisma.communicationEntityLink.findUnique({
        where: { workspaceId_claimKey: { workspaceId: params.workspaceId, claimKey } },
      });
      if (!existing
        || existing.installationId !== params.installationId
        || existing.provider !== params.provider
        || existing.messageId !== (params.sourceMessageId || null)
        || existing.entityType !== "Action"
        || existing.action !== "create_action") {
        throw error;
      }
      return {
        entityType: "Action",
        entityId: existing.entityId,
        webUrl: entityUrl(params.workspaceId, "Action", existing.entityId),
        opened: true,
      };
    }
  }

  let result: { entityType: string; entityId: string };
  if (params.kind === "ACTION") {
    const action = await createAction(actor, {
      workspaceId: params.workspaceId,
      lineageRoots: params.lineageRoots,
      title,
      bodyMd,
      assigneeMemberId: params.assigneeMemberId ?? null,
      dueAt: normalizedDueAt,
      isPrivate: true,
      source: params.sourceMessageId
        ? { type: "COMMUNICATION_MESSAGE", id: `${params.installationId}:${params.sourceMessageId}` }
        : undefined,
    });
    if (params.open && action.status === "DRAFT") {
      await publishAction(actor, { workspaceId: params.workspaceId, actionId: action.id });
    }
    result = { entityType: "Action", entityId: action.id };
  } else if (params.kind === "TENSION") {
    const tension = await createTension(actor, {
      workspaceId: params.workspaceId,
      lineageRoots: params.lineageRoots,
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
    const proposal = await createProposal(actor, { workspaceId: params.workspaceId, lineageRoots: params.lineageRoots, title, summary: title, bodyMd, isPrivate: true });
    if (params.open) {
      await submitProposal(actor, { workspaceId: params.workspaceId, proposalId: proposal.id });
    }
    result = { entityType: "Proposal", entityId: proposal.id };
  } else {
    const source = await ingestSource(actor, {
      lineageRoots: params.lineageRoots,
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
  const appId = payload instanceof URLSearchParams ? payload.get("api_app_id") : asString(payload.api_app_id);
  invariant(installation.appId && appId === installation.appId,403,"SLACK_TENANT_MISMATCH","The signed Slack command app binding is unavailable.");
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
  if (entityType !== "Tension") return [];
  return [{
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: "Open tension" },
      action_id: "corgtex_publish_tension",
      value: JSON.stringify({ entityType, entityId }),
    }],
  }];
}

export async function handleSlackCommand(payload: URLSearchParams, signedIngress?: SlackSignedIngress) {
  payload = new URLSearchParams(payload);
  const installation = await commandInstallation(payload);
  assertSlackSignedIngress(signedIngress, Object.fromEntries(payload), installation.workspaceId);
  const externalUserId = payload.get("user_id") ?? "";
  const actor = await resolveHumanActorForSlackUser(installation, externalUserId);
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
    const requestInputId = await mintSlackAgentRequest(actor, { workspaceId: installation.workspaceId, installationId: installation.id,
      externalUserId, channelId: payload.get("channel_id") || "", prompt: rawText,
      source: "slash_command", triggerId: payload.get("trigger_id") || undefined });
    await enqueueSlackAgentJob({
      source: "slash_command",
      requestInputId,
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

  return createdResponse(item.entityType, text.slice(0, 120), item.webUrl,
    item.entityType === "Action"
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: "Assign an active human owner in Corgtex before opening this Action." }] }]
      : publishActionBlocks(item.entityType, item.entityId));
}

export async function handleSlackInteraction(payload: Record<string, unknown>, signedIngress?: SlackSignedIngress) {
  payload = structuredClone(payload);
  const installation = await commandInstallation(payload);
  assertSlackSignedIngress(signedIngress, payload, installation.workspaceId);
  const externalUserId = isRecord(payload.user) ? asString(payload.user.id) : "";
  const actor = await resolveHumanActorForSlackUser(installation, externalUserId);
  if (!actor) return slackAccountLinkResponse(installation.workspaceId);

  if (payload.type === "message_action") {
    const message = isRecord(payload.message) ? payload.message : {};
    const channel = isRecord(payload.channel) ? asString(payload.channel.id) : "";
    const messageTs = asString(message.ts);
    const messageText = asString(message.text);
    const threadTs = asString(message.thread_ts) || messageTs;
    invariant(channel && messageTs, 409, "UNKNOWN_LINEAGE", "The selected Slack message is unavailable.");
    const records = await fetchAndPersistReadableSlackThreadMessages(actor, {
      workspaceId: installation.workspaceId, installationId: installation.id, channelId: channel, threadTs, limit: 200,
    });
    const sourceMessage = records.find(record => record.externalMessageId === messageTs
      && record.externalUserId === asString(message.user) && record.text === messageText);
    invariant(sourceMessage, 409, "SOURCE_CHANGED", "The selected Slack message changed before capture.");
    const requestInputId = await mintSlackAgentRequest(actor, { workspaceId: installation.workspaceId, installationId: installation.id,
      externalUserId, channelId: channel, prompt: "Act on the selected Slack message.", source: "message_shortcut",
      triggerId: asString(payload.trigger_id) || undefined, sourceMessageId: sourceMessage.id });
    const responseUrl = asString(payload.response_url);
    await enqueueSlackAgentJob({
      source: "message_shortcut",
      requestInputId,
      installationId: installation.id,
      workspaceId: installation.workspaceId,
      actorUserId: actor.user.id,
      externalUserId,
      prompt: "Act on the selected Slack message.",
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
      await assertMeetingReviewPublicPublication(actor, {
        workspaceId: installation.workspaceId, installationId: installation.id,
        channelId: result.channelId, lineageRoots: result.lineageRoots,
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
    const sourceMessage = metadataChannel && metadataMessageTs
      ? (await fetchAndPersistReadableSlackThreadMessages(actor, { workspaceId: installation.workspaceId,
        installationId: installation.id, channelId: metadataChannel, threadTs: metadataMessageTs }))
        .find(message => message.externalMessageId === metadataMessageTs) ?? null
      : null;
    invariant(!metadataMessageTs || sourceMessage, 409, "SOURCE_CHANGED", "The actual Slack source message is unavailable.");

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
        await assertMeetingReviewPublicPublication(actor, {
          workspaceId: installation.workspaceId, installationId: installation.id,
          channelId: result.channelId, lineageRoots: result.lineageRoots,
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

export async function slackSourceLink(installationId: string, channelId: string, messageTs: string) {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
    select: { botTokenEnc: true, externalWorkspaceId: true },
  });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found.");
  const channelLink = {
    url: `https://app.slack.com/client/${encodeURIComponent(installation.externalWorkspaceId)}/${encodeURIComponent(channelId)}`,
    label: "Slack channel",
  };
  try {
    const response = await slackClient(encryptedBotToken(installation)).chat.getPermalink({ channel: channelId, message_ts: messageTs });
    return response.ok && response.permalink ? { url: response.permalink, label: "Slack source" } : channelLink;
  } catch {
    return channelLink;
  }
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

export async function syncSlackMeetingActionReviewAfterWebApply(actor: AppActor, params: { workspaceId: string; insightId: string }) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const refreshed = await refreshSlackMeetingActionReviewAfterWebApply(actor, params);
  if (!refreshed) return;
  await assertMeetingReviewPublicPublication(actor, {
    workspaceId: params.workspaceId, installationId: refreshed.installationId,
    channelId: refreshed.update.channelId, lineageRoots: refreshed.update.lineageRoots,
  });
  await updateSlackMessage(refreshed.installationId, {
    channel: refreshed.update.channelId,
    ts: refreshed.update.messageTs,
  }, refreshed.update.blocks, refreshed.update.text);
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

export async function validateSlackPostTarget(installationId: string, rawChannelId: string,
  options?: { requirePublic?: boolean }): Promise<SlackPostTargetValidation> {
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
    if (options?.requirePublic && channel.is_private !== false) {
      return {
        ok: false,
        code: "SLACK_CHANNEL_NOT_PUBLIC",
        message: "Choose an active public Slack channel for this publication.",
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

type SlackScopeParams = {
  workspaceId: string; installationId: string; channelId: string; externalUserId?: string;
};

async function readableSlackScope(actor: AppActor, params: SlackScopeParams,
  db: Prisma.TransactionClient = prisma) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Slack thread reads require the mapped human requester.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const installation = await db.communicationInstallation.findFirst({ where: {
    id: params.installationId, workspaceId: params.workspaceId, provider: "SLACK", status: "ACTIVE", disconnectedAt: null,
  } });
  const channel = await db.communicationChannel.findFirst({ where: {
    installationId: params.installationId, workspaceId: params.workspaceId, provider: "SLACK",
    externalChannelId: params.channelId, kind: "PUBLIC", isIngestEnabled: true, isArchived: false,
  } });
  const member = await db.member.findFirst({ where: { workspaceId: params.workspaceId, userId: actor.user.id, isActive: true },
    include: { user: { select: { id: true, email: true, displayName: true } } } });
  invariant(installation && channel && member, 409, "SOURCE_RESTRICTED", "The Slack connection, public channel or requester membership is unavailable.");
  const mapping = await db.communicationExternalUser.findFirst({ where: {
    installationId: installation.id, workspaceId: params.workspaceId, provider: "SLACK", userId: actor.user.id,
    ...(params.externalUserId ? { externalUserId: params.externalUserId } : {}),
    isBot: false, isDeleted: false, OR: [{ memberId: member.id }, { memberId: null }],
  } });
  invariant(mapping, 409, "SOURCE_RESTRICTED", "The Slack requester mapping is unavailable.");
  const roots = await captureArtifactInputProof(actor, params.workspaceId, [
    { kind: "CommunicationChannel", id: channel.id, snapshot: channel },
    { kind: "CommunicationExternalUser", id: mapping.id, snapshot: mapping },
    { kind: "Member", id: member.id, snapshot: member },
    { kind: "User", id: member.user.id, snapshot: member.user },
  ], db);
  return { installation, channel, member, mapping, roots };
}

async function lockSlackScope(tx: Prisma.TransactionClient, scope: Awaited<ReturnType<typeof readableSlackScope>>) {
  await tx.$queryRaw`SELECT "id" FROM "CommunicationInstallation" WHERE "id" = ${scope.installation.id} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "CommunicationChannel" WHERE "id" = ${scope.channel.id} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${scope.member.id} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "CommunicationExternalUser" WHERE "id" = ${scope.mapping.id} FOR SHARE`;
}

async function mintSlackAgentRequest(actor: HumanActor, params: SlackScopeParams & {
  prompt: string; source: "slash_command" | "message_shortcut"; triggerId?: string; sourceMessageId?: string;
}) {
  const scope = await readableSlackScope(actor, params);
  return prisma.$transaction(async tx => {
    await lockSlackScope(tx, scope);
    await readableSlackScope(actor, params, tx);
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, scope.roots, tx),
      409, "SOURCE_CHANGED", "Slack request permissions changed before capture.");
    const data = { workspaceId: params.workspaceId, userId: actor.user.id, agentKey: "slack-agent", prompt: params.prompt };
    const id = params.triggerId?.trim() ? `slack-request:${createHmac("sha256", "slack-agent-request-v1").update(JSON.stringify([
      params.workspaceId, params.installationId, actor.user.id, params.externalUserId, params.channelId,
      params.source, params.sourceMessageId ?? null, params.triggerId.trim(),
    ])).digest("hex")}` : null;
    const input = id
      ? await tx.agentRequestInput.upsert({ where: { id }, update: {}, create: { id, ...data } })
      : await tx.agentRequestInput.create({ data });
    invariant(input.workspaceId === params.workspaceId && input.userId === actor.user.id && input.agentKey === "slack-agent"
      && input.prompt === params.prompt && (!id || input.id === id), 409, "SOURCE_CHANGED", "The original authored Slack request changed.");
    await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "AgentRequestInput", id: input.id, snapshot: input }], tx);
    return input.id;
  });
}

/** Read current public provider content into native rows before any model consumes it. */
export async function fetchAndPersistReadableSlackThreadMessages(actor: AppActor, params: {
  workspaceId: string; installationId: string; channelId: string; threadTs: string; limit?: number;
}): Promise<CommunicationMessage[]> {
  params = structuredClone(params);
  invariant(/^\d+\.\d+$/.test(params.threadTs), 400, "INVALID_INPUT", "A Slack thread timestamp is required.");
  const limit = Math.min(200, Math.max(1, Math.floor(params.limit ?? 80)));
  invariant(Number.isFinite(limit), 400, "INVALID_INPUT", "Slack thread limit is invalid.");
  const scope = await readableSlackScope(actor, params);
  const checkDestination = async () => {
    const current = await prisma.communicationInstallation.findFirst({ where: {id:params.installationId,workspaceId:params.workspaceId,
      provider:"SLACK",status:"ACTIVE",disconnectedAt:null} });
    invariant(current && communicationInstallationGrantHash(current) === communicationInstallationGrantHash(scope.installation),
      409,"SOURCE_CHANGED","Slack installation changed before collecting the thread.");
    let response: Awaited<ReturnType<WebClient["conversations"]["info"]>>;
    try {
      const client = slackClient(encryptedBotToken(scope.installation));
      const identity = await client.auth.test();
      invariant(identity.ok === true && identity.team_id === scope.installation.externalWorkspaceId && identity.user_id === scope.installation.botUserId,
        409,"SOURCE_RESTRICTED","The Slack thread provider principal changed.");
      response = await client.conversations.info({ channel: params.channelId });
    }
    catch { throw new AppError(409, "SOURCE_RESTRICTED", "The public Slack thread destination could not be verified."); }
    const remote = isRecord(response.channel) ? response.channel : null;
    invariant(remote && asString(remote.id) === params.channelId, 409, "SOURCE_RESTRICTED", "The original Slack thread destination changed.");
    if (remote.is_private === true || remote.is_archived === true) {
      await prisma.communicationChannel.updateMany({ where: { id: scope.channel.id, workspaceId: params.workspaceId },
        data: { ...(remote.is_private === true ? { kind: "PRIVATE" } : {}), ...(remote.is_archived === true ? { isArchived: true } : {}) } });
    }
    invariant(response.ok === true && remote.is_private === false && remote.is_archived === false && remote.is_member === true,
      409, "SOURCE_RESTRICTED", "The Slack thread destination is no longer public and available.");
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, scope.roots),
      409, "SOURCE_CHANGED", "Slack thread permissions changed during the provider read.");
  };
  const messages: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let scanned = 0;
  while (messages.length < limit) {
    await checkDestination();
    const take = Math.min(200, 5_000 - scanned);
    invariant(take > 0, 503, "INPUT_SCAN_LIMIT", "The Slack thread needs a bounded source rebuild before collection can complete.");
    let response: Awaited<ReturnType<WebClient["conversations"]["replies"]>>;
    try {
      response = await slackClient(encryptedBotToken(scope.installation)).conversations.replies({
        channel: params.channelId, ts: params.threadTs, limit: take, ...(cursor ? { cursor } : {}),
      });
    } catch {
      throw new AppError(502, "SLACK_THREAD_READ_FAILED", "The Slack thread could not be read.");
    }
    invariant(response.ok === true && Array.isArray(response.messages) && response.messages.length <= take,
      502, "SLACK_THREAD_READ_FAILED", "The Slack thread response is unavailable.");
    await checkDestination();
    scanned += response.messages.length;
    const candidates: Record<string, unknown>[] = [];
    for (const message of response.messages) {
      if (isRecord(message) && !shouldSkipSlackArchiveMessage(message)
        && asString(message.user) !== scope.installation.botUserId && asString(message.text).trim()) {
        if ((Array.isArray(message.files) && message.files.length) || (Array.isArray(message.attachments) && message.attachments.length)) continue;
        candidates.push(message);
      }
    }
    for (const message of candidates) {
      const ts = asString(message.ts), thread = asString(message.thread_ts) || ts;
      invariant(/^\d+\.\d+$/.test(ts) && thread === params.threadTs && asString(message.user)
        && (!asString(message.channel) || asString(message.channel) === params.channelId),
      409, "SOURCE_CHANGED", "Slack returned a message outside the requested thread.");
    }
    const currentFlags = candidates.length ? await prisma.communicationMessage.findMany({ where: {
      workspaceId: params.workspaceId, installationId: params.installationId, externalChannelId: params.channelId,
      externalMessageId: { in: candidates.map(message => asString(message.ts)) },
    }, select: { externalMessageId: true, isBot: true, isHidden: true, isDeleted: true, textRedactedAt: true, expiresRawAt: true } }) : [];
    const blocked = new Set(currentFlags.filter(row => row.isBot || row.isHidden || row.isDeleted || row.textRedactedAt || (row.expiresRawAt && row.expiresRawAt.getTime() <= Date.now())).map(row => row.externalMessageId));
    for (const message of candidates) {
      const ts = asString(message.ts);
      if (seen.has(ts) || blocked.has(ts)) continue;
      seen.add(ts); messages.push(message);
      if (messages.length === limit) break;
    }
    if (messages.length === limit || !response.has_more) break;
    const next = response.response_metadata?.next_cursor;
    invariant(next && next !== cursor && response.messages.length > 0, 409, "SOURCE_CHANGED", "The Slack thread read could not continue safely.");
    cursor = next;
  }
  const stored: CommunicationMessage[] = [];
  for (const message of [...messages].sort((left, right) => asString(left.ts).localeCompare(asString(right.ts)))) {
    const receipt = await captureSlackNativeMessageFetch({ workspaceId: params.workspaceId, installationId: params.installationId,
      channelId: params.channelId, messageTs: asString(message.ts), threadTs: params.threadTs });
    invariant(receipt.projected.text === message.text && receipt.projected.user === message.user,
      409, "SOURCE_CHANGED", "The Slack thread changed before native input persistence.");
    invariant(await isArtifactInputProofReadable(actor, params.workspaceId, scope.roots),
      409, "SOURCE_CHANGED", "Slack requester permissions changed before persistence.");
    stored.push(await persistNativeSlackMessage(actor, receipt, rawRetentionDate(rawRetentionDays(scope.installation.settings))));
  }
  const messageRoots = await captureArtifactInputProof(actor, params.workspaceId, stored.map(record => ({ kind: "CommunicationMessage", id: record.id, snapshot: record })));
  invariant(await isArtifactInputProofReadable(actor, params.workspaceId, [...scope.roots, ...messageRoots]),
    409, "SOURCE_CHANGED", "Slack thread inputs changed before return.");
  return stored;
}

export async function fetchSlackThreadMessages(installationId: string, params: {
  channelId: string;
  threadTs: string;
  limit?: number;
}, actor?: AppActor) {
  if (!actor) return [];
  const installation = await prisma.communicationInstallation.findUnique({ where: { id: installationId } });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found.");
  const messages = await fetchAndPersistReadableSlackThreadMessages(actor, { workspaceId: installation.workspaceId,
    installationId, channelId: params.channelId, threadTs: params.threadTs, limit: params.limit ?? 20 });
  return messages.map(message => ({ user: message.externalUserId ?? "", text: message.text ?? "",
    ts: message.externalMessageId, threadTs: message.threadExternalId ?? "" })).filter(message => message.text.length > 0);
}

// A nudge claim can outlive its worker. Reconcile it from the complete Slack
// thread; an incomplete or failed read cannot prove that a post was delivered.
export async function checkSlackThreadNudge(installationId: string, params: {
  channelId: string;
  threadTs: string;
  createdAt: Date;
  text: string;
}): Promise<"found" | "absent" | "unknown"> {
  try {
    const installation = await prisma.communicationInstallation.findUnique({ where: { id: installationId } });
    if (!installation) return "unknown";
    const client = slackClient(encryptedBotToken(installation));
    let cursor: string | undefined;
    let ambiguousTextMatch = false;
    for (let page = 0; page < 20; page += 1) {
      const response = await client.conversations.replies({
        channel: params.channelId, ts: params.threadTs, limit: 200, cursor,
      });
      if (response.ok === false || !response.messages?.length) return "unknown";
      for (const message of response.messages) {
        if (message.text !== params.text
          || Number(message.ts) * 1000 < params.createdAt.getTime() - 2 * 60 * 1000) continue;
        if ((installation.botUserId && message.user === installation.botUserId)
          || (installation.appId && message.app_id === installation.appId)) return "found";
        // A matching post with another or missing author cannot be counted as
        // our delivery or used to authorize a retry.
        ambiguousTextMatch = true;
      }
      if (!response.has_more) return ambiguousTextMatch ? "unknown" : "absent";
      cursor = response.response_metadata?.next_cursor || undefined;
      if (!cursor) return "unknown";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

export async function publishSlackHome(installationId: string, externalUserId: string) {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
  });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found.");

  const actor = await resolveHumanActorForSlackUser(installation, externalUserId);
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
      prisma.communicationEntityLink.findMany({ where: { workspaceId: installation.workspaceId, installationId,
        action: { not: "proactive_first_nudge_scan_cursor" },
      }, take: 5, orderBy: { createdAt: "desc" } }),
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

export async function listSlackMessagesForDigest(actor: AppActor, workspaceId: string,
  since: Date, until?: Date, audience?: AppActor[]) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const channels = await prisma.communicationChannel.findMany({
    where: {
      workspaceId, provider: "SLACK", kind: "PUBLIC", isIngestEnabled: true, isArchived: false,
      installation: { workspaceId, provider: "SLACK", status: "ACTIVE", disconnectedAt: null },
    },
    select: { installationId: true, externalChannelId: true },
  });
  if (channels.length === 0) return [];
  const messages = await loadReadableDigestQuery<CommunicationMessage>({
    actor, audience, workspaceId, kind: "CommunicationMessage", limit: 500, keyset: true,
    loadBatch: ({ take, after }) => prisma.communicationMessage.findMany({
      where: {
        workspaceId,
        provider: "SLACK",
        installation: { workspaceId, status: "ACTIVE", disconnectedAt: null },
        OR: channels.map((channel) => ({ installationId: channel.installationId, externalChannelId: channel.externalChannelId })),
        receivedAt: until ? { gte: since, lte: until } : { gte: since },
        text: { not: null },
        textRedactedAt: null,
        isBot: false,
        isHidden: false,
        isDeleted: false,
        ...(after ? { AND: [{ OR: [
          { receivedAt: { gt: after.receivedAt } },
          { receivedAt: after.receivedAt, id: { gt: after.id } },
        ] }] } : {}),
      },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      take,
    }),
  });
  if (messages.length) {
    const roots = await captureArtifactInputProof(actor,workspaceId,messages.map(message=>({kind:"CommunicationMessage",id:message.id,snapshot:message})));
    invariant(await isArtifactInputProofReadable(actor,workspaceId,roots)
      && (!audience || await isDigestInputProofShared(audience,workspaceId,roots)),
    409,"SOURCE_CHANGED","Slack input permissions changed before return.");
  }
  return messages;
}
