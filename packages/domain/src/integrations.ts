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

function mergeOAuthScopes(existingScopes: string[], grantedScopes: string[]) {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const scope of [...existingScopes, ...grantedScopes]) {
    const trimmed = scope.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(trimmed);
  }
  return merged;
}

function hasGoogleCalendarScope(scopes: string[]) {
  return scopes.some((scope) => scope.toLowerCase() === "https://www.googleapis.com/auth/calendar.readonly");
}

function hasCalendarSyncScope(provider: OAuthProvider, scopes: string[]) {
  if (provider === "GOOGLE") return hasGoogleCalendarScope(scopes);
  if (provider === "MICROSOFT") return scopes.some((scope) => scope.toLowerCase() === "calendars.read");
  return false;
}

function defaultOAuthSyncSettings(): Prisma.InputJsonValue {
  return {
    calendar: { enabled: true, includeAllEvents: false },
    documents: { enabled: false, selectedDriveIds: [] },
    email: { enabled: false, filters: [] },
  };
}

function enableCalendarInSyncSettings(settings: unknown): Prisma.InputJsonValue {
  const current = syncSettingsRecord(settings);
  const calendar = syncSettingsRecord(current.calendar);
  return {
    calendar: {
      ...calendar,
      enabled: true,
      includeAllEvents: calendar.includeAllEvents === true,
    },
    documents: syncSettingsRecord(current.documents),
    email: syncSettingsRecord(current.email),
  } as Prisma.InputJsonValue;
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
  createSyncSettings?: Prisma.InputJsonValue;
  enqueueCalendarSync?: boolean;
  enableCalendarSync?: boolean;
}) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only users can connect OAuth providers.");

  if (params.workspaceId) {
    await requireWorkspaceMembership({
      actor,
      workspaceId: params.workspaceId,
    });
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.oAuthConnection.findUnique({
      where: { userId_provider: { userId: actor.user.id, provider: params.provider } },
      select: {
        id: true,
        scopes: true,
        syncSettings: true,
      },
    });
    const scopes = mergeOAuthScopes(existing?.scopes ?? [], params.scopes ?? []);
    const createSyncSettings = params.enableCalendarSync
      ? enableCalendarInSyncSettings(params.createSyncSettings ?? params.syncSettings ?? defaultOAuthSyncSettings())
      : params.createSyncSettings ?? params.syncSettings ?? defaultOAuthSyncSettings();
    const updateSyncSettings = params.syncSettings !== undefined
      ? params.syncSettings
      : params.enableCalendarSync
        ? enableCalendarInSyncSettings(existing?.syncSettings ?? defaultOAuthSyncSettings())
        : undefined;

    const connection = existing
      ? await tx.oAuthConnection.update({
        where: { id: existing.id },
        data: {
          workspaceId: params.workspaceId ?? null,
          accessToken: encryptOAuthToken(params.accessToken),
          refreshToken: params.refreshToken ? encryptOAuthToken(params.refreshToken) : undefined,
          tokenStorageVersion: ENCRYPTED_TOKEN_STORAGE_VERSION,
          expiresAt: params.expiresIn ? new Date(Date.now() + params.expiresIn * 1000) : null,
          providerAccountId: params.providerAccountId,
          providerEmail: params.providerEmail ?? undefined,
          scopes,
          status: "ACTIVE",
          disconnectedAt: null,
          lastSyncError: null,
          ...(updateSyncSettings === undefined ? {} : { syncSettings: updateSyncSettings }),
        },
      })
      : await tx.oAuthConnection.create({
        data: {
          userId: actor.user.id,
          workspaceId: params.workspaceId ?? null,
          provider: params.provider,
          accessToken: encryptOAuthToken(params.accessToken),
          refreshToken: params.refreshToken ? encryptOAuthToken(params.refreshToken) : null,
          tokenStorageVersion: ENCRYPTED_TOKEN_STORAGE_VERSION,
          expiresAt: params.expiresIn ? new Date(Date.now() + params.expiresIn * 1000) : null,
          providerAccountId: params.providerAccountId,
          providerEmail: params.providerEmail ?? null,
          scopes,
          status: "ACTIVE",
          syncSettings: createSyncSettings,
        },
      });

    if (params.workspaceId && params.enqueueCalendarSync !== false && hasCalendarSyncScope(params.provider, scopes)) {
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

export async function deleteOAuthConnection(actor: AppActor, params: {
  workspaceId: string;
  connectionId: string;
}) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only users can delete OAuth connections.");
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

  await prisma.oAuthConnection.delete({
    where: { id: params.connectionId },
  });

  return { id: params.connectionId };
}

function syncSection(settings: unknown, key: "calendar" | "documents" | "email") {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const value = (settings as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function syncEnabled(settings: unknown, key: "calendar" | "documents" | "email", defaultEnabled = false) {
  const section = syncSection(settings, key);
  return section.enabled === true || (defaultEnabled && section.enabled !== false);
}

export async function enqueueOAuthConnectionSync(actor: AppActor, params: {
  workspaceId: string;
  connectionId: string;
  kinds?: Array<"calendar" | "documents" | "email">;
}) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only users can sync OAuth connections.");
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
    select: {
      id: true,
      provider: true,
      scopes: true,
      status: true,
      syncSettings: true,
    },
  });
  invariant(connection, 404, "NOT_FOUND", "OAuth connection not found.");
  invariant(connection.status === "ACTIVE", 400, "CONNECTION_NOT_ACTIVE", "OAuth connection is not active.");

  const candidateKinds = params.kinds && params.kinds.length > 0
    ? params.kinds
    : ([
      syncEnabled(connection.syncSettings, "calendar", true) ? "calendar" : null,
      syncEnabled(connection.syncSettings, "documents") ? "documents" : null,
      syncEnabled(connection.syncSettings, "email") ? "email" : null,
    ].filter(Boolean) as Array<"calendar" | "documents" | "email">);
  const requestedKinds = candidateKinds.filter((kind) => syncEnabled(
    connection.syncSettings,
    kind,
    kind === "calendar",
  )).filter((kind) => {
    if (kind === "calendar") return hasCalendarSyncScope(connection.provider, connection.scopes);
    if (kind === "documents") {
      return connection.provider === "GOOGLE"
        ? hasGoogleDriveDocumentScope(connection.scopes)
        : connection.scopes.some((scope) => ["files.read", "sites.read.all"].includes(scope.toLowerCase()));
    }
    if (kind === "email") {
      return connection.scopes.some((scope) => ["https://www.googleapis.com/auth/gmail.readonly", "mail.read"].includes(scope.toLowerCase()));
    }
    return false;
  });

  const jobTypes = {
    calendar: "calendar.sync",
    documents: "oauth.documents.sync",
    email: "oauth.email.sync",
  } as const;
  const now = Date.now();
  const jobs = [];
  for (const kind of requestedKinds) {
    jobs.push(await prisma.workflowJob.upsert({
      where: { dedupeKey: `${params.connectionId}:${kind}:manual-sync:${now}` },
      update: {},
      create: {
        workspaceId: params.workspaceId,
        eventId: null,
        type: jobTypes[kind],
        payload: { connectionId: params.connectionId },
        dedupeKey: `${params.connectionId}:${kind}:manual-sync:${now}`,
      },
    }));
  }

  return { scheduled: jobs.map((job) => job.type) };
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
  let connection = await prisma.oAuthConnection.findUnique({
    where: { id: connectionId },
  });

  if (!connection) throw new Error("Connection not found");

  if (connection.tokenStorageVersion !== ENCRYPTED_TOKEN_STORAGE_VERSION) {
    const refreshToken = oauthRefreshToken(connection);
    const accessTokenEnc = encryptOAuthToken(oauthAccessToken(connection));
    const refreshTokenEnc = refreshToken ? encryptOAuthToken(refreshToken) : null;
    await prisma.oAuthConnection.update({
      where: { id: connection.id },
      data: {
        accessToken: accessTokenEnc,
        refreshToken: refreshTokenEnc,
        tokenStorageVersion: ENCRYPTED_TOKEN_STORAGE_VERSION,
      },
    });
    connection = {
      ...connection,
      accessToken: accessTokenEnc,
      refreshToken: refreshTokenEnc,
      tokenStorageVersion: ENCRYPTED_TOKEN_STORAGE_VERSION,
    };
  }

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
      const response = await fetch("https://login.microsoftonline.com/organizations/oauth2/v2.0/token", {
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

export interface OAuthDocumentSource {
  id: string;
  sourceKey: string;
  provider: OAuthProvider;
  name: string;
  mimeType: string | null;
  webUrl: string | null;
  modifiedAt: Date | null;
  contentText: string;
}

export interface GoogleDriveDocumentCandidate {
  id: string;
  name: string;
  mimeType: string | null;
  webUrl: string | null;
  modifiedAt: Date | null;
}

export interface OAuthEmailMessage {
  id: string;
  provider: OAuthProvider;
  subject: string;
  from: string | null;
  receivedAt: Date | null;
  webUrl: string | null;
  snippet: string;
  filter: string;
}

async function readProviderTextResponse(response: Response, label: string) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} API error: ${text}`);
  }
  return text;
}

async function readProviderJsonResponse(response: Response, label: string) {
  const text = await readProviderTextResponse(response, label);
  return text ? JSON.parse(text) as any : {};
}

const GOOGLE_DRIVE_DOCUMENT_MIME_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
];

function hasGoogleDriveDocumentScope(scopes: string[]) {
  return scopes.some((scope) => {
    const normalized = scope.toLowerCase();
    return normalized === "https://www.googleapis.com/auth/drive.file"
      || normalized === "https://www.googleapis.com/auth/drive.readonly";
  });
}

function escapeGoogleDriveQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function syncSettingsRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mergeDocumentSyncSettings(settings: unknown, selectedDriveIds: string[]) {
  const current = syncSettingsRecord(settings);
  return {
    calendar: syncSettingsRecord(current.calendar),
    documents: {
      ...syncSettingsRecord(current.documents),
      enabled: true,
      selectedDriveIds,
    },
    email: syncSettingsRecord(current.email),
  };
}

async function findUserGoogleDriveConnection(actor: AppActor, workspaceId: string) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only users can connect Google Drive.");
  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.oAuthConnection.findFirst({
    where: {
      userId: actor.user.id,
      provider: "GOOGLE",
      status: "ACTIVE",
      OR: [
        { workspaceId },
        { workspaceId: null },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      workspaceId: true,
      providerEmail: true,
      providerAccountId: true,
      scopes: true,
      syncSettings: true,
      status: true,
    },
  });
}

export async function listGoogleDriveDocuments(actor: AppActor, params: {
  workspaceId: string;
  query?: string | null;
  take?: number;
}) {
  const connection = await findUserGoogleDriveConnection(actor, params.workspaceId);
  if (!connection) {
    return {
      connection: null,
      documents: [] as GoogleDriveDocumentCandidate[],
    };
  }

  const hasDocumentScope = hasGoogleDriveDocumentScope(connection.scopes);
  const connectionSummary = {
    id: connection.id,
    providerEmail: connection.providerEmail,
    providerAccountId: connection.providerAccountId,
    hasDocumentScope,
  };
  if (!hasDocumentScope) {
    return {
      connection: connectionSummary,
      documents: [] as GoogleDriveDocumentCandidate[],
    };
  }

  const refreshed = await refreshOAuthTokenIfNeeded(connection.id);
  if (refreshed.status !== "ACTIVE") {
    return {
      connection: connectionSummary,
      documents: [] as GoogleDriveDocumentCandidate[],
    };
  }

  const mimeQuery = GOOGLE_DRIVE_DOCUMENT_MIME_TYPES
    .map((mimeType) => `mimeType='${mimeType}'`)
    .join(" or ");
  const trimmedQuery = params.query?.trim();
  const q = [
    "trashed=false",
    `(${mimeQuery})`,
    trimmedQuery ? `name contains '${escapeGoogleDriveQuery(trimmedQuery)}'` : null,
  ].filter(Boolean).join(" and ");
  const searchParams = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,webViewLink,modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: String(Math.max(1, Math.min(params.take ?? 25, 50))),
  });

  const data = await readProviderJsonResponse(await fetch(
    `https://www.googleapis.com/drive/v3/files?${searchParams}`,
    { headers: { Authorization: `Bearer ${oauthAccessToken(refreshed)}` } },
  ), "Google Drive");

  const documents = Array.isArray(data.files)
    ? data.files.map((item: any) => ({
      id: String(item.id ?? ""),
      name: String(item.name ?? "Untitled Google document"),
      mimeType: typeof item.mimeType === "string" ? item.mimeType : null,
      webUrl: typeof item.webViewLink === "string" ? item.webViewLink : null,
      modifiedAt: typeof item.modifiedTime === "string" ? new Date(item.modifiedTime) : null,
    })).filter((item: GoogleDriveDocumentCandidate) => item.id)
    : [];

  return {
    connection: connectionSummary,
    documents,
  };
}

