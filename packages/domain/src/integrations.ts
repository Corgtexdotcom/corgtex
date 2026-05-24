import { decryptSecret, encryptSecret, prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { OAuthConnection, OAuthProvider, Prisma } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { extractSupportedMeetingUrlFromText } from "./meeting-recorders";

const ENCRYPTED_TOKEN_STORAGE_VERSION = "aes-256-gcm";

const dataSourceSelect = {
  id: true,
  workspaceId: true,
  label: true,
  driverType: true,
  selectedTables: true,
  pullCadenceMinutes: true,
  cursorColumn: true,
  lastSyncAt: true,
  lastSyncError: true,
  isActive: true,
  archivedAt: true,
  archiveReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ExternalDataSourceSelect;

function parseMicrosoftDateTime(value: { dateTime?: string | null; timeZone?: string | null }) {
  const raw = value.dateTime?.trim();
  if (!raw) {
    return new Date(NaN);
  }

  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(raw)) {
    return new Date(raw);
  }

  if (value.timeZone === "UTC") {
    return new Date(`${raw}Z`);
  }

  return new Date(raw);
}

function encryptOAuthToken(value: string) {
  return encryptSecret(value);
}

function decryptOAuthToken(value: string, tokenStorageVersion?: string | null) {
  if (tokenStorageVersion === ENCRYPTED_TOKEN_STORAGE_VERSION || value.startsWith(`${ENCRYPTED_TOKEN_STORAGE_VERSION}:`)) {
    return decryptSecret(value);
  }
  return value;
}

function oauthAccessToken(connection: Pick<OAuthConnection, "accessToken" | "tokenStorageVersion">) {
  return decryptOAuthToken(connection.accessToken, connection.tokenStorageVersion);
}

function oauthRefreshToken(connection: Pick<OAuthConnection, "refreshToken" | "tokenStorageVersion">) {
  return connection.refreshToken ? decryptOAuthToken(connection.refreshToken, connection.tokenStorageVersion) : null;
}

export async function saveOAuthConnectionAndEnqueueCalendarSync(actor: AppActor, params: {
  workspaceId?: string | null;
  provider: OAuthProvider;
  providerAccountId: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  scopes?: string[];
  providerEmail?: string | null;
  syncSettings?: Prisma.InputJsonValue;
}) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only users can connect OAuth providers.");

  if (params.workspaceId) {
    await requireWorkspaceMembership({
      actor,
      workspaceId: params.workspaceId,
    });
  }

  return prisma.$transaction(async (tx) => {
    const connection = await tx.oAuthConnection.upsert({
      where: { userId_provider: { userId: actor.user.id, provider: params.provider } },
      update: {
        workspaceId: params.workspaceId ?? null,
        accessToken: encryptOAuthToken(params.accessToken),
        refreshToken: params.refreshToken ? encryptOAuthToken(params.refreshToken) : undefined,
        tokenStorageVersion: ENCRYPTED_TOKEN_STORAGE_VERSION,
        expiresAt: params.expiresIn ? new Date(Date.now() + params.expiresIn * 1000) : null,
        providerAccountId: params.providerAccountId,
        providerEmail: params.providerEmail ?? undefined,
        scopes: params.scopes ?? [],
        status: "ACTIVE",
        disconnectedAt: null,
        lastSyncError: null,
        syncSettings: params.syncSettings ?? {
          calendar: { enabled: true, includeAllEvents: false },
          documents: { enabled: false, selectedDriveIds: [] },
          email: { enabled: false, filters: [] },
        },
      },
      create: {
        userId: actor.user.id,
        workspaceId: params.workspaceId ?? null,
        provider: params.provider,
        accessToken: encryptOAuthToken(params.accessToken),
        refreshToken: params.refreshToken ? encryptOAuthToken(params.refreshToken) : null,
        tokenStorageVersion: ENCRYPTED_TOKEN_STORAGE_VERSION,
        expiresAt: params.expiresIn ? new Date(Date.now() + params.expiresIn * 1000) : null,
        providerAccountId: params.providerAccountId,
        providerEmail: params.providerEmail ?? null,
        scopes: params.scopes ?? [],
        status: "ACTIVE",
        syncSettings: params.syncSettings ?? {
          calendar: { enabled: true, includeAllEvents: false },
          documents: { enabled: false, selectedDriveIds: [] },
          email: { enabled: false, filters: [] },
        },
      },
    });

    if (params.workspaceId) {
      await tx.workflowJob.create({
        data: {
          workspaceId: params.workspaceId,
          type: "calendar.sync",
          payload: {
            connectionId: connection.id,
          },
        },
      });
    }

    return connection;
  });
}

