import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { createMeeting, readableArtifactIds } from "@corgtex/domain";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { dispatchPendingEvents, runPendingJobs } from "./outbox";
import { runAgentWorkflowJob } from "./handlers/agent-dispatch";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture(externalParticipant = false, source: "original" | "company" | "provider" = "original") {
  const workspace = await prisma.workspace.create({data: {slug: randomUUID(), name: "Synthetic Meeting workflow", plan: "PAYG_AI"}});
  const users = await Promise.all(["owner", "reader"].map(name => prisma.user.create({data: {email: `${name}-${randomUUID()}@example.test`, passwordHash: "synthetic"}})));
  await prisma.member.createMany({data: users.map(user => ({workspaceId: workspace.id, userId: user.id, role: "ADMIN"}))});
  const owner: AppActor = {kind: "user", user: users[0]}, reader: AppActor = {kind: "user", user: users[1]};
  let meeting;
  if (source === "provider") {
    const { processMeetingTranscriptSourceWebhook } = await import("../../domain/src/meeting-transcript-sources");
    await prisma.workspaceFeatureFlag.create({ data: { workspaceId: workspace.id, flag: "MEETING_TRANSCRIPT_SOURCES", enabled: true } });
    const secret = "synthetic-workflow-provider-secret";
    await prisma.meetingTranscriptSourceConnection.create({ data: { workspaceId: workspace.id, provider: "FIREFLIES",
      status: "ACTIVE", authMode: "API_KEY", webhookSecretEnc: encryptSecret(secret) } });
    for (const [revision, transcript] of [["13", "Jan: We should prepare the proposal."], ["14", "Jan: I will prepare the proposal by Friday."]]) {
      const rawBody = JSON.stringify({ id: "workflow-provider-original", title: "Provider workflow", date: "2026-10-14T12:00:00Z",
        updated_at: `2026-10-14T${revision}:00:00Z`, transcript_text: transcript });
      const result = await processMeetingTranscriptSourceWebhook({ workspaceId: workspace.id, provider: "FIREFLIES", rawBody,
        headers: { "x-fireflies-signature": createHmac("sha256", secret).update(rawBody).digest("hex") } });
      expect("batch" in result && result.batch.importedCount).toBe(1);
    }
    meeting = await prisma.meeting.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    expect(await prisma.nativeTranscriptInput.count({ where: { workspaceId: workspace.id, mode: "PROVIDER_IMPORT" } })).toBe(2);
  } else if (source === "company") {
    const { captureCompanyMemberTranscriptInput } = await import("../../domain/src/native-transcript-input");
    const { intakeMeetingTranscript } = await import("../../domain/src/meeting-transcript-intake");
    const submission = { workspaceId: workspace.id, title: "Synthetic company original",
      transcript: "Jan: I will prepare the proposal by Friday.", recordedAt: "2026-10-14T12:00:00Z", createNewMeeting: true };
    const nativeReceipt = await captureCompanyMemberTranscriptInput(owner, { workspaceId: workspace.id, submission });
    const result = await intakeMeetingTranscript(owner, { ...submission, nativeReceipt });
    expect(result.status).toBe("meeting_created");
    if (result.status === "needs_clarification") throw new Error("Unexpected company clarification");
    meeting = result.meeting;
  } else {
    meeting = await createMeeting(owner, {workspaceId: workspace.id, title: "Synthetic original",
    transcript: "Jan: I will prepare the proposal by Friday.", recordedAt: new Date(), source: "WEB_REQUEST",
    participantEmails: externalParticipant ? ["client@synthetic-business.example"] : []});
  }
  const event = await prisma.event.findFirstOrThrow({where: {workspaceId: workspace.id, type: "meeting.created", aggregateId: meeting.id}});
  await prisma.event.updateMany({where: {workspaceId: workspace.id, id: {not: event.id}}, data: {availableAt: new Date("2099-01-01")}});
  expect(await dispatchPendingEvents("meeting-worker")).toBe(1);
  const types = ["agent.meeting-summary", "meeting.insights.extract", "agent.action-extraction"];
  await prisma.workflowJob.updateMany({where: {workspaceId: workspace.id, type: {notIn: types}}, data: {runAfter: new Date("2099-01-01")}});
  const jobs = await prisma.workflowJob.findMany({where: {workspaceId: workspace.id, type: {in: types}}, orderBy: {createdAt: "asc"}});
  expect(jobs).toHaveLength(3);
  const extract = vi.spyOn(defaultModelGateway, "extract").mockResolvedValue({output: {
    version: 1, blocks: [{sequence: 1, title: "Proposal", kind: "update", summaryMd: "Jan will prepare the proposal by Friday.", sourceQuote: "I will prepare the proposal by Friday."}],
    insights: [{type: "ACTION_ITEM", title: "Prepare the proposal", body: "Jan will prepare the proposal by Friday.", confidence: 0.5, sourceQuote: "I will prepare the proposal by Friday."}],
  }} as never);
  const chat = vi.spyOn(defaultModelGateway, "chat").mockResolvedValue({content: "Jan will prepare the proposal by Friday."} as never);
  const embed = vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({input}) => ({embeddings: (Array.isArray(input) ? input : [input]).map(() => Array(1536).fill(0.01)),
    usage: {provider: "fixture", model: "fixture-embed", inputTokens: 1, outputTokens: 0, latencyMs: 0, estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0"}}));
  return {workspace, owner, reader, meeting, jobs, extract, chat, embed};
}
it.each(["original", "company", "provider"] as const)("runs the three actual claimed jobs and serves stored outputs after scope cleanup (%s)", async source => {
  const f = await fixture(false, source);
  const timezone = await prisma.$queryRaw<Array<{TimeZone: string}>>`SHOW TimeZone`;
  console.info("Meeting workflow database timezone:", timezone[0].TimeZone);
  for (let index = 0; index < 3; index++) {
    expect(await runPendingJobs("meeting-worker")).toBe(1);
    const jobs = await prisma.workflowJob.findMany({where: {id: {in: f.jobs.map(job => job.id)}}});
    expect(jobs.filter(job => job.status === "COMPLETED")).toHaveLength(index + 1);
    expect(jobs.every(job => job.error === null)).toBe(true);
  }
  expect(f.extract).toHaveBeenCalled();
  expect(f.chat).toHaveBeenCalled();
  const meeting = await prisma.meeting.findUniqueOrThrow({where: {id: f.meeting.id}});
  expect(meeting.summaryMd).toBe("Jan will prepare the proposal by Friday.");
  expect(meeting.aiProcessedAt).not.toBeNull();
  expect(await readableArtifactIds(f.reader, f.workspace.id, "Meeting", [meeting])).toEqual(new Set([meeting.id]));
  const insights = await prisma.meetingInsight.findMany({where: {meetingId: meeting.id}});
  expect(insights.length).toBeGreaterThan(0);
  expect(await readableArtifactIds(f.reader, f.workspace.id, "MeetingInsight", insights)).toEqual(new Set(insights.map(row => row.id)));
  const review = await prisma.agentRun.findFirstOrThrow({where: {workspaceId: f.workspace.id, agentKey: "action-extraction"}});
  expect(review.resultJson).toMatchObject({meetingId: meeting.id, reviewRequired: true, suggested: insights.length});
  expect(await readableArtifactIds(f.reader, f.workspace.id, "AgentRun", [review])).toEqual(new Set([review.id]));
  // This lane deliberately leaves reviewable insights for a person; it never auto-creates Actions.
  expect(await prisma.action.count({where: {workspaceId: f.workspace.id}})).toBe(0);
}, 120_000);

it("cannot mint a purpose from copied current claim fields or a direct dispatcher call", async () => {
  const f = await fixture();
  const job = await prisma.workflowJob.update({where: {id: f.jobs.find(job => job.type === "agent.meeting-summary")!.id},
    data: {status: "RUNNING", attempts: 1, lockedBy: "meeting-worker", lockedAt: new Date()}});
  await expect(runAgentWorkflowJob(job, "meeting-worker")).rejects.toMatchObject({code: "MEETING_WORKFLOW_JOB_LOST"});
  await expect(runAgentWorkflowJob(job, "meeting-worker", {kind: "agent", authProvider: "bootstrap",
    workspaceIds: [f.workspace.id], label: "meeting-transcript-workflow"})).rejects.toMatchObject({code: "MEETING_WORKFLOW_JOB_LOST"});
  expect(f.extract).not.toHaveBeenCalled();
  expect(f.chat).not.toHaveBeenCalled();
  expect(await runPendingJobs("another-worker")).toBe(0);
  expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: job.id}})).toEqual(job);
}, 120_000);

