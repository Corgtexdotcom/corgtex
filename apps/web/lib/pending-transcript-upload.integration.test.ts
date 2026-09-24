import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret, prisma } from "@corgtex/shared";
import { deletePendingTranscriptPayload, readPendingTranscriptPayload, storePendingTranscriptPayload, type PendingTranscriptPayload } from "./pending-transcript-upload";

let workspaceId: string;
let otherWorkspaceId: string;
function payload(): PendingTranscriptPayload {
  return { workspaceId, transcript: "Synthetic private transcript", fileName: null, title: null, source: null,
    recordedAt: null, timeZone: null, summaryMd: null, ingestionGuidanceMd: null,
    participantIds: [], participantEmails: [], meetingId: null, createNewMeeting: false };
}
beforeEach(async () => {
  vi.stubEnv("SHARED_STATE_BACKEND", "postgres");
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  workspaceId = (await prisma.workspace.create({ data: { name: "Synthetic transcript", slug: `transcript-${randomUUID()}` } })).id;
  otherWorkspaceId = (await prisma.workspace.create({ data: { name: "Other synthetic transcript", slug: `transcript-${randomUUID()}` } })).id;
});
afterEach(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("PostgreSQL pending transcripts", () => {
  it("encrypts durable content, supports reusable reads, and isolates tenant reads and deletion", async () => {
    const original = payload();
    const token = await storePendingTranscriptPayload(original);
    expect(token).toBeTruthy();
    const row = await prisma.pendingTranscriptUpload.findFirstOrThrow({ where: { workspaceId } });
    expect(row.id).not.toContain(token!);
    expect(row.encryptedPayload).not.toContain(original.transcript);
    expect(JSON.parse(decryptSecret(row.encryptedPayload))).toEqual(original);
    expect(await readPendingTranscriptPayload(workspaceId, token!)).toEqual(original);
    expect(await readPendingTranscriptPayload(workspaceId, token!)).toEqual(original);
    expect(await readPendingTranscriptPayload(otherWorkspaceId, token!)).toBeNull();
    await deletePendingTranscriptPayload(otherWorkspaceId, token);
    expect(await readPendingTranscriptPayload(workspaceId, token!)).toEqual(original);
    await deletePendingTranscriptPayload(workspaceId, token);
    expect(await readPendingTranscriptPayload(workspaceId, token!)).toBeNull();
  });

  it("never returns expired or corrupt ciphertext, and does not store when the key is absent", async () => {
    const token = await storePendingTranscriptPayload(payload());
    const row = await prisma.pendingTranscriptUpload.findFirstOrThrow({ where: { workspaceId } });
    await prisma.pendingTranscriptUpload.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect(await readPendingTranscriptPayload(workspaceId, token!)).toBeNull();
    await prisma.pendingTranscriptUpload.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() + 60000), encryptedPayload: "corrupt" } });
    expect(await readPendingTranscriptPayload(workspaceId, token!)).toBeNull();
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(await storePendingTranscriptPayload(payload())).toBeNull();
    expect(await prisma.pendingTranscriptUpload.count({ where: { workspaceId } })).toBe(1);
  });

  it("sweeps an inactive workspace's expired content on another workspace's upload using database time", async () => {
    const encryptedPayload = encryptSecret(JSON.stringify(payload()));
    const expiredId = randomUUID();
    const liveId = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "PendingTranscriptUpload" ("id", "workspaceId", "encryptedPayload", "expiresAt")
      VALUES
        (${expiredId}, ${workspaceId}, ${encryptedPayload}, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 minute'),
        (${liveId}, ${workspaceId}, ${encryptedPayload}, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '10 minutes')
    `;
    // An application clock ahead of the database must not expire still-live rows.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
    expect(await storePendingTranscriptPayload({ ...payload(), workspaceId: otherWorkspaceId })).toBeTruthy();
    expect(await prisma.pendingTranscriptUpload.findUnique({ where: { id: expiredId } })).toBeNull();
    expect(await prisma.pendingTranscriptUpload.findUnique({ where: { id: liveId } })).not.toBeNull();
    expect(await prisma.pendingTranscriptUpload.count({ where: { workspaceId: otherWorkspaceId } })).toBe(1);
  });

  it("bounds global expired cleanup to 100 rows across workspaces", async () => {
    const encryptedPayload = encryptSecret(JSON.stringify(payload()));
    await prisma.pendingTranscriptUpload.createMany({ data: Array.from({ length: 102 }, (_, index) => ({
      id: randomUUID(), workspaceId: index % 2 === 0 ? workspaceId : otherWorkspaceId,
      encryptedPayload, expiresAt: new Date(Date.now() - 60000),
    })) });
    expect(await storePendingTranscriptPayload(payload())).toBeTruthy();
    expect(await prisma.pendingTranscriptUpload.count({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })).toBe(3);
    expect(await prisma.pendingTranscriptUpload.count({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] }, expiresAt: { lt: new Date() } } })).toBe(2);
  });
});
