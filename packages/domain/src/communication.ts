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
import { invariant } from "./errors";
import { createProposal } from "./proposals";
import { createTension, publishTension } from "./tensions";

export type CommunicationWorkItemKind = "ACTION" | "TENSION" | "PROPOSAL" | "BRAIN_NOTE";

const SLACK_REQUIRED_SCOPES = [
  "commands",
  "chat:write",
  "app_mentions:read",
  "users:read",
  "users:read.email",
  "channels:read",
  "reactions:read",
] as const;

const SLACK_BROAD_INGESTION_SCOPES = ["channels:history"] as const;
const SLACK_RAW_RETENTION_DAYS = 30;
const INACTIVE_SLACK_INSTALLATION_ERROR = "Slack installation is not active.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function appUrl(path = "") {
  return `${env.APP_URL.replace(/\/$/, "")}${path}`;
}

function entityUrl(workspaceId: string, entityType: string, entityId: string) {
  const base = `/workspaces/${workspaceId}`;
  if (entityType === "Action") return appUrl(`${base}/actions`);
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

function rawRetentionDate() {
  return new Date(Date.now() + SLACK_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export function slackOAuthScopes() {
  return [...SLACK_REQUIRED_SCOPES, ...SLACK_BROAD_INGESTION_SCOPES].join(",");
}

export function createSlackOAuthState(workspaceId: string) {
  const nonce = randomOpaqueToken(24);
  return {
    nonce,
    value: Buffer.from(JSON.stringify({ workspaceId, nonce })).toString("base64url"),
  };
}

export function readSlackOAuthState(state: string) {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed)) return null;
    const workspaceId = asString(parsed.workspaceId);
    const nonce = asString(parsed.nonce);
    if (!workspaceId || !nonce) return null;
    return { workspaceId, nonce };
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

export async function saveSlackInstallation(actor: AppActor, params: {
  workspaceId: string;
  oauthResponse: Awaited<ReturnType<typeof exchangeSlackOAuthCode>>;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const teamId = params.oauthResponse.team?.id;
  invariant(teamId, 400, "INVALID_SLACK_INSTALLATION", "Slack OAuth response did not include a team id.");

  const grantedScopes = typeof params.oauthResponse.scope === "string"
    ? params.oauthResponse.scope.split(",").map((scope) => scope.trim()).filter(Boolean)
    : [];

  const optionalScopes = grantedScopes.filter((scope) => (SLACK_BROAD_INGESTION_SCOPES as readonly string[]).includes(scope));
  const botTokenEnc = encryptSecret(String(params.oauthResponse.access_token));

  return prisma.communicationInstallation.upsert({
    where: { provider_externalWorkspaceId: { provider: "SLACK", externalWorkspaceId: teamId } },
    update: {
      workspaceId: params.workspaceId,
      externalOrgId: params.oauthResponse.enterprise?.id ?? null,
      externalTeamName: params.oauthResponse.team?.name ?? null,
      appId: params.oauthResponse.app_id ?? env.SLACK_APP_ID ?? null,
      botUserId: params.oauthResponse.bot_user_id ?? null,
      botTokenEnc,
      scopes: grantedScopes,
      optionalScopes,
      status: "ACTIVE",
      installedByUserId: actor.kind === "user" ? actor.user.id : null,
      installedAt: new Date(),
      disconnectedAt: null,
      lastError: null,
      settings: {
        broadPublicIngestion: grantedScopes.includes("channels:history"),
        rawRetentionDays: SLACK_RAW_RETENTION_DAYS,
        label: "Enhanced Org Briefing",
      },
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
      installedByUserId: actor.kind === "user" ? actor.user.id : null,
      settings: {
        broadPublicIngestion: grantedScopes.includes("channels:history"),
        rawRetentionDays: SLACK_RAW_RETENTION_DAYS,
        label: "Enhanced Org Briefing",
      },
    },
  });
}

async function slackInstallationByTeam(teamId: string) {
  return prisma.communicationInstallation.findUnique({
    where: { provider_externalWorkspaceId: { provider: "SLACK", externalWorkspaceId: teamId } },
  });
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

async function ensureSlackChannel(installation: { id: string; workspaceId: string }, event: Record<string, unknown>) {
  const externalChannelId = asString(event.channel);
  if (!externalChannelId) return null;
  const channelType = asString(event.channel_type);
  const kind = channelType === "channel" ? "PUBLIC" : channelType === "group" ? "PRIVATE" : channelType === "im" ? "DIRECT" : "UNKNOWN";

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

async function ingestSlackMessage(installation: { id: string; workspaceId: string; provider: CommunicationProvider }, event: Record<string, unknown>) {
  const externalChannelId = asString(event.channel);
  const ts = asString(event.ts) || asString(event.event_ts);
  if (!externalChannelId || !ts) return { skipped: true, reason: "missing_channel_or_ts" };

  const subtype = asString(event.subtype);
  const hidden = Boolean(event.hidden);
  const isBot = Boolean(event.bot_id) || subtype === "bot_message";
  const deleted = subtype === "message_deleted";
  if (hidden || deleted || isBot) {
    return { skipped: true, reason: "excluded_message_type" };
  }

  const channel = await ensureSlackChannel(installation, event);
  if (!channel || channel.kind !== "PUBLIC" || !channel.isIngestEnabled) {
    return { skipped: true, reason: "channel_not_ingested" };
  }

  const text = asString(event.text);
  return prisma.communicationMessage.upsert({
    where: {
      installationId_externalChannelId_externalMessageId: {
        installationId: installation.id,
        externalChannelId,
        externalMessageId: ts,
      },
    },
    update: {
      externalUserId: asString(event.user) || null,
      threadExternalId: asString(event.thread_ts) || null,
      text: text || null,
      raw: toInputJson(event),
      messageTs: slackTimestampToDate(ts),
      expiresRawAt: rawRetentionDate(),
      isBot,
      isHidden: hidden,
      isDeleted: deleted,
    },
    create: {
      installationId: installation.id,
      workspaceId: installation.workspaceId,
      provider: "SLACK",
      externalMessageId: ts,
      externalChannelId,
      externalUserId: asString(event.user) || null,
      threadExternalId: asString(event.thread_ts) || null,
      text: text || null,
      raw: toInputJson(event),
      messageTs: slackTimestampToDate(ts),
      expiresRawAt: rawRetentionDate(),
      isBot,
      isHidden: hidden,
      isDeleted: deleted,
    },
  });
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
      await sendSlackMessage(inbound.installation.id, {
        channel: asString(event.channel),
        threadTs: asString(event.ts) || undefined,
      }, [{
        type: "section",
        text: {
          type: "mrkdwn",
          text: "I can capture work into Corgtex. Try `/corgtex action ...`, `/corgtex tension ...`, `/corgtex proposal ...`, or open my Home tab for your brief.",
        },
      }], token);
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
}) {
  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Title is required.");
  const sourceNote = params.sourceMessageId ? `\n\n---\nCaptured from ${params.provider} source message.` : "";
  const bodyMd = `${params.bodyMd?.trim() || title}${sourceNote}`;

  let result: { entityType: string; entityId: string };
  if (params.kind === "ACTION") {
    const action = await createAction(actor, { workspaceId: params.workspaceId, title, bodyMd, isPrivate: true });
    result = { entityType: "Action", entityId: action.id };
  } else if (params.kind === "TENSION") {
    const tension = await createTension(actor, { workspaceId: params.workspaceId, title, bodyMd, isPrivate: true });
    result = { entityType: "Tension", entityId: tension.id };
  } else if (params.kind === "PROPOSAL") {
    const proposal = await createProposal(actor, { workspaceId: params.workspaceId, title, summary: title, bodyMd, isPrivate: true });
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
      text: { type: "plain_text", text: entityType === "Action" ? "Publish action" : "Publish tension" },
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
  if (!kind || !text) {
    return {
      response_type: "ephemeral",
      text: "Use `/corgtex brief`, `/corgtex action <text>`, `/corgtex tension <text>`, or `/corgtex proposal <text>`.",
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
    const triggerId = asString(payload.trigger_id);
    const message = isRecord(payload.message) ? payload.message : {};
    const channel = isRecord(payload.channel) ? asString(payload.channel.id) : "";
    const messageTs = asString(message.ts);
    const messageText = asString(message.text);
    await slackClient(encryptedBotToken(installation)).views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "corgtex_capture_modal",
        title: { type: "plain_text", text: "Send to Corgtex" },
        submit: { type: "plain_text", text: "Create draft" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify({ channel, messageTs, messageText, externalUserId }),
        blocks: [
          {
            type: "input",
            block_id: "kind",
            label: { type: "plain_text", text: "Create" },
            element: {
              type: "static_select",
              action_id: "value",
              initial_option: { text: { type: "plain_text", text: "Action" }, value: "ACTION" },
              options: [
                { text: { type: "plain_text", text: "Action" }, value: "ACTION" },
                { text: { type: "plain_text", text: "Tension" }, value: "TENSION" },
                { text: { type: "plain_text", text: "Proposal" }, value: "PROPOSAL" },
                { text: { type: "plain_text", text: "Brain note" }, value: "BRAIN_NOTE" },
              ],
            },
          },
          {
            type: "input",
            block_id: "title",
            label: { type: "plain_text", text: "Title" },
            element: { type: "plain_text_input", action_id: "value", initial_value: messageText.slice(0, 120) || "Slack capture" },
          },
          {
            type: "input",
            block_id: "body",
            label: { type: "plain_text", text: "Details" },
            element: { type: "plain_text_input", action_id: "value", multiline: true, initial_value: messageText || "Captured from Slack." },
          },
        ],
      },
    });
    return {};
  }

  if (payload.type === "view_submission") {
    const view = isRecord(payload.view) ? payload.view : {};
    const values = isRecord(isRecord(view.state) ? view.state.values : null) ? (view.state as Record<string, any>).values : {};
    const metadata = JSON.parse(asString(view.private_metadata) || "{}") as Record<string, unknown>;
    const kind = asString(values.kind?.value?.selected_option?.value) as CommunicationWorkItemKind;
    const title = asString(values.title?.value?.value);
    const bodyMd = asString(values.body?.value?.value);
    const metadataChannel = asString(metadata.channel);
    const metadataMessageTs = asString(metadata.messageTs);
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
          expiresRawAt: rawRetentionDate(),
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
          expiresRawAt: rawRetentionDate(),
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
    const value = JSON.parse(asString(action?.value) || "{}") as { entityType?: string; entityId?: string };
    if (actionId === "corgtex_publish_action" && value.entityId) {
      await publishAction(actor, { workspaceId: installation.workspaceId, actionId: value.entityId });
      return { response_type: "ephemeral", text: "Action published." };
    }
    if (actionId === "corgtex_publish_tension" && value.entityId) {
      await publishTension(actor, { workspaceId: installation.workspaceId, tensionId: value.entityId });
      return { response_type: "ephemeral", text: "Tension published." };
    }
  }

  return {};
}

export async function sendSlackMessage(installationId: string, target: {
  channel: string;
  threadTs?: string;
}, blocks: unknown[], tokenOverride?: string) {
  const installation = await prisma.communicationInstallation.findUnique({
    where: { id: installationId },
  });
  invariant(installation, 404, "NOT_FOUND", "Slack installation not found.");
  const token = tokenOverride ?? encryptedBotToken(installation);

  return slackClient(token).chat.postMessage({
    channel: target.channel,
    thread_ts: target.threadTs,
    text: "Corgtex update",
    blocks: blocks as any,
    unfurl_links: false,
    unfurl_media: false,
  });
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
  return prisma.communicationMessage.updateMany({
    where: {
      ...(workspaceId ? { workspaceId } : {}),
      expiresRawAt: { lte: now },
      textRedactedAt: null,
    },
    data: {
      text: null,
      raw: Prisma.DbNull,
      textRedactedAt: now,
    },
  });
}

export async function listSlackMessagesForDigest(workspaceId: string, since: Date) {
  return prisma.communicationMessage.findMany({
    where: {
      workspaceId,
      provider: "SLACK",
      receivedAt: { gte: since },
      text: { not: null },
      isBot: false,
      isHidden: false,
      isDeleted: false,
    },
    orderBy: { receivedAt: "asc" },
    take: 500,
  });
}
