#!/usr/bin/env node
import { createDecipheriv } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { WebClient } from "@slack/web-api";

const prisma = new PrismaClient();

const DEFAULT_LOOKBACK_DAYS = 120;
const DEFAULT_RETENTION_DAYS = 3650;
const PAGE_LIMIT = 200;

function readPositiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function decryptSecret(value) {
  const keyRaw = process.env.ENCRYPTION_KEY;
  if (!keyRaw) {
    throw new Error("ENCRYPTION_KEY is required to read the Slack installation token.");
  }
  const key = Buffer.from(keyRaw, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be a 32-byte hex string.");
  }
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(":");
  if (version !== "aes-256-gcm" || !ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error("Unsupported encrypted Slack token format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function slackTimestampToDate(ts) {
  if (!ts) return null;
  const [secondsRaw, microsRaw = "0"] = ts.split(".");
  const seconds = Number.parseInt(secondsRaw, 10);
  const millis = Number.parseInt(microsRaw.padEnd(3, "0").slice(0, 3), 10);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000 + (Number.isFinite(millis) ? millis : 0));
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function shouldSkipMessage(message) {
  const subtype = asString(message.subtype);
  return Boolean(message.hidden)
    || subtype === "message_deleted"
    || subtype === "bot_message"
    || Boolean(message.bot_id);
}

async function resolveWorkspace() {
  if (process.env.WORKSPACE_ID) {
    return prisma.workspace.findUnique({ where: { id: process.env.WORKSPACE_ID } });
  }
  if (process.env.WORKSPACE_SLUG) {
    return prisma.workspace.findUnique({ where: { slug: process.env.WORKSPACE_SLUG } });
  }
  throw new Error("Set WORKSPACE_ID or WORKSPACE_SLUG before syncing Slack public channels.");
}

async function syncChannelHistory(client, installation, channelId, options) {
  let cursor;
  let scanned = 0;
  let upserted = 0;
  do {
    const response = await client.conversations.history({
      channel: channelId,
      cursor,
      limit: PAGE_LIMIT,
      ...(options.oldest ? { oldest: options.oldest } : {}),
    });
    const messages = Array.isArray(response.messages) ? response.messages : [];
    for (const message of messages) {
      if (options.maxMessagesPerChannel > 0 && scanned >= options.maxMessagesPerChannel) {
        return { scanned, upserted, capped: true };
      }
      scanned += 1;
      const ts = asString(message.ts);
      if (!ts || shouldSkipMessage(message)) continue;
      await prisma.communicationMessage.upsert({
        where: {
          installationId_externalChannelId_externalMessageId: {
            installationId: installation.id,
            externalChannelId: channelId,
            externalMessageId: ts,
          },
        },
        update: {
          externalUserId: asString(message.user) || null,
          threadExternalId: asString(message.thread_ts) || null,
          text: asString(message.text) || null,
          raw: jsonValue(message),
          messageTs: slackTimestampToDate(ts),
          expiresRawAt: options.expiresRawAt,
          isBot: false,
          isHidden: false,
          isDeleted: false,
        },
        create: {
          installationId: installation.id,
          workspaceId: installation.workspaceId,
          provider: "SLACK",
          externalMessageId: ts,
          externalChannelId: channelId,
          externalUserId: asString(message.user) || null,
          threadExternalId: asString(message.thread_ts) || null,
          text: asString(message.text) || null,
          raw: jsonValue(message),
          messageTs: slackTimestampToDate(ts),
          expiresRawAt: options.expiresRawAt,
          isBot: false,
          isHidden: false,
          isDeleted: false,
        },
      });
      upserted += 1;
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return { scanned, upserted, capped: false };
}

async function main() {
  const workspace = await resolveWorkspace();
  if (!workspace) {
    throw new Error("Workspace not found for Slack public archive sync.");
  }

  const installation = await prisma.communicationInstallation.findFirst({
    where: {
      workspaceId: workspace.id,
      provider: "SLACK",
      status: "ACTIVE",
    },
    orderBy: { installedAt: "desc" },
  });
  if (!installation?.botTokenEnc) {
    throw new Error("Active Slack installation with an encrypted bot token was not found.");
  }

  const scopes = installation.scopes ?? [];
  if (!scopes.includes("channels:history")) {
    throw new Error("Slack installation is missing channels:history; reinstall Slack before syncing public channels.");
  }
  const autoJoinPublicChannels = scopes.includes("channels:join");
  const lookbackDays = readPositiveInt("SLACK_ARCHIVE_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS);
  const retentionDays = readPositiveInt("SLACK_ARCHIVE_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
  const maxMessagesPerChannel = readPositiveInt("SLACK_ARCHIVE_MAX_MESSAGES_PER_CHANNEL", 0);
  const oldest = lookbackDays > 0
    ? String(Math.floor((Date.now() - lookbackDays * 24 * 60 * 60 * 1000) / 1000))
    : undefined;
  const expiresRawAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
  const client = new WebClient(decryptSecret(installation.botTokenEnc));

  const summary = {
    workspaceId: workspace.id,
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

  let cursor;
  do {
    const response = await client.conversations.list({
      types: "public_channel",
      exclude_archived: false,
      limit: PAGE_LIMIT,
      cursor,
    });
    const channels = Array.isArray(response.channels) ? response.channels : [];
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
          if (error?.data?.error === "method_not_supported_for_channel_type") {
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
        const result = await syncChannelHistory(client, installation, channelId, {
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

  const settings = installation.settings && typeof installation.settings === "object" && !Array.isArray(installation.settings)
    ? installation.settings
    : {};
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
      lastError: summary.channelsWithReadErrors > 0 ? `Public archive sync had ${summary.channelsWithReadErrors} channel read errors.` : null,
    },
  });

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Slack public archive sync failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
