import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createMeeting } from "./meetings";
import { extractMeetingInsights } from "./meeting-intelligence";
import { registerClaimedMeetingTranscriptWorkflow } from "./native-meeting-workflow-claim";
import { withMeetingTranscriptWorker } from "./native-meeting-workflow-principal";

vi.mock("@corgtex/models", () => ({ defaultModelGateway: { extract: vi.fn() } }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const explicit = process.env.CORGTEX_DISPOSABLE_TEST_DATABASE_URL === process.env.DATABASE_URL
  && database.hostname === "127.0.0.1" && database.pathname === "/meeting_attempt_test";
const ci = process.env.GITHUB_ACTIONS === "true" && database.hostname === "localhost" && database.port === "5432";
if (!explicit && !ci) throw new Error("Meeting attempt tests require an explicitly assigned disposable fixture.");

beforeEach(async () => { await truncateAllTables(); vi.mocked(defaultModelGateway.extract).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic Meeting attempts", slug: randomUUID(), plan: "PAYG_AI" } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const human: AppActor = { kind: "user", user };
  const meeting = await createMeeting(human, { workspaceId: workspace.id, title: "Synthetic meeting",
    transcript: "The team decided to prepare a synthetic proposal.", source: "MANUAL_UPLOAD", recordedAt: new Date() });
  const job = await prisma.workflowJob.create({ data: { workspaceId: workspace.id, type: "meeting.insights.extract",
    payload: { meetingId: meeting.id }, status: "RUNNING", attempts: 1, lockedBy: "synthetic-worker", lockedAt: new Date(), startedAt: new Date() } });
  const claim = { workspaceId: workspace.id, meetingId: meeting.id, jobId: job.id, owner: job.lockedBy!, attempt: job.attempts,
    claim: registerClaimedMeetingTranscriptWorkflow({ ...job, lockedBy: job.lockedBy!, lockedAt: job.lockedAt! }) };
  return { workspace, member, human, meeting, job, claim };
}
const output = { insights: [{ type: "DECISION", title: "Prepare proposal", body: "The team agreed to prepare the proposal.", confidence: 0.9 }] };

describe("Meeting extraction provider-attempt authority", () => {
  it.each(["credentials", "retry"] as const)("retains original source and caller proofs plus native claim after %s waits", async boundary => {
    for (const change of ["source", "caller", "claim", "none"] as const) {
      const f = await fixture(); let sends = 0;
      vi.mocked(defaultModelGateway.extract).mockImplementationOnce(async request => {
        const context = { signal: request.signal ?? new AbortController().signal };
        if (boundary === "retry") { await request.authorizeAttempt?.(context); sends++; }
        await Promise.resolve();
        if (change === "source") {
          await prisma.meeting.update({ where: { id: f.meeting.id }, data: { archivedAt: new Date() } });
          await prisma.meeting.update({ where: { id: f.meeting.id }, data: { archivedAt: null } });
        }
        if (change === "caller") {
          await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
          await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
        }
        if (change === "claim") await prisma.workflowJob.update({ where: { id: f.job.id }, data: { lockedBy: "replacement-worker", attempts: 2 } });
        await request.authorizeAttempt?.(context); sends++;
        return { output } as never;
      });
      const work = (actor: AppActor) => extractMeetingInsights(actor, { workspaceId: f.workspace.id, meetingId: f.meeting.id, workflowJobId: f.job.id });
      const result = await (change === "claim" ? withMeetingTranscriptWorker(f.claim, work) : work(f.human)).catch(error => error);
      expect(sends).toBe((boundary === "retry" ? 1 : 0) + (change === "none" ? 1 : 0));
      if (change === "none") expect(result).toHaveLength(1);
      else expect(result).toBeInstanceOf(Error);
      expect(await prisma.meetingInsight.count({ where: { meetingId: f.meeting.id } })).toBe(change === "none" ? 1 : 0);
    }
  });

  it("publishes for the unchanged exact native worker purpose", async () => {
    const f = await fixture(); let sends = 0;
    vi.mocked(defaultModelGateway.extract).mockImplementationOnce(async request => {
      await request.authorizeAttempt?.({ signal: request.signal ?? new AbortController().signal }); sends++;
      return { output } as never;
    });
    const result = await withMeetingTranscriptWorker(f.claim, actor => extractMeetingInsights(actor,
      { workspaceId: f.workspace.id, meetingId: f.meeting.id, workflowJobId: f.job.id }));
    expect(sends).toBe(1); expect(result).toHaveLength(1);
    expect(await prisma.meetingInsight.count({ where: { meetingId: f.meeting.id } })).toBe(1);
  });

  it("cannot publish when an adapter swallows a failed native claim guard then restores the claim", async () => {
    const f = await fixture();
    vi.mocked(defaultModelGateway.extract).mockImplementationOnce(async request => {
      await prisma.workflowJob.update({ where: { id: f.job.id }, data: { lockedBy: "replacement-worker" } });
      await request.authorizeAttempt?.({ signal: request.signal ?? new AbortController().signal }).catch(() => {});
      await prisma.workflowJob.update({ where: { id: f.job.id }, data: { lockedBy: f.job.lockedBy } });
      return { output } as never;
    });
    await expect(withMeetingTranscriptWorker(f.claim, actor => extractMeetingInsights(actor,
      { workspaceId: f.workspace.id, meetingId: f.meeting.id, workflowJobId: f.job.id }))).rejects.toMatchObject({ code: "MEETING_WORKFLOW_JOB_LOST" });
    expect(await prisma.meetingInsight.count({ where: { meetingId: f.meeting.id } })).toBe(0);
  });
});
