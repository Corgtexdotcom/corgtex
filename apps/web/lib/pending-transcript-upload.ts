import { createHash, randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret, getRedisClient, getSharedStateBackend, prisma, redisKey } from "@corgtex/shared";

const PENDING_TRANSCRIPT_TTL_SECONDS = 20 * 60;

export type PendingTranscriptPayload = {
  workspaceId: string;
  transcript: string;
  fileName: string | null;
  title: string | null;
  source: string | null;
  recordedAt: string | null;
  timeZone: string | null;
  summaryMd: string | null;
  ingestionGuidanceMd: string | null;
  participantIds: string[];
  participantEmails: string[];
  meetingId: string | null;
  createNewMeeting: boolean;
};

function isPendingTranscriptPayload(value: unknown): value is PendingTranscriptPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.workspaceId === "string"
    && typeof record.transcript === "string"
    && (typeof record.fileName === "string" || record.fileName === null)
    && (typeof record.title === "string" || record.title === null)
    && (typeof record.source === "string" || record.source === null)
    && (typeof record.recordedAt === "string" || record.recordedAt === null)
    && (typeof record.timeZone === "string" || record.timeZone === null)
    && (typeof record.summaryMd === "string" || record.summaryMd === null)
    && (typeof record.ingestionGuidanceMd === "string" || record.ingestionGuidanceMd === null)
    && Array.isArray(record.participantIds) && record.participantIds.every((item) => typeof item === "string")
    && Array.isArray(record.participantEmails) && record.participantEmails.every((item) => typeof item === "string")
    && (typeof record.meetingId === "string" || record.meetingId === null || record.meetingId === undefined)
    && (typeof record.createNewMeeting === "boolean" || record.createNewMeeting === undefined);
}

function pendingTranscriptKey(workspaceId: string, token: string) {
  return redisKey(`meeting-transcript-upload:${workspaceId}:${token}`);
}

function pendingTranscriptId(workspaceId: string, token: string) {
  return createHash("sha256").update(JSON.stringify([redisKey("meeting-transcript-upload"), workspaceId, token])).digest("hex");
}

// Only expire rows belonging to this workspace, with a bounded lock/cleanup batch.
async function cleanupExpired(workspaceId: string, now: Date) {
  await prisma.$executeRaw`
    WITH expired AS MATERIALIZED (
      SELECT "id" FROM "PendingTranscriptUpload"
      WHERE "workspaceId" = ${workspaceId} AND "expiresAt" <= ${now}
      ORDER BY "expiresAt" LIMIT 100 FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "PendingTranscriptUpload"
    WHERE "workspaceId" = ${workspaceId} AND "id" IN (SELECT "id" FROM expired)
  `;
}

export async function storePendingTranscriptPayload(payload: PendingTranscriptPayload) {
  try {
    if (!isPendingTranscriptPayload(payload)) return null;
    const token = randomUUID();
    if (getSharedStateBackend() === "postgres") {
      // Encrypt before any database operation: never write plaintext on missing keys.
      const encryptedPayload = encryptSecret(JSON.stringify(payload));
      const now = new Date();
      await cleanupExpired(payload.workspaceId, now);
      await prisma.pendingTranscriptUpload.create({ data: {
        id: pendingTranscriptId(payload.workspaceId, token),
        workspaceId: payload.workspaceId,
        encryptedPayload,
        expiresAt: new Date(now.getTime() + PENDING_TRANSCRIPT_TTL_SECONDS * 1000),
      } });
      return token;
    }
    const client = await getRedisClient();
    if (!client) return null;
    await client.setEx(pendingTranscriptKey(payload.workspaceId, token), PENDING_TRANSCRIPT_TTL_SECONDS, JSON.stringify(payload));
    return token;
  } catch {
    console.warn("Unable to store pending meeting transcript upload.");
    return null;
  }
}

export async function readPendingTranscriptPayload(workspaceId: string, token: string) {
  try {
    let raw: string | null;
    if (getSharedStateBackend() === "postgres") {
      const row = await prisma.pendingTranscriptUpload.findFirst({ where: {
        id: pendingTranscriptId(workspaceId, token), workspaceId, expiresAt: { gt: new Date() },
      } });
      if (!row) return null;
      raw = decryptSecret(row.encryptedPayload);
    } else {
      const client = await getRedisClient();
      if (!client) return null;
      raw = await client.get(pendingTranscriptKey(workspaceId, token));
    }
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPendingTranscriptPayload(parsed) || parsed.workspaceId !== workspaceId) return null;
    return parsed;
  } catch {
    console.warn("Unable to read pending meeting transcript upload.");
    return null;
  }
}

export async function deletePendingTranscriptPayload(workspaceId: string, token: string | null) {
  if (!token) return;
  try {
    if (getSharedStateBackend() === "postgres") {
      await prisma.pendingTranscriptUpload.deleteMany({ where: { id: pendingTranscriptId(workspaceId, token), workspaceId } });
      return;
    }
    const client = await getRedisClient();
    if (client) await client.del(pendingTranscriptKey(workspaceId, token));
  } catch {
    console.warn("Unable to clear pending meeting transcript upload.");
  }
}