it("preserves replacement job and progress when a real model call outlives its claim", async () => {
  const f = await fixture();
  const job = f.jobs.find(job => job.type === "agent.meeting-summary")!;
  let replacement: unknown, progress: unknown;
  f.chat.mockImplementation(async () => {
    replacement = await prisma.workflowJob.update({where: {id: job.id}, data: {attempts: 2, lockedBy: "replacement-worker", lockedAt: new Date(), error: "replacement-marker"}});
    progress = await prisma.meetingTranscriptProcessingProgress.findUniqueOrThrow({where: {meetingId: f.meeting.id}});
    return {content: "An obsolete summary"} as never;
  });
  expect(await runPendingJobs("meeting-worker")).toBe(1);
  expect(f.chat).toHaveBeenCalled();
  expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: job.id}})).toEqual(replacement);
  expect(await prisma.meetingTranscriptProcessingProgress.findUniqueOrThrow({where: {meetingId: f.meeting.id}})).toEqual(progress);
  expect((await prisma.meeting.findUniqueOrThrow({where: {id: f.meeting.id}})).summaryMd).toBeNull();
}, 120_000);

it.each(["meeting.created", "meeting.transcript-uploaded"])("respects future eligibility and current versus expired UTC event leases for %s", async type => {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic event clock", slug: randomUUID()}});
  const event = await prisma.event.create({data: {workspaceId: workspace.id, type, aggregateType: "Meeting", aggregateId: "synthetic-clock-only",
    payload: {}, availableAt: new Date(Date.now() + 60_000)}});
  await prisma.event.updateMany({where: {workspaceId: workspace.id, id: {not: event.id}}, data: {availableAt: new Date("2099-01-01")}});
  expect(await dispatchPendingEvents("clock-worker")).toBe(0);
  const active = await prisma.event.update({where: {id: event.id}, data: {availableAt: new Date(), lockedBy: "active-worker", lockedAt: new Date()}});
  expect(await dispatchPendingEvents("clock-worker")).toBe(0);
  expect(await prisma.event.findUniqueOrThrow({where: {id: event.id}})).toEqual(active);
  await prisma.event.update({where: {id: event.id}, data: {lockedAt: new Date(Date.now() - 6 * 60_000)}});
  expect(await dispatchPendingEvents("clock-worker")).toBe(1);
  expect(await prisma.event.findUniqueOrThrow({where: {id: event.id}})).toMatchObject({status: "DISPATCHED", lockedBy: null, lockedAt: null});
});

