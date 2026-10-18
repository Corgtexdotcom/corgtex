import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
const { transcribe } = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock("@corgtex/domain", async importOriginal => ({
  ...await importOriginal<typeof import("@corgtex/domain")>(), runMeetingAudioAssetTranscription: transcribe,
}));
import { runPendingJobs } from "./outbox";

beforeEach(async () => {
  vi.resetAllMocks();
  await truncateAllTables();
});
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Audio completion", slug: randomUUID() } });
  return prisma.workflowJob.create({ data: { workspaceId: workspace.id, type: "meeting-audio.transcribe",
    payload: { audioAssetId: "synthetic-audio" }, dedupeKey: randomUUID(), runAfter: new Date(0) } });
}
describe("audio outbox attempt finalization", () => {
  it.each([false, true])("finalizes a freshly renewed same attempt (failure=%s)", async failure => {
    const job = await fixture();
    transcribe.mockImplementation(async () => {
      await prisma.workflowJob.update({ where: { id: job.id }, data: { lockedAt: new Date() } });
      if (failure) throw new Error("Synthetic provider failure");
      return { status: "ingested", meetingId: "synthetic-meeting" };
    });
    expect(await runPendingJobs("audio-worker", 1, 1)).toBe(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
    const current = await prisma.workflowJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(current.status).toBe(failure ? "PENDING" : "COMPLETED");
    expect(current.lockedAt).toBeNull();
    expect(current.lockedBy).toBeNull();
  });
  it.each([
    [false, "reclaimed"], [true, "reclaimed"], [false, "expired"], [true, "expired"],
    [false, "payload"], [true, "payload"], [false, "startedAt"], [true, "startedAt"],
  ] as const)("does not finalize changed authority (failure=%s, change=%s)", async (failure, change) => {
    const job = await fixture();
    let replacement: Awaited<ReturnType<typeof prisma.workflowJob.findUniqueOrThrow>>;
    transcribe.mockImplementation(async () => {
      replacement = await prisma.workflowJob.update({ where: { id: job.id }, data: {
        ...(change === "reclaimed" ? { lockedBy: "replacement-worker", attempts: 2 } : {}),
        ...(change === "expired" ? { lockedAt: new Date(Date.now() - 6 * 60_000) } : {}),
        ...(change === "payload" ? { payload: { audioAssetId: "synthetic-audio", replaced: true } } : {}),
        ...(change === "startedAt" ? { startedAt: new Date(0) } : {}),
      } });
      if (failure) throw new Error("Synthetic stale provider failure");
      return { status: "ingested", meetingId: "synthetic-meeting" };
    });
    expect(await runPendingJobs("audio-worker", 1, 1)).toBe(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(await prisma.workflowJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(replacement!);
  });
});
