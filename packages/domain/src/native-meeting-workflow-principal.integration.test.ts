import { registerClaimedMeetingTranscriptWorkflow } from "./native-meeting-workflow-claim";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureDirectMemberTranscriptInput, directMemberTranscriptRoots } from "./native-transcript-input";
import { markMeetingTranscriptProcessingStage } from "./meeting-transcript-processing";
import { createMeeting } from "./meetings";
import { captureArtifactInputProof, isArtifactInputProofReadable } from "./source-lineage";
import { withMeetingTranscriptWorker, getMeetingTranscriptWorkerPurpose,
  isMeetingTranscriptWorkerCurrent, assertMeetingTranscriptWorkerCurrent } from "./native-meeting-workflow-principal";

beforeEach(truncateAllTables);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function fixture(privateNative = false) {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic Meeting worker", slug: randomUUID(), plan: "PAYG_AI"}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const human: AppActor = {kind: "user", user};
  const submission = {workspaceId: workspace.id, transcript: "Jan: I will prepare the synthetic proposal.", title: "Synthetic Meeting"};
  const receipt = await captureDirectMemberTranscriptInput(human, {workspaceId: workspace.id, submission});
  const roots = await directMemberTranscriptRoots(human, workspace.id, submission, receipt);
  const meeting = await createMeeting(human, {...submission, source: "MANUAL_UPLOAD", recordedAt: new Date(),
    ...(privateNative ? {lineageRoots: roots} : {})});
  const job = await prisma.workflowJob.create({data: {workspaceId: workspace.id, type: "agent.meeting-summary",
    payload: {meetingId: meeting.id}, status: "RUNNING", attempts: 1, lockedBy: "synthetic-worker", lockedAt: new Date()}});
  const claim = {workspaceId: workspace.id, meetingId: meeting.id, jobId: job.id, owner: job.lockedBy!, attempt: job.attempts, claim: registerClaimedMeetingTranscriptWorkflow({...job, lockedBy: job.lockedBy!, lockedAt: job.lockedAt!})};
  return {workspace, human, meeting, job, claim, receipt};
}
describe("claimed Meeting transcript execution purpose", () => {
  it("binds an already-readable human original without native access or surviving scope", async () => {
    const f = await fixture();
    const forbiddenWork = vi.fn();
    await expect(withMeetingTranscriptWorker({...f.claim, claim: undefined}, forbiddenWork)).rejects.toMatchObject({code: "MEETING_WORKFLOW_JOB_LOST"});
    await expect(withMeetingTranscriptWorker({...f.claim, claim: {...f.claim.claim}}, forbiddenWork)).rejects.toMatchObject({code: "MEETING_WORKFLOW_JOB_LOST"});
    expect(forbiddenWork).not.toHaveBeenCalled();
    let captured: AppActor | undefined;
    await withMeetingTranscriptWorker(f.claim, async actor => {
      captured = actor;
      const purpose = getMeetingTranscriptWorkerPurpose(actor, f.workspace.id)!;
      expect(purpose.nativeInputs).toEqual([]);
      expect(await isMeetingTranscriptWorkerCurrent(actor, f.workspace.id, {meetingId: f.meeting.id})).toBe(true);
      expect(await isMeetingTranscriptWorkerCurrent(actor, f.workspace.id, {meetingId: f.meeting.id, inputId: f.receipt.inputId})).toBe(false);
      expect(await isMeetingTranscriptWorkerCurrent({...actor}, f.workspace.id, {meetingId: f.meeting.id})).toBe(false);
      expect(await isMeetingTranscriptWorkerCurrent(actor, "other-workspace", {meetingId: f.meeting.id})).toBe(false);
      expect(await isMeetingTranscriptWorkerCurrent(actor, f.workspace.id, {meetingId: f.meeting.id, inputId: "unselected"})).toBe(false);
      const roots = await captureArtifactInputProof(f.human, f.workspace.id, [{kind: "MeetingTranscript", id: f.meeting.id}]);
      expect(await isArtifactInputProofReadable(actor, f.workspace.id, roots)).toBe(true);
      await prisma.workflowJob.update({where: {id: f.job.id}, data: {lockedAt: new Date()}});
      expect(await isMeetingTranscriptWorkerCurrent(actor, f.workspace.id, {meetingId: f.meeting.id})).toBe(true);
      await prisma.meeting.update({where: {id: f.meeting.id}, data: {summaryMd: "An output update does not replace the transcript"}});
      expect(await isMeetingTranscriptWorkerCurrent(actor, f.workspace.id, {meetingId: f.meeting.id})).toBe(true);
    });
    expect(getMeetingTranscriptWorkerPurpose(captured!, f.workspace.id)).toBeNull();
    await expect(assertMeetingTranscriptWorkerCurrent(captured!, f.workspace.id)).rejects.toMatchObject({code: "MEETING_WORKFLOW_JOB_LOST"});
  });
  it("does not fall back for private native, unknown or archive-restored originals", async () => {
    const f = await fixture(true);
    const work = vi.fn();
    await expect(withMeetingTranscriptWorker(f.claim, work)).rejects.toMatchObject({code: "MEETING_TRANSCRIPT_RESTRICTED"});
    const g = await fixture();
    await prisma.artifactInputLineage.updateMany({where: {workspaceId: g.workspace.id, artifactType: "MeetingTranscript", artifactId: g.meeting.id}, data: {origin: "UNKNOWN"}});
    await expect(withMeetingTranscriptWorker(g.claim, work)).rejects.toMatchObject({code: "MEETING_TRANSCRIPT_UNPROVED"});
    const h = await fixture();
    await prisma.meeting.update({where: {id: h.meeting.id}, data: {archivedAt: new Date()}});
    await prisma.meeting.update({where: {id: h.meeting.id}, data: {archivedAt: null}});
    await expect(withMeetingTranscriptWorker(h.claim, work)).rejects.toMatchObject({code: "MEETING_TRANSCRIPT_RESTRICTED"});
    expect(work).not.toHaveBeenCalled();
  });
  it("rejects expired, completed, wrong-owner/attempt/type and payload claims before executing work", async () => {
    const f = await fixture();
    const work = vi.fn();
    for (const claim of [{...f.claim, owner: "replacement"}, {...f.claim, attempt: 2}, {...f.claim, meetingId: "another"}]) {
      await expect(withMeetingTranscriptWorker({...claim, claim: registerClaimedMeetingTranscriptWorkflow({...f.job, lockedBy: f.job.lockedBy!, lockedAt: f.job.lockedAt!})}, work)).rejects.toMatchObject({code: "MEETING_WORKFLOW_JOB_LOST"});
    }
    for (const data of [{lockedAt: new Date(Date.now() - 6 * 60_000)}, {status: "COMPLETED" as const},
      {type: "agent.inbox-triage"}, {payload: {meetingId: "different"}}]) {
      await prisma.workflowJob.update({where: {id: f.job.id}, data: {status: "RUNNING", lockedAt: new Date(), type: f.job.type, payload: f.job.payload!, ...data}});
      await expect(withMeetingTranscriptWorker({...f.claim, claim: registerClaimedMeetingTranscriptWorkflow({...f.job, lockedBy: f.job.lockedBy!, lockedAt: f.job.lockedAt!})}, work)).rejects.toMatchObject({code: "MEETING_WORKFLOW_JOB_LOST"});
    }
    expect(work).not.toHaveBeenCalled();
  });
  it("rolls back final writes after replacement and denies changes to pinned transcript or full payload", async () => {
    const f = await fixture();
    await withMeetingTranscriptWorker(f.claim, async actor => {
      await prisma.workflowJob.update({where: {id: f.job.id}, data: {payload: {meetingId: f.meeting.id, changed: true}}});
      expect(await isMeetingTranscriptWorkerCurrent(actor, f.workspace.id, {meetingId: f.meeting.id})).toBe(false);
      await prisma.workflowJob.update({where: {id: f.job.id}, data: {payload: f.job.payload!, attempts: 2, lockedBy: "replacement"}});
      await expect(prisma.$transaction(async tx => {
        await tx.meeting.update({where: {id: f.meeting.id}, data: {summaryMd: "Must roll back"}});
        await assertMeetingTranscriptWorkerCurrent(actor, f.workspace.id, tx);
      })).rejects.toMatchObject({code: "MEETING_WORKFLOW_JOB_LOST"});
      expect((await prisma.meeting.findUniqueOrThrow({where: {id: f.meeting.id}})).summaryMd).toBeNull();
    });
    const g = await fixture();
    await withMeetingTranscriptWorker(g.claim, async actor => {
      await prisma.meeting.update({where: {id: g.meeting.id}, data: {transcript: "Changed selected native bytes"}});
      expect(await isMeetingTranscriptWorkerCurrent(actor, g.workspace.id, {meetingId: g.meeting.id})).toBe(false);
    });
  });
  it("holds the real job through a final transaction and protects progress from a replacement owner", async () => {
    const f = await fixture();
    await withMeetingTranscriptWorker(f.claim, async actor => {
      await markMeetingTranscriptProcessingStage({workerActor: actor, workspaceId: f.workspace.id,
        meetingId: f.meeting.id, workflowJobId: f.job.id, workflowJobType: f.job.type, stage: "SUMMARIZING", status: "ACTIVE"});
      const progress = await prisma.meetingTranscriptProcessingProgress.findUniqueOrThrow({where: {meetingId: f.meeting.id}});
      let release!: () => void;
      const gate = new Promise<void>(resolve => {release = resolve;});
      let locked!: () => void;
      const ready = new Promise<void>(resolve => {locked = resolve;});
      const reader = prisma.$transaction(async tx => {
        await assertMeetingTranscriptWorkerCurrent(actor, f.workspace.id, tx);
        locked();
        await gate;
      });
      await ready;
      let replaced = false;
      const writer = prisma.workflowJob.update({where: {id: f.job.id}, data: {lockedBy: "replacement", attempts: 2}})
        .then(row => {replaced = true; return row;});
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(replaced).toBe(false);
      release();
      await reader;
      const replacement = await writer;
      await expect(markMeetingTranscriptProcessingStage({workerActor: actor, workspaceId: f.workspace.id,
        meetingId: f.meeting.id, workflowJobId: f.job.id, workflowJobType: f.job.type, stage: "SUMMARIZING", status: "COMPLETED"}))
        .rejects.toMatchObject({code: "MEETING_WORKFLOW_JOB_LOST"});
      expect(await prisma.meetingTranscriptProcessingProgress.findUniqueOrThrow({where: {meetingId: f.meeting.id}})).toEqual(progress);
      expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}})).toEqual(replacement);
    });
  });
  it("renews only a still-live exact claim and invalidates purpose after failed renewal", async () => {
    const f = await fixture();
    vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
    await withMeetingTranscriptWorker(f.claim, async actor => {
      const old = new Date(Date.now() - 60_000);
      await prisma.workflowJob.update({where: {id: f.job.id}, data: {lockedAt: old}});
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(async () => expect((await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}})).lockedAt!.getTime()).toBeGreaterThan(old.getTime()));
      const expired = await prisma.workflowJob.update({where: {id: f.job.id}, data: {lockedAt: new Date(Date.now() - 6 * 60_000)}});
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(getMeetingTranscriptWorkerPurpose(actor, f.workspace.id)).toBeNull());
      expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}})).toEqual(expired);
      await expect(assertMeetingTranscriptWorkerCurrent(actor, f.workspace.id)).rejects.toMatchObject({code: "MEETING_WORKFLOW_JOB_LOST"});
    });
  });
});
