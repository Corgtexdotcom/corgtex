import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputSnapshotProof, captureArtifactInputProof, isArtifactInputProofReadable, readableArtifactIds, recordArtifactInputLineage,
  uploadMeetingTranscript, captureDirectMemberTranscriptInput, directMemberTranscriptRoots, loadAgentRequestInput, loadAgentFeedbackContinuation, triggerAgentRun, submitAgentFeedback, meetingTranscriptInputProjection, type LineageRoot } from "@corgtex/domain";
import { executeAgentRun } from "./runtime";

// Only operational model routing and budget decisions are stubbed. Real rows,
// manifests, snapshots, membership checks and input loaders are used throughout.
vi.mock("@corgtex/domain", async importOriginal => ({ ...await importOriginal<any>(),
  isAgentEnabled: vi.fn(async () => true), getAgentModelOverride: vi.fn(async () => undefined),
  resolveAgentIdentityLimits: vi.fn(async () => null), checkBudget: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@corgtex/models", () => ({ resolveModel: () => "synthetic-model" }));

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic runtime", slug: `runtime-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `runtime-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const submission = { workspaceId: workspace.id, title: "Synthetic meeting", source: "synthetic",
    recordedAt: new Date(), transcript: "Native transcript fact", participantIds: [] };
  const nativeReceipt = await captureDirectMemberTranscriptInput(actor, {workspaceId: workspace.id, submission});
  const nativeRoots = await directMemberTranscriptRoots(actor, workspace.id, submission, nativeReceipt);
  const uploaded = await uploadMeetingTranscript(actor, {...submission, copied: true, lineageRoots: nativeRoots});
  if (!uploaded.meeting) throw new Error("Synthetic native transcript upload needs a new meeting.");
  const meeting = uploaded.meeting;
  const identity = await prisma.agentIdentity.create({ data: { workspaceId: workspace.id, agentKey: "__workspace__", isActive: false,
    displayName: "Workspace policy", behaviorMd: "Explain the evidence clearly." } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "AgentIdentity", id: identity.id }, content: identity, origin: "HUMAN_ORIGINAL", inputs: [] }));
  return { workspace, user, member, actor, meeting, identity };
}

async function provenRun(f: Awaited<ReturnType<typeof fixture>>, approval = false) {
  const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "Workspace", id: f.workspace.id }]);
  return executeAgentRun({ workspaceId: f.workspace.id, agentKey: "proposal-drafting", triggerType: "MANUAL", triggerRef: randomUUID(),
    goal: "Synthetic analysis", payload: { meetingId: f.meeting.id }, plan: ["read", "analyze"], lineageActor: f.actor, lineageRoots: roots,
    contextIsAuditedRead: true, contextLineageRoots: context => context.roots as LineageRoot[],
    buildContext: helpers => helpers.tool("meeting.read", {}, async () => ({ text: f.meeting.transcript,
      roots: await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "MeetingTranscript", id: f.meeting.id, snapshot: meetingTranscriptInputProjection(f.meeting) }]) }),
    { receipt: helpers.plannedInputReceipt, auditedRead: true }),
    execute: async (context, helpers) => {
      const receipt = await helpers.captureInputs([...roots, ...(context.roots as LineageRoot[]), ...helpers.behaviorLineageRoots]);
      const text = await helpers.tool("synthetic.model", {}, async () => `${context.text}: ${helpers.behaviorContext}`, { receipt });
      return { lineageReceipt: receipt, resultJson: { prompt: "Synthetic request", proposalDraft: { title: text } },
        ...(approval ? { approvalCheckpoint: { summary: "Review this draft", detail: { title: text } } } : {}) };
    },
  });
}

