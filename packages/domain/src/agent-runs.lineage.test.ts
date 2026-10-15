import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";

const { db, membership } = vi.hoisted(() => ({
  membership: vi.fn(),
  db: {
    agentRun: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    agentStep: { findFirst: vi.fn(), updateMany: vi.fn() }, agentToolCall: { findFirst: vi.fn() },
    action: { findFirst: vi.fn() }, modelUsage: { findMany: vi.fn(), findFirst: vi.fn() },
    artifactInputLineage: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    workflowJob: { create: vi.fn() }, auditLog: { findMany: vi.fn() }, event: { findMany: vi.fn() }, $transaction: vi.fn(), $queryRaw: vi.fn(), $executeRaw: vi.fn(),
  },
}));
vi.mock("@corgtex/shared", async importOriginal => ({ ...await importOriginal<any>(), prisma: db }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: membership }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async () => ["WORKSPACE"]) }));
vi.mock("./proposals", () => ({ getProposal: vi.fn() }));
import { listAgentRuns, resolveAgentRun, submitAgentFeedback } from "./agent-runs";
import { getAgentRunTrace, listAuditLogs, getEntityTimeline } from "./audit-trail";
import { lineageContentFingerprint, recordArtifactInputLineage, type LineageKind } from "./source-lineage";

const actor = { kind: "user", user: { id: "owner", email: "owner@example.com", displayName: "Owner", globalRole: "USER" } } as AppActor;
const other = { kind: "user", user: { id: "other", email: "other@example.com", displayName: "Other", globalRole: "USER" } } as AppActor;
const now = new Date("2026-10-12T12:00:00Z");
let runs: any[], steps: any[], calls: any[], sources: any[], manifests: any[];
async function manifest(kind: LineageKind, row: any, roots: any[], origin = "DERIVED") {
  if (origin === "DERIVED" || kind === "Action") return recordArtifactInputLineage({ tx: db as any, actor, workspaceId: row.workspaceId ?? "ws-1",
    artifact: { kind, id: row.id }, content: row, origin: origin as "HUMAN_ORIGINAL" | "DERIVED", inputs: [], inheritedRoots: roots });
  // Deliberately forged generated-original fixture for the rejection regression.
  const value = { workspaceId: row.workspaceId ?? "ws-1", artifactType: kind, artifactId: row.id, revision: 1,
    contentHash: lineageContentFingerprint(kind, row), origin, rootsJson: roots };
  manifests.push(value);
  return value;
}
function root(kind: LineageKind, row: any) { return { kind, id: row.id, fingerprint: lineageContentFingerprint(kind, row) }; }
async function fixture(agentKey = "some-new-agent") {
  const run = { id: "run-1", workspaceId: "ws-1", agentKey, triggerType: "EVENT", triggerRef: "private source identifier",
    status: "FAILED", approvalRequired: false, goal: "Private source goal", planJson: { secret: "private plan" }, contextJson: { secret: "private context" },
    resultJson: { error: "private error" }, startedAt: now, completedAt: null, failedAt: now, createdAt: now, updatedAt: now,
    modelUsage: [{ provider: "openai", model: "test-model", taskType: "CHAT", inputTokens: 20, outputTokens: 5, latencyMs: 30, estimatedCostUsd: "0.5", billableCostUsd: null }] };
  const step = { id: "step-1", agentRunId: run.id, name: "private step name", status: "FAILED", inputJson: { secret: "private step input" }, outputJson: { secret: "private step output" },
    error: "private step error", humanFeedback: "private human feedback", startedAt: now, completedAt: now, createdAt: now };
  const call = { id: "call-1", agentRunId: run.id, name: "private tool name", status: "FAILED", inputJson: { secret: "private tool input" }, outputJson: { secret: "private tool output" },
    error: "private tool error", startedAt: now, completedAt: now, createdAt: now };
  const source = { id: "source-action", workspaceId: run.workspaceId, title: "private input", bodyMd: "private source body", status: "DRAFT", isPrivate: true, authorUserId: "owner", archivedAt: null as Date | null };
  runs = [{ ...run, steps: [step], toolCalls: [call] }]; steps = [step]; calls = [call]; sources = [source];
  await manifest("Action", source, [], "HUMAN_ORIGINAL");
  return { run: runs[0], step, call, source };
}
beforeEach(() => {
  vi.resetAllMocks(); runs = []; steps = []; calls = []; sources = []; manifests = [];
  membership.mockImplementation(async ({ workspaceId }) => {
    if (!["ws-1", "ws-2"].includes(workspaceId)) throw new AppError(403, "NOT_A_MEMBER", "Membership unavailable.");
    return { id: "member-1", role: "MEMBER" };
  });
  const epochs = new Map<string, bigint>();
  db.$executeRaw.mockImplementation(async (query: any) => {
    if (query.sql?.includes('INSERT INTO "SourcePermissionEpoch"')) for (let i = 0; i < query.values.length; i += 4) {
      const [, ws, kind, id] = query.values.slice(i, i + 4); const key = JSON.stringify([ws, kind, id]);
      if (!epochs.has(key)) epochs.set(key, 0n);
    }
    return 1;
  });
  db.$queryRaw.mockImplementation(async (query: any) => {
    const sql = query.sql ?? query.strings?.join("") ?? "";
    if (sql.includes('DISTINCT ON ("artifactId")') && sql.includes('FROM "ArtifactInputLineage"')) {
      const [workspaceId, artifactType, ...ids] = query.values;
      const heads = new Map<string, typeof manifests[number]>();
      for (const row of [...manifests].sort((a, b) => b.revision - a.revision)) {
        if (row.workspaceId === workspaceId && row.artifactType === artifactType && ids.includes(row.artifactId)
          && !heads.has(row.artifactId)) heads.set(row.artifactId, row);
      }
      return [...heads.values()].map(row => structuredClone(row));
    }
    if (!sql.includes('FROM "SourcePermissionEpoch"')) return [];
    const [ws, ...pairs] = query.values; const rows = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const [sourceKind, sourceId] = pairs.slice(i, i + 2); const epoch = epochs.get(JSON.stringify([ws, sourceKind, sourceId]));
      if (epoch !== undefined) rows.push({ sourceKind, sourceId, epoch });
    }
    return rows;
  });
  db.modelUsage.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async cb => cb(db));
  db.agentRun.findMany.mockImplementation(async ({ where, take }) => runs.filter(row => row.workspaceId === where.workspaceId && (!where.status || row.status === where.status)).slice(0, take));
  const runFind = async ({ where }: any) => runs.find(row => row.id === where.id && row.workspaceId === where.workspaceId) ?? null;
  db.agentRun.findFirst.mockImplementation(runFind); db.agentRun.findUnique.mockImplementation(runFind);
  db.agentRun.update.mockImplementation(async ({ where, data }) => Object.assign(await runFind({ where }), data));
  db.agentStep.findFirst.mockImplementation(async ({ where }) => steps.find(row => row.id === where.id && runs.some(run => run.id === row.agentRunId && run.workspaceId === where.agentRun.workspaceId)) ?? null);
  db.agentToolCall.findFirst.mockImplementation(async ({ where }) => calls.find(row => row.id === where.id && runs.some(run => run.id === row.agentRunId && run.workspaceId === where.agentRun.workspaceId)) ?? null);
  db.action.findFirst.mockImplementation(async ({ where }) => sources.find(row => row.id === where.id && row.workspaceId === where.workspaceId) ?? null);
  db.artifactInputLineage.create.mockImplementation(async ({ data }) => { const row = { id: `manifest-${manifests.length}`, ...data }; manifests.push(row); return row; });
  db.artifactInputLineage.findMany.mockImplementation(async ({ where }) => [...manifests].reverse().filter(row => row.workspaceId === where.workspaceId && row.artifactType === where.artifactType && where.artifactId.in.includes(row.artifactId)));
  db.artifactInputLineage.findFirst.mockImplementation(async ({ where }) => [...manifests].reverse().find(row => row.workspaceId === where.workspaceId && row.artifactType === where.artifactType && row.artifactId === where.artifactId) ?? null);
});

