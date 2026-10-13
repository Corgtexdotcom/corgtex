import { beforeEach, describe, expect, it, vi } from "vitest";
const { db, authorize } = vi.hoisted(() => ({ db: {
  modelUsage: { findMany: vi.fn(), findFirst: vi.fn() }, agentRun: { findFirst: vi.fn() }, workspace: { findFirst: vi.fn() },
  artifactInputLineage: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() }, $executeRaw: vi.fn(), $queryRaw: vi.fn(), $transaction: vi.fn(),
}, authorize: vi.fn() }));
vi.mock("@corgtex/shared", async original => ({ ...await original<any>(), prisma: db }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: authorize }));
vi.mock("./finance", () => ({ getFinanceAccessPolicy: vi.fn(async () => ({canRead: true})) }));
vi.mock("./agent-runs", () => ({ redactAgentRunContent: vi.fn() }));
import { getModelUsageSummary } from "./audit-trail";
import { recordArtifactInputLineage } from "./source-lineage";
const admin = {kind: "user", user: {id: "admin"}} as any;
const date = new Date();
const workspace = { id: "ws-1", name: "Workspace", createdAt: date };
let costs: any[], runs: any[], manifests: any[];
function usage(id: string, cost: number, agentRun: any = null) {
  return {id, workspaceId: "ws-1", agentRunId: agentRun?.id ?? null, agentRun, provider: "fixture", model: `model-${id}`, taskType: "fixture",
    inputTokens: 10, outputTokens: 20, latencyMs: 50, estimatedCostUsd: cost, billableCostUsd: null, createdAt: date};
}
beforeEach(() => {
  vi.resetAllMocks(); costs = []; runs = []; manifests = [];
  const epochs = new Map<string, bigint>();
  db.$executeRaw.mockImplementation(async (query: any) => {
    if (query.sql?.includes('INSERT INTO "SourcePermissionEpoch"')) for (let i = 0; i < query.values.length; i += 4) {
      const [, ws, kind, id] = query.values.slice(i, i + 4); const key = JSON.stringify([ws, kind, id]);
      if (!epochs.has(key)) epochs.set(key, 0n);
    }
    return 1;
  });
  db.$queryRaw.mockImplementation(async (query: any) => {
    if (!query.sql?.includes('FROM "SourcePermissionEpoch"')) return [];
    const [ws, ...pairs] = query.values; const rows = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const [sourceKind, sourceId] = pairs.slice(i, i + 2); const epoch = epochs.get(JSON.stringify([ws, sourceKind, sourceId]));
      if (epoch !== undefined) rows.push({ sourceKind, sourceId, epoch });
    }
    return rows;
  });
  db.$transaction.mockImplementation(async run => run(db));
  db.artifactInputLineage.create.mockImplementation(async ({ data }) => { const row = { id: `manifest-${manifests.length}`, ...data }; manifests.push(row); return row; });
  authorize.mockImplementation(async ({actor, workspaceId}) => {
    if (workspaceId !== "ws-1") throw new Error("workspace denied");
    return actor.kind === "user" ? {id: "member-admin", role: "ADMIN"} : null;
  });
  db.modelUsage.findMany.mockImplementation(async () => costs);
  db.modelUsage.findFirst.mockImplementation(async ({where}) => costs.find(row => row.id === where.id && row.workspaceId === where.workspaceId) ?? null);
  db.agentRun.findFirst.mockImplementation(async ({where}) => runs.find(row => row.id === where.id && row.workspaceId === where.workspaceId) ?? null);
  db.workspace.findFirst.mockImplementation(async ({where}) => where.id === workspace.id ? workspace : null);
  db.artifactInputLineage.findMany.mockImplementation(async ({where}) => manifests.filter(row => row.artifactType === where.artifactType && where.artifactId.in.includes(row.artifactId)));
  db.artifactInputLineage.findFirst.mockImplementation(async ({where}) => manifests.find(row => row.artifactType === where.artifactType && row.artifactId === where.artifactId) ?? null);
});

describe("model usage summary source boundaries", () => {
  it.each(["MEMBER", "agent"])("denies %s before loading financial metrics", async role => {
    const actor = role === "agent" ? {kind: "agent", authProvider: "bootstrap", label: "budget-alerts", workspaceIds: ["ws-1"]} as any : admin;
    authorize.mockResolvedValue(role === "agent" ? null : {id: "member", role});
    await expect(getModelUsageSummary(actor, "ws-1")).rejects.toMatchObject({code: "FORBIDDEN"});
    expect(db.modelUsage.findMany).not.toHaveBeenCalled();
  });

  it("filters unknown and stale runs before costs, counts, model groups and agent labels", async () => {
    const visible = {id: "run-visible", workspaceId: "ws-1", agentKey: "known-agent", goal: "Known", createdAt: date};
    const unknown = {...visible, id: "run-unknown", agentKey: "secret-agent"};
    const stale = {...visible, id: "run-stale", goal: "Earlier", agentKey: "stale-agent"};
    runs = [visible, unknown, stale];
    for (const run of [visible, stale]) await recordArtifactInputLineage({ tx: db as any, actor: admin, workspaceId: "ws-1",
      artifact: { kind: "AgentRun", id: run.id }, content: run, origin: "DERIVED", inputs: [{ kind: "Workspace", id: workspace.id }] });
    stale.goal = "Changed content";
    costs = [usage("visible", 2, visible), usage("unknown", 1000, unknown), usage("stale", 2000, stale), usage("native", 3)];
    const result = await getModelUsageSummary(admin, "ws-1");
    expect(result.totalCostUsd).toBe(5);
    expect(result.totalCalls).toBe(2);
    expect(result.totalTokens).toBe(60);
    expect(result.byModel.map(row => row.model)).toEqual(["model-native", "model-visible"]);
    expect(result.byAgent.map(row => row.agentKey)).toEqual(["unknown", "known-agent"]);
  });

  it("rejects incomplete financial scans instead of returning partial totals", async () => {
    costs = Array.from({length: 5001}, (_, i) => usage(String(i), 1));
    await expect(getModelUsageSummary(admin, "ws-1")).rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
    expect(db.modelUsage.findMany).toHaveBeenCalledWith(expect.objectContaining({take: 5001}));
  });
});