export async function disconnectOAuthConnection(actor: AppActor, params: {
  workspaceId: string;
  connectionId: string;
}) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only users can disconnect OAuth providers.");
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const connection = await prisma.oAuthConnection.findFirst({
    where: {
      id: params.connectionId,
      workspaceId: params.workspaceId,
      userId: actor.user.id,
    },
    select: { id: true },
  });
  invariant(connection, 404, "NOT_FOUND", "OAuth connection not found.");

  return prisma.oAuthConnection.update({
    where: { id: params.connectionId },
    data: {
      status: "DISCONNECTED",
      disconnectedAt: new Date(),
      accessToken: "",
      refreshToken: null,
      lastSyncError: null,
    },
  });
}

export async function updateOAuthConnectionSyncSettings(actor: AppActor, params: {
  workspaceId: string;
  connectionId: string;
  syncSettings: Prisma.InputJsonValue;
  status?: "ACTIVE" | "PAUSED";
}) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only users can update OAuth connection settings.");
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const connection = await prisma.oAuthConnection.findFirst({
    where: {
      id: params.connectionId,
      workspaceId: params.workspaceId,
      userId: actor.user.id,
    },
    select: { id: true },
  });
  invariant(connection, 404, "NOT_FOUND", "OAuth connection not found.");

  return prisma.oAuthConnection.update({
    where: { id: params.connectionId },
    data: {
      syncSettings: params.syncSettings,
      ...(params.status ? { status: params.status } : {}),
      lastSyncError: null,
    },
  });
}

async function requireDataSourceAdmin(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({
    actor,
    workspaceId,
    allowedRoles: ["ADMIN"],
  });
}

export async function listExternalDataSources(actor: AppActor, workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  await requireDataSourceAdmin(actor, workspaceId);

  return prisma.externalDataSource.findMany({
    where: { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) },
    orderBy: { createdAt: "desc" },
    select: dataSourceSelect,
  });
}

export async function getExternalDataSource(actor: AppActor, params: {
  workspaceId: string;
  sourceId: string;
  includeSyncLogs?: boolean;
}) {
  await requireDataSourceAdmin(actor, params.workspaceId);

  const source = await prisma.externalDataSource.findFirst({
    where: { id: params.sourceId, workspaceId: params.workspaceId, archivedAt: null },
    select: {
      ...dataSourceSelect,
      ...(params.includeSyncLogs
        ? {
          syncLogs: {
            orderBy: { startedAt: "desc" },
            take: 10,
          },
        }
        : {}),
    },
  });

  invariant(source, 404, "NOT_FOUND", "Data source not found");
  return source;
}

export async function createExternalDataSource(actor: AppActor, params: {
  workspaceId: string;
  label: string;
  driverType: string;
  connectionStringEnc: string;
  selectedTables: string[];
  pullCadenceMinutes: number;
  cursorColumn: string;
}) {
  await requireDataSourceAdmin(actor, params.workspaceId);

  return prisma.externalDataSource.create({
    data: {
      workspaceId: params.workspaceId,
      label: params.label,
      driverType: params.driverType,
      connectionStringEnc: params.connectionStringEnc,
      selectedTables: params.selectedTables,
      pullCadenceMinutes: params.pullCadenceMinutes,
      cursorColumn: params.cursorColumn,
    },
    select: dataSourceSelect,
  });
}