it("rejects a reclaimed extraction before its separate CRM suggestion transaction", async () => {
  const f = await fixture(true);
  expect(await runPendingJobs("meeting-worker")).toBe(1);
  const job = f.jobs.find(job => job.type === "meeting.insights.extract")!;
  let replacement: unknown, progress: unknown;
  const find = prisma.meeting.findFirst.bind(prisma.meeting);
  // This boundary consumes only the awaited result; the underlying read remains real PostgreSQL.
  vi.spyOn(prisma.meeting, "findFirst").mockImplementation((async args => {
    const row = await find(args);
    if (!replacement && row && "id" in row && "aiProcessedAt" in row
      && row.id === f.meeting.id && row.aiProcessedAt) {
      replacement = await prisma.workflowJob.update({where: {id: job.id}, data: {attempts: 2, lockedBy: "replacement-worker", lockedAt: new Date(), error: "replacement-marker"}});
      progress = await prisma.meetingTranscriptProcessingProgress.findUniqueOrThrow({where: {meetingId: f.meeting.id}});
    }
    return row;
  }) as typeof prisma.meeting.findFirst);
  expect(await runPendingJobs("meeting-worker")).toBe(1);
  expect(replacement).toBeDefined();
  expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: job.id}})).toEqual(replacement);
  expect(await prisma.meetingTranscriptProcessingProgress.findUniqueOrThrow({where: {meetingId: f.meeting.id}})).toEqual(progress);
  expect(await prisma.meetingInsight.count({where: {meetingId: f.meeting.id, type: "CRM_CONTACT"}})).toBe(0);
  expect(await prisma.meetingInsight.count({where: {meetingId: f.meeting.id, type: "ACTION_ITEM"}})).toBeGreaterThan(0);
}, 120_000);

it("withholds summary publication after category restriction and restoration during the model call", async () => {
  const f = await fixture();
  f.chat.mockImplementation(async () => {
    const policy = await prisma.informationCategoryPolicy.create({data: {workspaceId: f.workspace.id, category: "GENERAL", isRestricted: true}});
    await prisma.informationCategoryPolicy.delete({where: {id: policy.id}});
    return {content: "Must not revive original permission"} as never;
  });
  expect(await runPendingJobs("meeting-worker")).toBe(1);
  expect(f.chat).toHaveBeenCalled();
  expect((await prisma.meeting.findUniqueOrThrow({where: {id: f.meeting.id}})).summaryMd).toBeNull();
  expect(await prisma.meetingInsight.count({where: {meetingId: f.meeting.id}})).toBe(0);
  expect((await prisma.workflowJob.findUniqueOrThrow({where: {id: f.jobs.find(job => job.type === "agent.meeting-summary")!.id}})).status).not.toBe("COMPLETED");
}, 120_000);