describe("runtime input receipts with real persistence", () => {
  beforeEach(async () => { await truncateAllTables(); });

  it("snapshots native Workspace and MeetingTranscript plus proven inactive workspace policy; revocation hides every log", async () => {
    const f = await fixture();
    const result = await provenRun(f);
    expect(result).toMatchObject({ status: "COMPLETED" });
    const run = await prisma.agentRun.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    const steps = await prisma.agentStep.findMany({ where: { agentRunId: run.id } });
    const calls = await prisma.agentToolCall.findMany({ where: { agentRunId: run.id } });
    expect(await readableArtifactIds(f.actor, f.workspace.id, "AgentRun", [run])).toEqual(new Set([run.id]));
    expect(await readableArtifactIds(f.actor, f.workspace.id, "AgentStep", steps)).toEqual(new Set(steps.map(row => row.id)));
    expect(await readableArtifactIds(f.actor, f.workspace.id, "AgentToolCall", calls)).toEqual(new Set(calls.map(row => row.id)));
    const snapshots = await prisma.artifactInputSnapshot.findMany({ where: { workspaceId: f.workspace.id } });
    expect(snapshots.map(row => row.sourceKind)).toEqual(expect.arrayContaining(["Workspace", "MeetingTranscript", "AgentIdentity"]));
    expect(JSON.stringify(run.resultJson)).toContain("Explain the evidence clearly");
    await prisma.meeting.update({ where: { id: f.meeting.id }, data: { archivedAt: new Date() } });
    expect(await readableArtifactIds(f.actor, f.workspace.id, "AgentRun", [run])).toEqual(new Set());
    expect(await readableArtifactIds(f.actor, f.workspace.id, "AgentToolCall", calls)).toEqual(new Set());
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).resultJson).toEqual(run.resultJson);
  });

  it("mints private authored requests and refuses replay after membership revocation", async () => {
    const f = await fixture();
    const job = await triggerAgentRun(f.actor, { workspaceId: f.workspace.id, agentKey: "proposal-drafting", prompt: "Exact human guidance", meetingId: f.meeting.id });
    const stored = await prisma.workflowJob.findUniqueOrThrow({ where: { id: job.id } });
    const payload = stored.payload as { requestInputId: string };
    expect(stored.payload).not.toHaveProperty("prompt");
    const input = await loadAgentRequestInput({ workspaceId: f.workspace.id, agentKey: "proposal-drafting", requestInputId: payload.requestInputId });
    expect(input.prompt).toBe("Exact human guidance");
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, input.lineageRoots)).toBe(true);
    await expect(loadAgentRequestInput({ workspaceId: f.workspace.id, agentKey: "constitution-update-trigger", requestInputId: payload.requestInputId })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
    await expect(loadAgentRequestInput({ workspaceId: f.workspace.id, agentKey: "proposal-drafting", requestInputId: payload.requestInputId })).rejects.toMatchObject({ status: 403 });
  });

  it("atomically preserves prior advice, captures new feedback, and rejects stale or revoked continuation", async () => {
    const f = await fixture();
    await provenRun(f, true);
    const run = await prisma.agentRun.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    const step = await prisma.agentStep.findFirstOrThrow({ where: { agentRunId: run.id, name: "approval-checkpoint" } });
    const alternativeRoots = await prisma.$transaction(tx => captureArtifactInputSnapshotProof(f.actor, f.workspace.id, { kind: "AgentRun", id: run.id }, tx));
    const alternativeSnapshotId = alternativeRoots.find(root => root.kind === "ArtifactInputSnapshot")!.id;
    const submitted = await submitAgentFeedback(f.actor, { workspaceId: f.workspace.id, agentRunId: run.id, stepId: step.id, feedback: "Clarify the original evidence" });
    const job = await prisma.workflowJob.findUniqueOrThrow({ where: { id: submitted.continuationJobId } });
    const payload = job.payload as { feedbackInputId: string; priorRunSnapshotId: string };
    const feedbackInput = await prisma.agentFeedbackInput.findUniqueOrThrow({ where: { id: payload.feedbackInputId } });
    expect(feedbackInput.priorRunSnapshotId).toBe(payload.priorRunSnapshotId);
    expect(alternativeSnapshotId).not.toBe(payload.priorRunSnapshotId);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, alternativeRoots)).toBe(true);
    // Another valid snapshot of the very same run is still not the draft this reply bound to.
    await expect(loadAgentFeedbackContinuation({ workspaceId: f.workspace.id, agentKey: "proposal-drafting", ...payload,
      priorRunSnapshotId: alternativeSnapshotId })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    const legacyFeedback = await prisma.agentFeedbackInput.create({ data: { workspaceId: f.workspace.id, agentRunId: run.id,
      stepId: step.id, userId: f.user.id, content: "Legacy unbound feedback" } });
    await expect(loadAgentFeedbackContinuation({ workspaceId: f.workspace.id, agentKey: "proposal-drafting", ...payload,
      feedbackInputId: legacyFeedback.id })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(job.payload).not.toHaveProperty("previousAdvice");
    expect(job.payload).not.toHaveProperty("reviewFeedback");
    const continuation = await loadAgentFeedbackContinuation({ workspaceId: f.workspace.id, agentKey: "proposal-drafting", ...payload });
    expect(continuation.prompt).toBe("Synthetic request");
    expect(continuation.reviewFeedback).toBe("Clarify the original evidence");
    expect(continuation.previousAdvice).toContain("Native transcript fact");
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, continuation.lineageRoots)).toBe(true);
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.resultJson).toEqual(run.resultJson);
    const stepAfter = await prisma.agentStep.findUniqueOrThrow({ where: { id: step.id } });
    expect(await readableArtifactIds(f.actor, f.workspace.id, "AgentStep", [stepAfter])).toEqual(new Set([step.id]));
    await expect(submitAgentFeedback(f.actor, { workspaceId: f.workspace.id, agentRunId: run.id, stepId: step.id, feedback: "Stale reply" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const other = await prisma.workspace.create({ data: { name: "Other scope", slug: `other-${randomUUID()}` } });
    await expect(loadAgentFeedbackContinuation({ workspaceId: other.id, agentKey: "proposal-drafting", ...payload })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await prisma.meeting.update({ where: { id: f.meeting.id }, data: { archivedAt: new Date() } });
    await expect(loadAgentFeedbackContinuation({ workspaceId: f.workspace.id, agentKey: "proposal-drafting", ...payload })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect((await prisma.agentStep.findUniqueOrThrow({ where: { id: step.id } })).humanFeedback).toBe("Clarify the original evidence");
  });

  it("retains unknown logs and withholds them rather than certifying generated content", async () => {
    const f = await fixture();
    await executeAgentRun({ workspaceId: f.workspace.id, agentKey: "proposal-drafting", triggerType: "MANUAL", triggerRef: randomUUID(),
      goal: "Unknown legacy prompt", payload: {}, plan: ["legacy"], buildContext: async () => ({ text: "Unproved context" }),
      execute: async (_context, helpers) => ({ resultJson: await helpers.tool("unproved", {}, async () => ({ text: "Unproved result" })) }),
    });
    const run = await prisma.agentRun.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    expect(run.resultJson).toMatchObject({ text: "Unproved result" });
    expect(await readableArtifactIds(f.actor, f.workspace.id, "AgentRun", [run])).toEqual(new Set());
    const manifests = await prisma.artifactInputLineage.findMany({ where: { workspaceId: f.workspace.id, artifactType: "AgentRun" } });
    expect(manifests.every(row => row.origin === "UNKNOWN")).toBe(true);
  });
});