export async function updateExternalDataSource(actor: AppActor, params: {
  workspaceId: string;
  sourceId: string;
  label?: string;
  connectionStringEnc?: string;
  selectedTables?: string[];
  pullCadenceMinutes?: number;
  cursorColumn?: string;
  isActive?: boolean;
}) {
  await requireDataSourceAdmin(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const source = await tx.externalDataSource.findFirst({
      where: { id: params.sourceId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true },
    });

    invariant(source, 404, "NOT_FOUND", "Data source not found");

    const data: Prisma.ExternalDataSourceUpdateInput = {};
    if (params.label !== undefined) data.label = params.label;
    if (params.connectionStringEnc !== undefined) data.connectionStringEnc = params.connectionStringEnc;
    if (params.selectedTables !== undefined) data.selectedTables = params.selectedTables;
    if (params.pullCadenceMinutes !== undefined) data.pullCadenceMinutes = params.pullCadenceMinutes;
    if (params.cursorColumn !== undefined) data.cursorColumn = params.cursorColumn;
    if (params.isActive !== undefined) data.isActive = params.isActive;

    return tx.externalDataSource.update({
      where: { id: params.sourceId },
      data,
      select: dataSourceSelect,
    });
  });
}

export async function deleteExternalDataSource(actor: AppActor, params: {
  workspaceId: string;
  sourceId: string;
}) {
  await requireDataSourceAdmin(actor, params.workspaceId);

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "ExternalDataSource",
    entityId: params.sourceId,
    reason: "Archived from data source delete path.",
  });

  return { id: params.sourceId };
}

export async function enqueueExternalDataSourceSync(actor: AppActor, params: {
  workspaceId: string;
  sourceId: string;
}) {
  await requireDataSourceAdmin(actor, params.workspaceId);

  return prisma.$transaction(async (tx) => {
    const source = await tx.externalDataSource.findFirst({
      where: { id: params.sourceId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true },
    });

    invariant(source, 404, "NOT_FOUND", "Data source not found");

    const timestamp = Date.now();
    return tx.workflowJob.upsert({
      where: { dedupeKey: `manual-sync-${params.sourceId}-${timestamp}` },
      update: {},
      create: {
        workspaceId: params.workspaceId,
        eventId: null,
        type: "data-source.sync",
        payload: { sourceId: params.sourceId },
        dedupeKey: `manual-sync-${params.sourceId}-${timestamp}`,
      },
    });
  });
}

export async function refreshOAuthTokenIfNeeded(connectionId: string): Promise<OAuthConnection> {
  const connection = await prisma.oAuthConnection.findUnique({
    where: { id: connectionId },
  });

  if (!connection) throw new Error("Connection not found");

  // Refresh if less than 5 minutes remain
  if (connection.expiresAt && connection.expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    const refreshToken = oauthRefreshToken(connection);
    if (!refreshToken) {
      throw new Error("Cannot refresh token without refresh_token");
    }

    if (connection.provider === "GOOGLE") {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID || "",
          client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!response.ok) {
        await prisma.oAuthConnection.update({
          where: { id: connection.id },
          data: { status: "ERROR", lastSyncError: "Failed to refresh Google token" },
        });
        throw new Error("Failed to refresh Google token");
      }
      const data = await response.json();

      return prisma.oAuthConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: encryptOAuthToken(data.access_token),
          tokenStorageVersion: ENCRYPTED_TOKEN_STORAGE_VERSION,
          expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
          status: "ACTIVE",
          lastSyncError: null,
          ...(data.refresh_token && { refreshToken: encryptOAuthToken(data.refresh_token) }),
        },
      });
    }

    if (connection.provider === "MICROSOFT") {
      const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.MICROSOFT_CLIENT_ID || "",
          client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!response.ok) {
        await prisma.oAuthConnection.update({
          where: { id: connection.id },
          data: { status: "ERROR", lastSyncError: "Failed to refresh Microsoft token" },
        });
        throw new Error("Failed to refresh Microsoft token");
      }
      const data = await response.json();

      return prisma.oAuthConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: encryptOAuthToken(data.access_token),
          tokenStorageVersion: ENCRYPTED_TOKEN_STORAGE_VERSION,
          expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
          status: "ACTIVE",
          lastSyncError: null,
          ...(data.refresh_token && { refreshToken: encryptOAuthToken(data.refresh_token) }),
        },
      });
    }
  }

  return connection;
}