describe("agent run source lineage", () => {
  it.each(["meeting-summary", "brain-absorb", "company-understanding", "slack-agent", "some-new-agent"])("withholds every unproved content field for %s while preserving operations and cost", async agentKey => {
    await fixture(agentKey);
    const [run] = await listAgentRuns(actor, "ws-1");
    expect(run).toMatchObject({ id: "run-1", agentKey, status: "FAILED", contentReadable: false, goal: "Content unavailable", triggerRef: null, planJson: null, contextJson: null, resultJson: null,
      steps: [expect.objectContaining({ id: "step-1", status: "FAILED", inputJson: null, outputJson: null, humanFeedback: null, error: null })],
      toolCalls: [expect.objectContaining({ id: "call-1", status: "FAILED", inputJson: null, outputJson: null, error: null })],
      modelUsageSummary: [] });
    expect(JSON.stringify(run)).not.toContain("private");
    expect(runs[0].goal).toBe("Private source goal");
  });

  it("checks each actual receipt for the current member, including direct trace reads", async () => {
    const { run, step, call, source } = await fixture();
    for (const [kind, row] of [["AgentRun", run], ["AgentStep", step], ["AgentToolCall", call]] as const) await manifest(kind, row, [root("Action", source)]);
    const visible = await getAgentRunTrace(actor, "ws-1", run.id);
    expect(visible).toMatchObject({ contentReadable: true, goal: run.goal, steps: [expect.objectContaining({ humanFeedback: step.humanFeedback })], toolCalls: [expect.objectContaining({ error: call.error })] });
    const denied = await getAgentRunTrace(other, "ws-1", run.id);
    expect(JSON.stringify(denied)).not.toMatch(/private|Private/);
    expect(denied?.status).toBe("FAILED");
  });

  it("requires an independent admin cost grant even for readable run content", async () => {
    const { run, source } = await fixture();
    await manifest("AgentRun", run, [root("Action", source)]);
    run.modelUsage[0].id = "usage-1";
    const cost = { id: "usage-1", workspaceId: "ws-1", estimatedCostUsd: "0.5", billableCostUsd: null, createdAt: now };
    db.modelUsage.findMany.mockResolvedValue([cost]); db.modelUsage.findFirst.mockResolvedValue(cost);
    expect((await listAgentRuns(actor, "ws-1"))[0].modelUsageSummary).toEqual([]);
    membership.mockResolvedValue({ id: "member-1", role: "ADMIN" });
    expect((await listAgentRuns(actor, "ws-1"))[0].modelUsageSummary).toEqual([expect.objectContaining({ estimatedCostUsd: "0.500000" })]);
    source.archivedAt = now;
    expect((await listAgentRuns(actor, "ws-1"))[0].modelUsageSummary).toEqual([]);
  });

  it("does not reuse a parent receipt for unknown or changed children", async () => {
    const { run, call, source } = await fixture();
    await manifest("AgentRun", run, [root("Action", source)]);
    await manifest("AgentToolCall", call, [root("Action", source)]);
    call.outputJson = { secret: "changed private output" };
    const [result] = await listAgentRuns(actor, "ws-1");
    expect(result.contentReadable).toBe(true);
    expect(result.steps[0].contentReadable).toBe(false);
    expect(result.toolCalls[0].outputJson).toBeNull();
  });

  it("revokes content when its source changes or is archived, retaining operational rows", async () => {
    const { run, source } = await fixture();
    await manifest("AgentRun", run, [root("Action", source)]);
    expect((await listAgentRuns(actor, "ws-1"))[0].contentReadable).toBe(true);
    source.archivedAt = now;
    expect((await listAgentRuns(actor, "ws-1"))[0].contentReadable).toBe(false);
    source.archivedAt = null; source.bodyMd = "Changed private source";
    expect((await listAgentRuns(actor, "ws-1"))[0].contentReadable).toBe(false);
  });

  it("separates workspace queries and enforces current membership before any run read", async () => {
    const { run } = await fixture();
    expect(await listAgentRuns(actor, "ws-2")).toEqual([]);
    expect(await getAgentRunTrace(actor, "ws-2", run.id)).toBeNull();
    db.agentRun.findMany.mockClear(); db.agentRun.findFirst.mockClear();
    membership.mockRejectedValue(new AppError(403, "NOT_A_MEMBER", "Revoked."));
    await expect(listAgentRuns(actor, "ws-1")).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    await expect(getAgentRunTrace(actor, "ws-1", run.id)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(db.agentRun.findMany).not.toHaveBeenCalled(); expect(db.agentRun.findFirst).not.toHaveBeenCalled();
  });

  it("does not certify generated logs as human originals", async () => {
    const { run, step, call } = await fixture();
    for (const [kind, row] of [["AgentRun", run], ["AgentStep", step], ["AgentToolCall", call]] as const) {
      await manifest(kind, row, [], "HUMAN_ORIGINAL");
      await expect(recordArtifactInputLineage({ tx: db as any, actor, workspaceId: "ws-1", artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    }
    expect(JSON.stringify(await listAgentRuns(actor, "ws-1"))).not.toMatch(/private|Private/);
  });

  it("returns a redacted operational result when resolving an unknown run", async () => {
    const { run } = await fixture();
    expect(await resolveAgentRun(actor, { workspaceId: "ws-1", agentRunId: run.id, status: "CANCELLED" })).toMatchObject({ status: "CANCELLED", resultJson: null, goal: "Content unavailable" });
  });

  it("blocks continuation of unproved historical advice before any mutation or new prompt", async () => {
    const { run } = await fixture("proposal-drafting");
    run.status = "WAITING_APPROVAL"; run.approvalRequired = true; run.resultJson = { prompt: "Private prompt", proposalDraft: { title: "Private draft" } };
    await expect(submitAgentFeedback(actor, { workspaceId: "ws-1", agentRunId: run.id, stepId: "step-1", feedback: "Please revise" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(db.agentRun.updateMany).not.toHaveBeenCalled(); expect(db.agentStep.updateMany).not.toHaveBeenCalled(); expect(db.workflowJob.create).not.toHaveBeenCalled();
  });
  it("withholds unreceipted historical audit metadata and event bodies without deleting history", async () => {
    const audit = { id: "audit-1", workspaceId: "ws-1", actorUserId: "owner", action: "agentRun.triggered", entityType: "AgentRun", entityId: "run-1", createdAt: now,
      meta: { prompt: "Private historical prompt" } };
    const event = { id: "event-1", type: "agent.run.failed", status: "COMPLETED", createdAt: now,
      payload: { result: "Private historical result" }, jobs: [{ id: "job-1", type: "agent.run", status: "FAILED", completedAt: now }] };
    db.auditLog.findMany.mockResolvedValue([audit]); db.event.findMany.mockResolvedValue([event]);
    expect(await listAuditLogs(actor, "ws-1")).toEqual([]);
    expect(await getEntityTimeline(actor, "ws-1", "AgentRun", "run-1")).toEqual({ auditLogs: [], relatedEvents: [] });
    expect(audit.meta.prompt).toBe("Private historical prompt");
    expect(event.payload.result).toBe("Private historical result");
    expect(db.event.findMany).not.toHaveBeenCalled();
  });

});
