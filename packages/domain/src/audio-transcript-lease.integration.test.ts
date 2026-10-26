import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createMeetingAudioAsset } from "./meeting-audio-assets";
import { createAudioTranscriptWorkerActor, revokeAudioTranscriptWorkerActor } from "./native-transcript-input";
import { isArtifactInputProofReadable } from "./source-lineage";

const previousKey = process.env.ENCRYPTION_KEY;
let actorToRevoke: AppActor | undefined;
beforeEach(async () => {
  process.env.ENCRYPTION_KEY = "1".repeat(64);
  await truncateAllTables();
});
afterEach(() => {
  vi.useRealTimers();
  if (actorToRevoke) revokeAudioTranscriptWorkerActor(actorToRevoke);
  actorToRevoke = undefined;
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousKey;
});
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Audio lease test", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Owner" } };
  const uploaded = await createMeetingAudioAsset(actor, { workspaceId: workspace.id, fileName: "synthetic.m4a",
    mimeType: "audio/mp4", fileBuffer: Buffer.from("audio"), storage: {
      put: async () => ({ key: "synthetic" }), get: async () => null, delete: async () => undefined,
    } as never });
  const now = new Date();
  const job = await prisma.workflowJob.update({ where: { id: uploaded.workflowJobId }, data: {
    status: "RUNNING", attempts: 1, lockedBy: "audio-worker", lockedAt: now, startedAt: now,
  } });
  const params = { workspaceId: workspace.id, audioAssetId: uploaded.audioAsset.id, workflowJobId: job.id,
    expectedLease: { attempts: 1, lockedBy: "audio-worker", lockedAt: now } };
  const worker = await createAudioTranscriptWorkerActor(params);
  actorToRevoke = worker.actor;
  return { workspace, member, job, worker, params, now };
}

describe("audio immutable attempt and renewable lease", () => {
  it("renews the same original proof beyond five minutes without changing attempt identity", async () => {
    const { worker, workspace, job, now } = await fixture();
    const originalRoots = JSON.stringify(worker.roots);
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let minute = 1; minute <= 6; minute++) {
      vi.setSystemTime(now.getTime() + minute * 60_000);
      await Promise.all([worker.renewLease(), worker.renewLease()]);
      expect(await isArtifactInputProofReadable(worker.actor, workspace.id, worker.roots)).toBe(true);
    }
    const current = await prisma.workflowJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(current.lockedAt?.getTime()).toBe(now.getTime() + 6 * 60_000);
    expect(current).toMatchObject({ attempts: 1, lockedBy: job.lockedBy, startedAt: job.startedAt, payload: job.payload });
    expect(JSON.stringify(worker.roots)).toBe(originalRoots);
  });
  it("rejects an expired attempt instead of reviving its old timestamp", async () => {
    const { worker, job, now, params } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now.getTime() + 5 * 60_000 + 1);
    await expect(worker.renewLease()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(createAudioTranscriptWorkerActor(params)).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect((await prisma.workflowJob.findUniqueOrThrow({ where: { id: job.id } })).lockedAt).toEqual(now);
  });
  it.each(["owner", "attempt", "payload", "startedAt", "lease"] as const)("rejects changed %s without touching the replacement", async field => {
    const { worker, job, workspace, now } = await fixture();
    const replacement = await prisma.workflowJob.update({ where: { id: job.id }, data: {
      ...(field === "owner" ? { lockedBy: "replacement" } : {}),
      ...(field === "attempt" ? { attempts: 2 } : {}),
      ...(field === "payload" ? { payload: { ...job.payload as object, changed: true } } : {}),
      ...(field === "startedAt" ? { startedAt: new Date(now.getTime() + 1) } : {}),
      ...(field === "lease" ? { lockedAt: new Date(now.getTime() + 1) } : {}),
    } });
    await expect(worker.renewLease()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.workflowJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(replacement);
    if (field !== "lease") expect(await isArtifactInputProofReadable(worker.actor, workspace.id, worker.roots)).toBe(false);
  });
  it("does not refresh the original permission proof after owner revoke and restore", async () => {
    const { worker, member, job, now } = await fixture();
    await prisma.member.update({ where: { id: member.id }, data: { isActive: false } });
    await prisma.member.update({ where: { id: member.id }, data: { isActive: true } });
    await expect(worker.renewLease()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect((await prisma.workflowJob.findUniqueOrThrow({ where: { id: job.id } })).lockedAt).toEqual(now);
  });
  it("retains its original source through final status writes while a renewal is in flight", async () => {
    const { worker, workspace, job, params } = await fixture();
    let releaseWrite!: () => void;
    let writeLocked!: () => void;
    const ready = new Promise<void>(resolve => { writeLocked = resolve; });
    const release = new Promise<void>(resolve => { releaseWrite = resolve; });
    const finishing = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "WorkflowJob" WHERE "id" = ${job.id} FOR SHARE`;
      expect(await isArtifactInputProofReadable(worker.actor, workspace.id, worker.roots, tx)).toBe(true);
      writeLocked();
      await release;
      await tx.meetingAudioAsset.update({ where: { id: params.audioAssetId }, data: {
        status: "INGESTED", transcriptText: "Synthetic transcript", transcribedAt: new Date(), ingestedAt: new Date(),
      } });
    });
    await ready;
    const renewal = worker.renewLease();
    releaseWrite();
    await Promise.all([finishing, renewal]);
    expect(await isArtifactInputProofReadable(worker.actor, workspace.id, worker.roots)).toBe(true);
    expect((await prisma.meetingAudioAsset.findUniqueOrThrow({ where: { id: params.audioAssetId } })).status).toBe("INGESTED");
  });

});
