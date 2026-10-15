import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma as db, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { getAgentRunOperationalCounts, listAgentRuns } from "./agent-runs";
import { getAgentRunTrace } from "./audit-trail";
import { recordArtifactInputLineage } from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture(role: "ADMIN" | "CONTRIBUTOR" = "ADMIN") {
  const workspace = await db.workspace.create({ data: { name: "Agent release", slug: randomUUID() } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@agent-release.test`, passwordHash: "synthetic" } });
  const other = await db.user.create({ data: { email: `${randomUUID()}@agent-release.test`, passwordHash: "synthetic" } });
  const member = await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role } });
  await db.member.create({ data: { workspaceId: workspace.id, userId: other.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user };
  async function original(hidden = false) {
    const row = await db.action.create({ data: { workspaceId: workspace.id, authorUserId: hidden ? other.id : user.id,
      title: "Input", bodyMd: "Input body", isPrivate: true, status: "DRAFT" } });
    await db.$transaction(tx => recordArtifactInputLineage({ tx, actor: hidden ? { kind: "user", user: other } : actor,
      workspaceId: workspace.id, artifact: { kind: "Action", id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
    return row;
  }
  async function run(hidden = false) {
    const source = await original(hidden);
    const author: AppActor = hidden ? { kind: "user", user: other } : actor;
    const run = await db.agentRun.create({ data: { workspaceId: workspace.id, agentKey: "meeting-summary", triggerType: "EVENT",
      triggerRef: "Sensitive trigger", goal: "Sensitive goal", planJson: { body: "Sensitive plan" }, contextJson: { body: "Sensitive context" },
      resultJson: { body: "Sensitive result" }, status: "WAITING_APPROVAL" } });
    const step = await db.agentStep.create({ data: { agentRunId: run.id, name: "Sensitive step", inputJson: { body: "Sensitive input" },
      outputJson: { body: "Sensitive output" }, error: "Sensitive error", humanFeedback: "Sensitive feedback" } });
    const tool = await db.agentToolCall.create({ data: { agentRunId: run.id, name: "Sensitive tool", inputJson: { body: "Sensitive input" },
      outputJson: { body: "Sensitive output" }, error: "Sensitive tool error" } });
    const usage = await db.modelUsage.create({ data: { workspaceId: workspace.id, agentRunId: run.id,
      provider: "test", model: "test-model", taskType: "CHAT", inputTokens: 5, outputTokens: 3, estimatedCostUsd: "0.2" } });
    for (const [kind, row] of [["AgentRun", run], ["AgentStep", step], ["AgentToolCall", tool]] as const) {
      await db.$transaction(tx => recordArtifactInputLineage({ tx, actor: author, workspaceId: workspace.id,
        artifact: { kind, id: row.id }, content: row, origin: "DERIVED", inputs: [{ kind: "Action", id: source.id }] }));
    }
    return { run, step, tool, source, usage };
  }
  return { workspaceId: workspace.id, actor, otherActor: { kind: "user", user: other } as AppActor, member, run, original };
}

type Surface = "list" | "trace";
async function read(surface: Surface, f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  return surface === "list" ? listAgentRuns(f.actor, f.workspaceId) : getAgentRunTrace(f.actor, f.workspaceId, runId);
}
function duringCosts(mutate: () => Promise<void>) {
  const original = db.modelUsage.findMany.bind(db.modelUsage);
  let fired = false;
  vi.spyOn(db.modelUsage, "findMany").mockImplementation((async args => {
    const rows = await original(args);
    if (!fired) { fired = true; await mutate(); }
    return rows;
  }) as typeof db.modelUsage.findMany);
}

describe("agent run final content release", () => {
  it("returns unchanged run, child and financial content to the currently permitted administrator", async () => {
    const f = await fixture(), r = await f.run();
    expect(await listAgentRuns(f.actor, f.workspaceId)).toEqual([expect.objectContaining({
      contentReadable: true, goal: r.run.goal, planJson: r.run.planJson, contextJson: r.run.contextJson, resultJson: r.run.resultJson,
      steps: [expect.objectContaining({ contentReadable: true, humanFeedback: r.step.humanFeedback })],
      toolCalls: [expect.objectContaining({ contentReadable: true, outputJson: r.tool.outputJson })],
      modelUsageSummary: [expect.objectContaining({ inputTokens: 5, outputTokens: 3, estimatedCostUsd: "0.200000" })],
    })]);
  });

  it.each(["list", "trace"] as const)("rejects %s after source revocation during cost loading", async surface => {
    const f = await fixture(), r = await f.run();
    duringCosts(async () => { await db.action.update({ where: { id: r.source.id }, data: { archivedAt: new Date() } }); });
    await expect(read(surface, f, r.run.id)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it.each(["AgentRun", "AgentStep", "AgentToolCall"] as const)("keeps the original %s head even when its replacement has the same body", async kind => {
    const f = await fixture(), r = await f.run();
    const row = kind === "AgentRun" ? r.run : kind === "AgentStep" ? r.step : r.tool;
    duringCosts(async () => {
      const head = await db.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspaceId, artifactType: kind, artifactId: row.id }, orderBy: { revision: "desc" } });
      const { id: _id, ...data } = head;
      await db.artifactInputLineage.create({ data: { ...data, revision: head.revision + 1,
        rootsJson: data.rootsJson ?? Prisma.JsonNull, inputsJson: data.inputsJson ?? Prisma.JsonNull,
        permissionEpochsJson: data.permissionEpochsJson ?? Prisma.JsonNull } });
    });
    await expect(read("trace", f, r.run.id)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it.each(["source", "membership", "cost-role"] as const)("retains %s revoke/restore observations until release", async boundary => {
    const f = await fixture(), r = await f.run();
    duringCosts(async () => {
      if (boundary === "source") {
        await db.action.update({ where: { id: r.source.id }, data: { archivedAt: new Date() } });
        await db.action.update({ where: { id: r.source.id }, data: { archivedAt: null } });
      } else if (boundary === "membership") {
        await db.member.update({ where: { id: f.member.id }, data: { isActive: false } });
        await db.member.update({ where: { id: f.member.id }, data: { isActive: true } });
      } else {
        await db.member.update({ where: { id: f.member.id }, data: { role: "CONTRIBUTOR" } });
        await db.member.update({ where: { id: f.member.id }, data: { role: "ADMIN" } });
      }
    });
    await expect(read("list", f, r.run.id)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("checks the current caller after assembly, including a still-revoked member", async () => {
    const f = await fixture(), r = await f.run();
    duringCosts(async () => { await db.member.update({ where: { id: f.member.id }, data: { isActive: false } }); });
    await expect(read("trace", f, r.run.id)).rejects.toMatchObject({ code: expect.stringMatching(/SOURCE_CHANGED|NOT_A_MEMBER/) });
  });

  it("holds early run proofs until slower runs finish loading their costs", async () => {
    const f = await fixture(), early = await f.run(), slow = await f.run();
    const original = db.modelUsage.findMany.bind(db.modelUsage);
    let firstDone!: () => void;
    const first = new Promise<void>(resolve => { firstDone = resolve; });
    vi.spyOn(db.modelUsage, "findMany").mockImplementation((async args => {
      const rows = await original(args);
      if (rows.some(row => row.id === early.usage.id)) firstDone();
      if (rows.some(row => row.id === slow.usage.id)) {
        await first;
        await setImmediate();
        await db.action.update({ where: { id: early.source.id }, data: { archivedAt: new Date() } });
      }
      return rows;
    }) as typeof db.modelUsage.findMany);
    await expect(listAgentRuns(f.actor, f.workspaceId)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("preserves mixed readable and denied operations, independent child redaction and numeric counts", async () => {
    const f = await fixture("CONTRIBUTOR"), visible = await f.run(), denied = await f.run(true);
    const hidden = await f.original(true);
    await db.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.otherActor, workspaceId: f.workspaceId,
      artifact: { kind: "AgentStep", id: visible.step.id }, content: visible.step, origin: "DERIVED", inputs: [{ kind: "Action", id: hidden.id }] }));
    const rows = await listAgentRuns(f.actor, f.workspaceId);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === visible.run.id)).toMatchObject({ contentReadable: true, goal: visible.run.goal,
      steps: [expect.objectContaining({ contentReadable: false, name: "Content unavailable", inputJson: null, outputJson: null, error: null, humanFeedback: null })],
      toolCalls: [expect.objectContaining({ contentReadable: true, name: visible.tool.name })],
      modelUsageSummary: [] });
    const redacted = rows.find(row => row.id === denied.run.id);
    expect(redacted).toMatchObject({ status: "WAITING_APPROVAL", contentReadable: false, goal: "Content unavailable", triggerRef: null,
      planJson: null, contextJson: null, resultJson: null, modelUsageSummary: [] });
    expect(JSON.stringify(redacted)).not.toContain("Sensitive");
    expect(await getAgentRunOperationalCounts(f.actor, f.workspaceId)).toEqual({
      pendingApprovalCountsByAgent: [{ agentKey: "meeting-summary", count: 2 }], runCountsByAgent: [{ agentKey: "meeting-summary", count: 2 }],
    });
    const trace = await getAgentRunTrace(f.otherActor, f.workspaceId, visible.run.id);
    expect(trace).toMatchObject({ contentReadable: false, modelUsage: [],
      steps: [expect.objectContaining({ contentReadable: true })], toolCalls: [expect.objectContaining({ contentReadable: false })] });
  });
});
