import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { assertBrainSourceRecoveryJob, brainSourceRecoveryIdentity, listBrainSourceRecovery, reconcileBrainSource } from "./brain-source-recovery";

const { executeAgain, absorbAgain } = vi.hoisted(() => ({ executeAgain: vi.fn(), absorbAgain: vi.fn() }));
vi.mock("@corgtex/agents", () => ({ executeAgentRun: executeAgain, absorbSource: absorbAgain }));

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic recovery", slug: `recovery-${randomUUID()}` } });
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Synthetic local recovery fixture" } });
  const actor: AppActor = { kind: "agent", authProvider: "credential", label: "Corgtex Support", workspaceIds: [workspace.id], scopes: ["support:write", "brain:read", "runtime:read", "runtime:write"] };
  const params = { workspaceId: workspace.id, sourceId: source.id, expectedSourceIdentity: brainSourceRecoveryIdentity(source), reason: "Synthetic integration test" };
  return { workspace, source, actor, params };
}

describe("source recovery database admission", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
  });

  it("serializes concurrent requests into one job and one atomic support audit", async () => {
    const { source, actor, params } = await fixture();
    const event = await prisma.event.create({ data: { workspaceId: source.workspaceId, aggregateId: source.id, aggregateType: "BrainSource", type: "brain-source.created", status: "DISPATCHED", payload: { sourceId: source.id } } });
    const results = await Promise.all([reconcileBrainSource(actor, params), reconcileBrainSource(actor, params)]);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await prisma.workflowJob.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "brain-source.reconciled" } })).toBe(1);
    const job = await prisma.workflowJob.findFirstOrThrow();
    expect(job).toMatchObject({ eventId: event.id, dedupeKey: `${event.id}:brain-absorb`, type: "agent.brain-absorb" });
    expect(await prisma.event.count()).toBe(1);
    expect(await prisma.event.findUnique({ where: { id: event.id } })).toMatchObject({ status: "DISPATCHED" });
    await expect(assertBrainSourceRecoveryJob({ ...params, workflowJobId: job.id })).resolves.toBeUndefined();
  });

  it("admits at most one of two different sources in the same quiet workspace", async () => {
    const { source, actor, params } = await fixture();
    const second = await prisma.brainSource.create({ data: { workspaceId: source.workspaceId, sourceType: "DOC", tier: 1, content: "Second synthetic fixture" } });
    const results = await Promise.allSettled([reconcileBrainSource(actor, params), reconcileBrainSource(actor, { ...params, sourceId: second.id, expectedSourceIdentity: brainSourceRecoveryIdentity(second) })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.workflowJob.count()).toBe(1);
    expect(await prisma.event.count()).toBe(0);
  });

  it("prevents cross-tenant access and processing Finance sources", async () => {
    const first = await fixture();
    const other = await fixture();
    await expect(reconcileBrainSource(first.actor, other.params)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await prisma.brainSource.update({ where: { id: first.source.id }, data: { accessDomain: "FINANCE" } });
    expect((await listBrainSourceRecovery(first.actor, { workspaceId: first.workspace.id })).items).toHaveLength(0);
    await expect(reconcileBrainSource(first.actor, first.params)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.workflowJob.count()).toBe(0);
  });

  it("blocks a mismatched source event payload and a new outbound subscription at execution", async () => {
    const { source, actor, params } = await fixture();
    const event = await prisma.event.create({ data: { workspaceId: source.workspaceId, aggregateId: "mismatched", aggregateType: "BrainSource", type: "brain-source.created", status: "PENDING", payload: { sourceId: source.id } } });
    await expect(reconcileBrainSource(actor, params)).rejects.toMatchObject({ code: "RECOVERY_NOT_ELIGIBLE" });
    await prisma.event.update({ where: { id: event.id }, data: { aggregateId: source.id, status: "DISPATCHED" } });
    const job = await reconcileBrainSource(actor, params);
    await prisma.webhookEndpoint.create({ data: { workspaceId: source.workspaceId, url: "https://example.test/synthetic", secret: "synthetic-only", eventTypes: [] } });
    await expect(assertBrainSourceRecoveryJob({ ...params, workflowJobId: job.id })).rejects.toMatchObject({ code: "RECOVERY_NOT_ELIGIBLE" });
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it("rejects worker admission if the stored source changes after enqueue", async () => {
    const { source, actor, params } = await fixture();
    const job = await reconcileBrainSource(actor, params);
    await prisma.brainSource.update({ where: { id: source.id }, data: { content: "Changed synthetic fixture" } });
    await expect(assertBrainSourceRecoveryJob({ ...params, workflowJobId: job.id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.agentRun.count()).toBe(0);
    expect(await prisma.modelUsage.count()).toBe(0);
  });

  it.each(["RUNNING", "FAILED", "COMPLETED"] as const)("blocks a %s prior attempt whose only durable source link is its plan", async (status) => {
    const { source, actor, params } = await fixture();
    await prisma.agentRun.create({ data: {
      workspaceId: source.workspaceId, agentKey: "brain-absorb", triggerType: "EVENT",
      status, goal: "Synthetic interrupted attempt", planJson: { payload: { sourceId: source.id } },
    } });
    expect(await prisma.workflowJob.count()).toBe(0);
    expect(await prisma.agentStep.count()).toBe(0);
    expect(await prisma.agentToolCall.count()).toBe(0);
    expect((await listBrainSourceRecovery(actor, { workspaceId: source.workspaceId })).items[0]).toMatchObject({ priorRunCount: 1, blockReason: "existing_counterpart" });
    await expect(reconcileBrainSource(actor, params)).rejects.toMatchObject({ code: "RECOVERY_NOT_ELIGIBLE" });
    expect(await prisma.workflowJob.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "brain-source.reconciled" } })).toBe(0);
  });

  it("rejects a plan-only attempt appearing after admission and ignores other-tenant plans", async () => {
    const { source, actor, params } = await fixture();
    const other = await fixture();
    await prisma.agentRun.create({ data: {
      workspaceId: other.workspace.id, agentKey: "brain-absorb", triggerType: "EVENT", status: "RUNNING",
      goal: "Synthetic unrelated tenant", planJson: { payload: { sourceId: source.id } },
    } });
    const job = await reconcileBrainSource(actor, params);
    await expect(assertBrainSourceRecoveryJob({ ...params, workflowJobId: job.id })).resolves.toBeUndefined();
    await prisma.agentRun.create({ data: {
      workspaceId: source.workspaceId, agentKey: "brain-absorb", triggerType: "EVENT", status: "RUNNING",
      goal: "Synthetic interrupted attempt", planJson: { payload: { sourceId: source.id } },
    } });
    await expect(assertBrainSourceRecoveryJob({ ...params, workflowJobId: job.id })).rejects.toMatchObject({ code: "RECOVERY_NOT_ELIGIBLE" });
    expect(await prisma.agentStep.count()).toBe(0);
    expect(await prisma.agentToolCall.count()).toBe(0);
    expect(await prisma.modelUsage.count()).toBe(0);
  });

  it("acknowledges redelivery after a committed own run without repeating processing or output", async () => {
    const { runAgentWorkflowJob } = await import("../../workflows/src/handlers/agent-dispatch");
    const { source, actor, params } = await fixture();
    const admitted = await reconcileBrainSource(actor, params);
    const run = await prisma.$transaction(async (tx) => {
      await tx.brainSource.update({ where: { id: source.id }, data: { absorbedAt: new Date() } });
      await tx.brainArticle.create({ data: { workspaceId: source.workspaceId, slug: "synthetic-completed", title: "Synthetic completed output", type: "PROJECT", bodyMd: "Synthetic test output", sourceIds: [source.id] } });
      return tx.agentRun.create({ data: {
        workspaceId: source.workspaceId, agentKey: "brain-absorb", triggerType: "EVENT", triggerRef: admitted.id,
        status: "COMPLETED", goal: "Synthetic completed recovery", completedAt: new Date(),
        planJson: { payload: { sourceId: source.id } }, resultJson: { absorbed: true, sourceId: source.id },
      } });
    });
    // Model the lost completeJob acknowledgement: only the job remains retryable.
    const job = await prisma.workflowJob.update({ where: { id: admitted.id }, data: { status: "PENDING", attempts: 1 } });
    const receipt = { alreadyCompleted: true, agentRunId: run.id, workflowJobId: job.id, sourceId: source.id };
    await expect(runAgentWorkflowJob(job)).resolves.toEqual(receipt);
    await expect(runAgentWorkflowJob(job)).resolves.toEqual(receipt);
    expect(executeAgain).not.toHaveBeenCalled();
    expect(absorbAgain).not.toHaveBeenCalled();
    expect(await prisma.agentRun.count()).toBe(1);
    expect(await prisma.brainArticle.count()).toBe(1);
    expect(await prisma.workflowJob.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(1);
    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.modelUsage.count()).toBe(0);
    expect(await prisma.workflowJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: "PENDING", attempts: 1 });
  });

  it.each(["other_tenant", "other_job", "other_agent", "other_trigger", "other_source", "skipped", "failed", "running", "ambiguous"])("does not acknowledge %s completion evidence", async (mismatch) => {
    const { source, actor, params } = await fixture();
    const admitted = await reconcileBrainSource(actor, params);
    const other = await fixture();
    await prisma.brainSource.update({ where: { id: source.id }, data: { absorbedAt: new Date() } });
    const data = {
      workspaceId: mismatch === "other_tenant" ? other.workspace.id : source.workspaceId,
      agentKey: mismatch === "other_agent" ? "company-understanding" : "brain-absorb",
      triggerType: mismatch === "other_trigger" ? "MANUAL" as const : "EVENT" as const,
      triggerRef: mismatch === "other_job" ? randomUUID() : admitted.id,
      status: mismatch === "failed" ? "FAILED" as const : mismatch === "running" ? "RUNNING" as const : "COMPLETED" as const,
      goal: "Synthetic mismatched completion", planJson: { payload: { sourceId: source.id } },
      resultJson: mismatch === "skipped" ? { skipped: true } : { absorbed: true, sourceId: mismatch === "other_source" ? other.source.id : source.id },
    };
    await prisma.agentRun.create({ data });
    if (mismatch === "ambiguous") await prisma.agentRun.create({ data });
    await expect(assertBrainSourceRecoveryJob({ ...params, workflowJobId: admitted.id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.modelUsage.count()).toBe(0);
    expect(await prisma.brainArticle.count()).toBe(0);
  });
});