export async function selectGoogleDriveDocumentsForSync(actor: AppActor, params: {
  workspaceId: string;
  documentIds: string[];
}) {
  const selectedDriveIds = Array.from(new Set(params.documentIds.map((id) => id.trim()).filter(Boolean))).slice(0, 50);
  invariant(selectedDriveIds.length > 0, 400, "INVALID_INPUT", "Select at least one Google Drive document.");

  const connection = await findUserGoogleDriveConnection(actor, params.workspaceId);
  invariant(connection, 404, "NOT_FOUND", "Google Drive is not connected.");
  invariant(hasGoogleDriveDocumentScope(connection.scopes), 403, "GOOGLE_DRIVE_SCOPE_REQUIRED", "Google Drive document access has not been granted.");

  await prisma.oAuthConnection.update({
    where: { id: connection.id },
    data: {
      workspaceId: params.workspaceId,
      syncSettings: mergeDocumentSyncSettings(connection.syncSettings, selectedDriveIds) as Prisma.InputJsonValue,
      lastSyncError: null,
    },
  });

  return enqueueOAuthConnectionSync(actor, {
    workspaceId: params.workspaceId,
    connectionId: connection.id,
    kinds: ["documents"],
  });
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

function microsoftDriveItemPath(selectedId: string) {
  const delimiter = selectedId.includes("|") ? "|" : selectedId.includes(":") ? ":" : null;
  if (!delimiter) {
    return `/me/drive/items/${encodeURIComponent(selectedId)}`;
  }
  const [driveId, itemId] = selectedId.split(delimiter, 2).map((part) => part.trim());
  if (!driveId || !itemId) {
    return `/me/drive/items/${encodeURIComponent(selectedId)}`;
  }
  return `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
}

function googleExportMimeType(mimeType: string | null) {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return "text/plain";
    case "application/vnd.google-apps.spreadsheet":
      return "text/csv";
    case "application/vnd.google-apps.presentation":
      return "text/plain";
    default:
      return null;
  }
}

function isPlainTextDocumentMimeType(mimeType: string | null) {
  if (!mimeType) return false;
  const lower = mimeType.toLowerCase();
  return lower.startsWith("text/")
    || lower === "application/json"
    || lower === "application/ld+json"
    || lower === "application/xml"
    || lower === "application/xhtml+xml"
    || lower === "application/yaml"
    || lower === "application/x-yaml"
    || lower === "application/javascript"
    || lower === "application/x-javascript"
    || lower === "application/typescript"
    || lower === "application/sql";
}

export async function fetchSelectedDocuments(connectionId: string, selectedDocumentIds: string[]): Promise<OAuthDocumentSource[]> {
  const ids = selectedDocumentIds.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return [];

  const connection = await refreshOAuthTokenIfNeeded(connectionId);
  if (connection.status !== "ACTIVE") return [];
  const accessToken = oauthAccessToken(connection);
  const documents: OAuthDocumentSource[] = [];

  if (connection.provider === "GOOGLE") {
    for (const id of ids) {
      const metadata = await readProviderJsonResponse(await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,webViewLink,modifiedTime`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ), "Google Drive");
      const mimeType = typeof metadata.mimeType === "string" ? metadata.mimeType : null;
      const isGoogleDoc = mimeType?.startsWith("application/vnd.google-apps.") ?? false;
      const exportMimeType = isGoogleDoc ? googleExportMimeType(mimeType) : null;
      if (isGoogleDoc && !exportMimeType) continue;
      if (!isGoogleDoc && !isPlainTextDocumentMimeType(mimeType)) continue;
      const contentUrl = isGoogleDoc && exportMimeType
        ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportMimeType)}`
        : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
      const contentText = await readProviderTextResponse(await fetch(contentUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }), "Google Drive");
      documents.push({
        id: String(metadata.id ?? id),
        sourceKey: id,
        provider: connection.provider,
        name: String(metadata.name ?? "Untitled Google document"),
        mimeType,
        webUrl: typeof metadata.webViewLink === "string" ? metadata.webViewLink : null,
        modifiedAt: typeof metadata.modifiedTime === "string" ? new Date(metadata.modifiedTime) : null,
        contentText,
      });
    }
    return documents;
  }

  if (connection.provider === "MICROSOFT") {
    for (const id of ids) {
      const itemPath = microsoftDriveItemPath(id);
      const metadata = await readProviderJsonResponse(await fetch(
        `https://graph.microsoft.com/v1.0${itemPath}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ), "Microsoft Graph");
      const mimeType = typeof metadata.file?.mimeType === "string" ? metadata.file.mimeType : null;
      if (!isPlainTextDocumentMimeType(mimeType)) continue;
      const contentText = await readProviderTextResponse(await fetch(
        `https://graph.microsoft.com/v1.0${itemPath}/content`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ), "Microsoft Graph");
      documents.push({
        id: String(metadata.id ?? id),
        sourceKey: id,
        provider: connection.provider,
        name: String(metadata.name ?? "Untitled Microsoft document"),
        mimeType,
        webUrl: typeof metadata.webUrl === "string" ? metadata.webUrl : null,
        modifiedAt: typeof metadata.lastModifiedDateTime === "string" ? new Date(metadata.lastModifiedDateTime) : null,
        contentText,
      });
    }
  }

  return documents;
}