export interface CalendarEvent {
  id: string;
  provider: OAuthProvider;
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  attendees: string[];
  organizerEmail: string | null;
  meetingUrl: string | null;
  htmlLink: string | null;
  status: string | null;
  visibility: string | null;
  transparency: string | null;
  responseStatus: string | null;
}

export async function fetchCalendarEvents(connectionId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
  const connection = await refreshOAuthTokenIfNeeded(connectionId);
  if (connection.status !== "ACTIVE") {
    return [];
  }
  const accessToken = oauthAccessToken(connection);

  if (connection.provider === "GOOGLE") {
    const query = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "true",
    });

    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) throw new Error(`Google Calendar API error: ${await res.text()}`);
    const data = await res.json();

    return (data.items || []).map((item: any) => {
      const conferenceUrl = Array.isArray(item.conferenceData?.entryPoints)
        ? item.conferenceData.entryPoints.map((entry: any) => entry?.uri).find((uri: unknown) => typeof uri === "string")
        : null;
      const meetingUrl = extractSupportedMeetingUrlFromText(item.hangoutLink)
        ?? extractSupportedMeetingUrlFromText(conferenceUrl)
        ?? extractSupportedMeetingUrlFromText(item.location)
        ?? extractSupportedMeetingUrlFromText(item.description);
      return {
        id: item.id,
        provider: connection.provider,
        title: item.summary || "Untitled Event",
        description: item.description || null,
        startTime: new Date(item.start.dateTime || item.start.date),
        endTime: new Date(item.end.dateTime || item.end.date),
        attendees: (item.attendees || []).map((a: any) => a.email).filter(Boolean),
        organizerEmail: item.organizer?.email || item.creator?.email || null,
        meetingUrl,
        htmlLink: item.htmlLink || null,
        status: item.status || null,
        visibility: item.visibility || null,
        transparency: item.transparency || null,
        responseStatus: (item.attendees || []).find((a: any) => a.self)?.responseStatus || null,
      };
    });
  }

  if (connection.provider === "MICROSOFT") {
    const query = new URLSearchParams({
      $filter: `start/dateTime ge '${timeMin.toISOString()}' and end/dateTime le '${timeMax.toISOString()}'`,
      $orderBy: "start/dateTime",
    });

    const res = await fetch(`https://graph.microsoft.com/v1.0/me/events?${query}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });

    if (!res.ok) throw new Error(`Microsoft Graph API error: ${await res.text()}`);
    const data = await res.json();

    return (data.value || []).map((item: any) => {
      const meetingUrl = extractSupportedMeetingUrlFromText(item.onlineMeeting?.joinUrl)
        ?? extractSupportedMeetingUrlFromText(item.location?.displayName)
        ?? extractSupportedMeetingUrlFromText(item.bodyPreview)
        ?? extractSupportedMeetingUrlFromText(item.body?.content);
      return {
        id: item.id,
        provider: connection.provider,
        title: item.subject || "Untitled Event",
        description: item.bodyPreview || null,
        startTime: parseMicrosoftDateTime(item.start),
        endTime: parseMicrosoftDateTime(item.end),
        attendees: (item.attendees || []).map((a: any) => a.emailAddress?.address).filter(Boolean),
        organizerEmail: item.organizer?.emailAddress?.address || null,
        meetingUrl,
        htmlLink: item.webLink || null,
        status: item.isCancelled ? "cancelled" : null,
        visibility: item.sensitivity || null,
        transparency: item.showAs || null,
        responseStatus: item.responseStatus?.response || null,
      };
    });
  }

  return [];
}