function messageHeader(headers: unknown, name: string) {
  if (!Array.isArray(headers)) return null;
  const match = headers.find((header) => (
    header &&
    typeof header === "object" &&
    typeof (header as { name?: unknown }).name === "string" &&
    (header as { name: string }).name.toLowerCase() === name.toLowerCase()
  ));
  const value = match ? (match as { value?: unknown }).value : null;
  return typeof value === "string" ? value : null;
}

export async function fetchFilteredEmailMessages(connectionId: string, filters: string[]): Promise<OAuthEmailMessage[]> {
  const safeFilters = filters.map((filter) => filter.trim()).filter(Boolean);
  if (safeFilters.length === 0) return [];

  const connection = await refreshOAuthTokenIfNeeded(connectionId);
  if (connection.status !== "ACTIVE") return [];
  const accessToken = oauthAccessToken(connection);
  const messages: OAuthEmailMessage[] = [];

  if (connection.provider === "GOOGLE") {
    for (const filter of safeFilters) {
      const query = new URLSearchParams({ q: filter, maxResults: "10" });
      const listing = await readProviderJsonResponse(await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ), "Gmail");
      const messageRefs = Array.isArray(listing.messages) ? listing.messages : [];
      for (const ref of messageRefs) {
        const id = typeof ref?.id === "string" ? ref.id : null;
        if (!id) continue;
        const detail = await readProviderJsonResponse(await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ), "Gmail");
        const headers = detail.payload?.headers;
        const date = messageHeader(headers, "Date");
        messages.push({
          id: String(detail.id ?? id),
          provider: connection.provider,
          subject: messageHeader(headers, "Subject") ?? "Untitled email",
          from: messageHeader(headers, "From"),
          receivedAt: date ? new Date(date) : null,
          webUrl: null,
          snippet: typeof detail.snippet === "string" ? detail.snippet : "",
          filter,
        });
      }
    }
    return messages;
  }

  if (connection.provider === "MICROSOFT") {
    for (const filter of safeFilters) {
      const query = new URLSearchParams({
        $top: "10",
        $search: `"${filter.replace(/"/g, "\\\"")}"`,
        $select: "id,subject,from,receivedDateTime,webLink,bodyPreview",
      });
      const listing = await readProviderJsonResponse(await fetch(
        `https://graph.microsoft.com/v1.0/me/messages?${query}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ConsistencyLevel: "eventual",
          },
        },
      ), "Microsoft Graph");
      for (const item of Array.isArray(listing.value) ? listing.value : []) {
        messages.push({
          id: String(item.id),
          provider: connection.provider,
          subject: typeof item.subject === "string" && item.subject.trim() ? item.subject : "Untitled email",
          from: typeof item.from?.emailAddress?.address === "string" ? item.from.emailAddress.address : null,
          receivedAt: typeof item.receivedDateTime === "string" ? new Date(item.receivedDateTime) : null,
          webUrl: typeof item.webLink === "string" ? item.webLink : null,
          snippet: typeof item.bodyPreview === "string" ? item.bodyPreview : "",
          filter,
        });
      }
    }
  }

  return messages;
}
