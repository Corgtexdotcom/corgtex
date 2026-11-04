import { beforeEach, describe, expect, it, vi } from "vitest";
const { db, authorize } = vi.hoisted(() => ({ db: {
  auditLog: { findMany: vi.fn(), create: vi.fn() }, event: { findMany: vi.fn() }, workflowJob: { findFirst: vi.fn(), findMany: vi.fn() },
  contextGraphProposedDiff: { findFirst: vi.fn() },
  action: { findFirst: vi.fn(), findMany: vi.fn() }, brainArticle: { findFirst: vi.fn() }, buildArtifact: { findFirst: vi.fn() },
  member: { findFirst: vi.fn(), findMany: vi.fn() }, user: { findFirst: vi.fn() },
  modelUsage: { findMany: vi.fn(), findFirst: vi.fn() }, agentRun: { findFirst: vi.fn() }, workspace: { findFirst: vi.fn() },
  artifactInputLineage: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() }, $executeRaw: vi.fn(), $queryRaw: vi.fn(), $transaction: vi.fn(),
}, authorize: vi.fn() }));
vi.mock("@corgtex/shared", async original => ({ ...await original<any>(), prisma: db }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: authorize }));
vi.mock("./finance", () => ({ getFinanceAccessPolicy: vi.fn(async () => ({canRead: true})) }));
vi.mock("./agent-runs", () => ({ redactAgentRunContent: vi.fn() }));
import { getModelUsageSummary, listAuditLogs, listAuditLogsPage, getEntityTimeline } from "./audit-trail";
import { recordArtifactInputLineage, readableArtifactIds } from "./source-lineage";
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
  db.action.findMany.mockImplementation(async ({where}) => Promise.all(where.id.in.map((id:string)=>db.action.findFirst({where:{id,workspaceId:where.workspaceId}}))));
  db.$queryRaw.mockImplementation(async (query: any) => {
    if (query.sql?.includes('FROM "ArtifactInputLineage"')) return [...new Map(manifests.filter(row => query.values.includes(row.artifactId)).map(row => [row.artifactId,row])).values()];
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
  db.modelUsage.findMany.mockImplementation(async ({where, take, orderBy}) => costs.filter(row => row.workspaceId === where.workspaceId
    && (!where.id?.gt || row.id > where.id.gt) && (!where.createdAt?.gte || row.createdAt >= where.createdAt.gte))
    .sort((left, right) => Array.isArray(orderBy) ? right.createdAt.getTime()-left.createdAt.getTime() || right.id.localeCompare(left.id) : left.id.localeCompare(right.id)).slice(0, take));
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

  it("rejects an earlier admitted cost changed during a later admission batch", async () => {
    costs = Array.from({length: 101}, (_, i) => usage(String(i).padStart(5, "0"), 1));
    const query = db.modelUsage.findFirst.getMockImplementation()!;
    db.modelUsage.findFirst.mockImplementation(async args => {
      if (args.where.id === "00000") costs[100].estimatedCostUsd = 999;
      return query(args);
    });
    await expect(getModelUsageSummary(admin, "ws-1")).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  });

  it("bounds the reporting window before five thousand permitted usage rows", async () => {
    costs = Array.from({length: 5001}, (_, i) => usage(String(i).padStart(5, "0"), 1));
    const result = await getModelUsageSummary(admin, "ws-1");
    expect(result).toMatchObject({totalCalls: 200, totalCostUsd: 200, totalTokens: 6000, periodDays: 30, readWindow:{scope:"WINDOW",complete:false}});
    expect(db.modelUsage.findMany).toHaveBeenCalledOnce();
    expect(db.modelUsage.findMany.mock.calls.every(([query]) => query.take === 200 && query.where.workspaceId === "ws-1")).toBe(true);
  });
  it("bounds five thousand denied costs without representing a complete zero",async()=>{
    const unknown={id:"unknown-run",workspaceId:"ws-1",agentKey:"hidden-agent",goal:"Hidden",createdAt:date};
    runs=[unknown];costs=Array.from({length:5001},(_,i)=>usage(String(i).padStart(5,"0"),1000,unknown));
    const result=await getModelUsageSummary(admin,"ws-1");
    expect(result).toMatchObject({totalCalls:0,totalCostUsd:0,byModel:[],byAgent:[],byDay:[],readWindow:{scope:"WINDOW",complete:false}});
    expect(db.modelUsage.findMany).toHaveBeenCalledOnce();
  });

  it("rechecks current ADMIN even when no costs are readable",async()=>{
    db.modelUsage.findMany.mockImplementation(async()=>{authorize.mockResolvedValue({id:"member-admin",role:"MEMBER"});return [];});
    await expect(getModelUsageSummary(admin,"ws-1")).rejects.toMatchObject({code:"FORBIDDEN"});
  });
  it("retains one enumeration snapshot when inserts occur during original proof admission",async()=>{
    costs=Array.from({length:150},(_,i)=>usage(String(i+100).padStart(5,"0"),1));
    const query=db.modelUsage.findFirst.getMockImplementation()!;let changed=false;
    db.modelUsage.findFirst.mockImplementation(async args=>{
      if(!changed){changed=true;costs.unshift(usage("00099",1));costs.push(usage("00250",1));}
      return query(args);
    });
    expect(await getModelUsageSummary(admin,"ws-1")).toMatchObject({totalCalls:150,totalCostUsd:150,readWindow:{scope:"WINDOW",complete:true}});
    expect(costs).toHaveLength(152);expect(db.modelUsage.findMany).toHaveBeenCalledOnce();
    expect(db.modelUsage.findMany.mock.calls[0][0]).toMatchObject({take:200,orderBy:[{createdAt:"desc"},{id:"desc"}]});
  });

  it("rejects a same-body run head replacement after its original first-batch admission",async()=>{
    const run={id:"original-run",workspaceId:"ws-1",agentKey:"known",goal:"Same body",createdAt:date};runs=[run];
    await recordArtifactInputLineage({tx:db as any,actor:admin,workspaceId:"ws-1",artifact:{kind:"AgentRun",id:run.id},content:run,origin:"DERIVED",inputs:[{kind:"Workspace",id:workspace.id}]});
    costs=Array.from({length:101},(_,i)=>usage(String(i).padStart(5,"0"),1,i===100?run:null));
    const query=db.modelUsage.findFirst.getMockImplementation()!;let changed=false;
    db.modelUsage.findFirst.mockImplementation(async args=>{
      if(args.where.id==="00000"&&!changed){changed=true;const index=manifests.findIndex(row=>row.artifactId===run.id);manifests[index]={...manifests[index],id:"replacement-head",revision:manifests[index].revision+1};}
      return query(args);
    });
    await expect(getModelUsageSummary(admin,"ws-1")).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect(changed).toBe(true);
  });

});


describe("audit and timeline source admission", () => {
  const owner = { kind: "user", user: { id: "owner" } } as any;
  const other = { kind: "user", user: { id: "other" } } as any;

  async function privateSource(kind: "Action" | "BrainArticle") {
    authorize.mockImplementation(async ({ actor, workspaceId }) => {
      if (workspaceId !== "ws-1") throw new Error("workspace denied");
      return { id: `member-${actor.user.id}`, role: "MEMBER" };
    });
    const source = { id: `private-${kind}`, workspaceId: "ws-1", title: "Private target title", bodyMd: "Private target body",
      status: "DRAFT", isPrivate: true, authorUserId: "owner", ownerMemberId: "member-owner", archivedAt: null };
    const delegate = kind === "Action" ? db.action : db.brainArticle;
    delegate.findFirst.mockImplementation(async ({ where }) => where.id === source.id && where.workspaceId === source.workspaceId ? source : null);
    await recordArtifactInputLineage({ tx: db as any, actor: owner, workspaceId: "ws-1",
      artifact: { kind, id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    // Establish the real source permission boundary, with no boolean source-gate mock.
    expect(await readableArtifactIds(owner, "ws-1", kind, [source])).toEqual(new Set([source.id]));
    expect(await readableArtifactIds(other, "ws-1", kind, [source])).toEqual(new Set());
    const audit = { id: `audit-${kind}`, workspaceId: "ws-1", actorUserId: "owner",
      action: kind === "Action" ? "action.created" : "brain-article.created", entityType: kind, entityId: source.id,
      createdAt: date, meta: { title: source.title } };
    const event = { id: `event-${kind}`, type: audit.action, status: "DISPATCHED", createdAt: date,
      payload: { targetId: source.id }, jobs: [{ id: `job-${kind}`, type: "knowledge.sync.action", status: "COMPLETED", completedAt: date }] };
    db.auditLog.findMany.mockResolvedValue([audit]); db.event.findMany.mockResolvedValue([event]);
    db.workflowJob.findMany.mockImplementation(async () => event.jobs.map(job => ({ ...job, eventId: event.id })));
    return { source, audit, event };
  }

  it.each(["member.updated", "member.deactivated", "member.reactivated"] as const)(
    "retains %s lifecycle facts only while the current Member is readable", async action => {
      // Historical deactivation remains visible after a member is reactivated.
      const user = { id: "subject-user", email: "subject@example.test", displayName: "Subject" };
      const member = { id: "member-subject", workspaceId: "ws-1", userId: user.id, role: "CONTRIBUTOR", isActive: true, user };
      db.member.findFirst.mockImplementation(async ({ where }) => where.id === member.id && where.workspaceId === member.workspaceId ? member : null);
      db.user.findFirst.mockImplementation(async ({ where }) => where.id === user.id ? user : null);
      const audit = { id: `audit-${action}`, workspaceId: "ws-1", actorUserId: "admin", action,
        entityType: "Member", entityId: member.id, createdAt: date, meta: { private: "historical fields" } };
      const event = { id: `event-${action}`, type: action, status: "DISPATCHED", createdAt: date,
        payload: { private: "historical fields" }, jobs: [] };
      db.auditLog.findMany.mockResolvedValue([audit, { ...audit, id: "unknown", action: "member.unknown" }]);
      db.event.findMany.mockResolvedValue([event, { ...event, id: "unknown", type: "member.unknown" }]);
      db.workflowJob.findMany.mockResolvedValue([]);
      expect(await listAuditLogs(admin, "ws-1")).toEqual([{ ...audit, meta: null }]);
      expect(await getEntityTimeline(admin, "ws-1", "Member", member.id)).toEqual({
        auditLogs: [{ ...audit, meta: null }], relatedEvents: [{ ...event, payload: null }],
      });
      member.isActive = false;
      expect(await listAuditLogs(admin, "ws-1")).toEqual([]);
      expect(await getEntityTimeline(admin, "ws-1", "Member", member.id)).toEqual({ auditLogs: [], relatedEvents: [] });
    });

  it.each(["Action", "BrainArticle"] as const)("withholds %s audit identity and existence from another member", async kind => {
    const { source, audit } = await privateSource(kind);
    if (kind === "Action") audit.action = "legacy-history.recovered";
    const result = await listAuditLogs(other, "ws-1", { entityType: kind, entityId: source.id });
    expect(result).toEqual([]);
    expect(audit.meta.title).toBe(source.title);
  });

  it.each(["Action", "BrainArticle"] as const)("withholds %s timeline events and job paths from another member", async kind => {
    const { source } = await privateSource(kind);
    const result = await getEntityTimeline(other, "ws-1", kind, source.id);
    expect(result).toEqual({ auditLogs: [], relatedEvents: [] });
  });

  it.each(["action.created", "legacy-history.recovered"])("retains a proven owner's %s facts and filters unproved jobs and free text", async action => {
    const { source, audit, event } = await privateSource("Action");
    audit.action = action;
    const job = { id: "proved-job", workspaceId: "ws-1", eventId: event.id, type: "knowledge.sync.action", payload: { actionId: source.id } };
    db.workflowJob.findFirst.mockImplementation(async ({ where }) => where.id === job.id && where.workspaceId === job.workspaceId ? job : null);
    await recordArtifactInputLineage({ tx: db as any, actor: owner, workspaceId: "ws-1",
      artifact: { kind: "WorkflowJobInput", id: job.id }, content: job, origin: "DERIVED", inputs: [{ kind: "Action", id: source.id }] });
    const visibleJob = { id: job.id, type: job.type, status: "COMPLETED", completedAt: date };
    event.jobs.push(visibleJob);
    db.auditLog.findMany.mockResolvedValue([{ ...audit, id: "unproved-text", action: "Private historical free text" }, audit]);
    db.event.findMany.mockResolvedValue([{ ...event, id: "unproved-event", type: "Private event free text" }, event]);
    expect(await listAuditLogs(owner, "ws-1", { take: 1 })).toEqual([{ ...audit, meta: null }]);
    expect(db.auditLog.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 100 }));
    expect(await getEntityTimeline(owner, "ws-1", "Action", source.id)).toEqual({
      auditLogs: [{ ...audit, meta: null }], relatedEvents: [{ ...event, jobs: [visibleJob], payload: null }],
    });
  });

  it.each(["list", "timeline"] as const)("retains graph approval identity in %s only for readable targets", async surface => {
    const { source, audit } = await privateSource("Action");
    const diff = { id: "graph-diff", workspaceId: "ws-1", proposedByType: "user", proposedByUserId: "owner",
      proposedByAgentRunId: null, diffJson: { objects: [] }, reason: "Private proposal", evidenceJson: null,
      status: "applied", reviewedByUserId: "owner", reviewedAt: date, appliedAt: date };
    db.contextGraphProposedDiff.findFirst.mockImplementation(async ({ where }) =>
      where.id === diff.id && where.workspaceId === diff.workspaceId ? diff : null);
    await recordArtifactInputLineage({ tx: db as any, actor: owner, workspaceId: "ws-1",
      artifact: { kind: "ContextGraphProposedDiff", id: diff.id }, content: diff, origin: "DERIVED",
      inputs: [{ kind: "Action", id: source.id }] });
    const approval = { ...audit, id: "graph-approval", action: "context-graph.diff.approved",
      entityType: "ContextGraphProposedDiff", entityId: diff.id, meta: { graphApproval: { private: "proof" } } };
    const operations = ["proposed", "approved", "applied"].map(operation => ({ ...approval,
      id: `graph-${operation}`, action: `context-graph.diff.${operation}` }));
    db.auditLog.findMany.mockResolvedValue([...operations, { ...approval, id: "unknown", action: "context-graph.diff.unknown" }]);
    db.event.findMany.mockResolvedValue([]);
    const expected = operations.map(row => ({ ...row, meta: null }));
    if (surface === "list") {
      expect(await listAuditLogs(owner, "ws-1")).toEqual(expected);
      expect(await listAuditLogs(other, "ws-1")).toEqual([]);
    } else {
      expect(await getEntityTimeline(owner, "ws-1", "ContextGraphProposedDiff", diff.id))
        .toEqual({ auditLogs: expected, relatedEvents: [] });
      expect(await getEntityTimeline(other, "ws-1", "ContextGraphProposedDiff", diff.id))
        .toEqual({ auditLogs: [], relatedEvents: [] });
    }
    expect(expected[1].actorUserId).toBe("owner");
  });

  it("does not let hidden targets crowd out a permitted audit row before the page limit", async () => {
    const { source, audit } = await privateSource("Action");
    const publicSource = { ...source, id: "public-action", isPrivate: false };
    db.action.findFirst.mockImplementation(async ({ where }) => [source, publicSource].find(row => row.id === where.id && row.workspaceId === where.workspaceId) ?? null);
    await recordArtifactInputLineage({ tx: db as any, actor: owner, workspaceId: "ws-1", artifact: { kind: "Action", id: publicSource.id },
      content: publicSource, origin: "HUMAN_ORIGINAL", inputs: [] });
    const publicAudit = { ...audit, id: "public-audit", entityId: publicSource.id };
    db.auditLog.findMany.mockResolvedValue([...Array.from({ length: 50 }, (_, i) => ({ ...audit, id: `hidden-${i}` })), publicAudit]);
    expect(await listAuditLogs(other, "ws-1", { take: 1 })).toEqual([{ ...publicAudit, meta: null }]);
  });

  it("bounds denied audit windows and continues to a later permitted row", async () => {
    const { source, audit } = await privateSource("Action");
    const publicSource = { ...source, id: "permitted-late", isPrivate: false };
    db.action.findFirst.mockImplementation(async ({ where }) => [source, publicSource].find(row => row.id === where.id && row.workspaceId === where.workspaceId) ?? null);
    await recordArtifactInputLineage({ tx: db as any, actor: owner, workspaceId: "ws-1", artifact: { kind: "Action", id: publicSource.id },
      content: publicSource, origin: "HUMAN_ORIGINAL", inputs: [] });
    const rows = Array.from({length: 5001}, (_, i) => ({...audit, id: String(6000-i).padStart(5,"0"), createdAt: date}));
    rows.push({...audit, id: "00001", entityId: publicSource.id, createdAt: date});
    db.auditLog.findMany.mockImplementation(async ({where,take}) => rows.filter(row => !where.OR || row.id < where.OR[1].id.lt).slice(0,take));
    const first = await listAuditLogsPage(other, "ws-1", { take: 1 });
    expect(first).toMatchObject({ items: [], scanLimited: true, nextCursor: expect.any(String) });
    expect(db.auditLog.findMany).toHaveBeenCalledTimes(50);
    const second = await listAuditLogsPage(other, "ws-1", { take: 1, cursor: first.nextCursor! });
    expect(second).toEqual({ items: [{ ...rows.at(-1), meta: null }], nextCursor: null, scanLimited: false });
    expect(db.auditLog.findMany).toHaveBeenCalledTimes(51);
    expect(db.auditLog.findMany.mock.calls.every(([query]) => query.take===100)).toBe(true);
  });

  it.each(["unknown-operation", "unsupported-type"])("bounds all %s candidates and rejects malformed continuation", async mode => {
    const rows = Array.from({ length: 5100 }, (_, i) => ({ id: String(6000-i).padStart(5, "0"), workspaceId: "ws-1",
      action: mode === "unknown-operation" ? "unknown.free.text" : "action.created",
      entityType: mode === "unsupported-type" ? "Unsupported" : "Action", entityId: "hidden", actorUserId: null, createdAt: date }));
    db.auditLog.findMany.mockImplementation(async ({ where, take }) => {
      expect(where.workspaceId).toBe("ws-1");
      return rows.filter(row => !where.OR || row.id < where.OR[1].id.lt).slice(0, take);
    });
    const page = await listAuditLogsPage(owner, "ws-1", { take: 50 });
    expect(page.items).toEqual([]); expect(page.scanLimited).toBe(true); expect(page.nextCursor).toBeTruthy();
    expect(db.auditLog.findMany).toHaveBeenCalledTimes(50); expect(db.action.findFirst).not.toHaveBeenCalled();
    await expect(listAuditLogs(owner, "ws-1")).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
    await expect(listAuditLogsPage(owner, "ws-1", { cursor: "malformed" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("limits the legacy list wrapper instead of exhausting an unbounded denied suffix", async () => {
    const rows = Array.from({ length: 5100 }, (_, i) => ({ id: String(6000-i).padStart(5, "0"), workspaceId: "ws-1",
      action: "unknown.free.text", entityType: "Action", entityId: "hidden", actorUserId: null, createdAt: date }));
    db.auditLog.findMany.mockImplementation(async ({ where, take }) => rows.filter(row => !where.OR || row.id < where.OR[1].id.lt).slice(0, take));
    await expect(listAuditLogs(owner, "ws-1")).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
    expect(db.auditLog.findMany).toHaveBeenCalledTimes(50);
  });

  it("continues after the last examined permitted row without skipping the fetched tail", async () => {
    const { audit } = await privateSource("Action");
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...audit, id: String(3-i), createdAt: date }));
    db.auditLog.findMany.mockImplementation(async ({ where, take }) => {
      expect(where).toMatchObject({ workspaceId: "ws-1", entityType: "Action", entityId: audit.entityId, action: { contains: "created" }, actorUserId: "owner" });
      return rows.filter(row => !where.OR || row.id < where.OR[1].id.lt).slice(0, take);
    });
    const opts = { take: 1, entityType: "Action", entityId: audit.entityId, action: "created", actorUserId: "owner" };
    const first = await listAuditLogsPage(owner, "ws-1", opts);
    const second = await listAuditLogsPage(owner, "ws-1", { ...opts, cursor: first.nextCursor! });
    const third = await listAuditLogsPage(owner, "ws-1", { ...opts, cursor: second.nextCursor! });
    expect([first, second, third].flatMap(page => page.items.map(row => row.id))).toEqual(["3", "2", "1"]);
    expect(third.nextCursor).toBeNull();
    authorize.mockRejectedValueOnce(new Error("membership revoked"));
    await expect(listAuditLogsPage(owner, "ws-1", { ...opts, cursor: first.nextCursor! })).rejects.toThrow("membership revoked");
  });

  it("withholds unknown, deleted and unsupported audit targets and rejects malformed pages", async () => {
    const { source, audit } = await privateSource("Action");
    manifests = [];
    expect(await listAuditLogs(owner, "ws-1")).toEqual([]);
    db.action.findFirst.mockResolvedValue(null);
    expect(await getEntityTimeline(owner, "ws-1", "Action", source.id)).toEqual({ auditLogs: [], relatedEvents: [] });
    db.auditLog.findMany.mockResolvedValue([{ ...audit, entityType: "UnsupportedSecretType" }]);
    expect(await listAuditLogs(owner, "ws-1")).toEqual([]);
    db.auditLog.findMany.mockResolvedValue(Array.from({ length: 5001 }, (_, i) => ({ ...audit, id: `audit-${i}` })));
    await expect(listAuditLogs(owner, "ws-1")).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_CHANGED" });
  });

  it("withholds a public target with private source ancestry", async () => {
    const { source, audit } = await privateSource("Action");
    const copied = { ...source, id: "public-copy", isPrivate: false };
    db.action.findFirst.mockImplementation(async ({ where }) => [source, copied].find(row => row.id === where.id && row.workspaceId === where.workspaceId) ?? null);
    await recordArtifactInputLineage({ tx: db as any, actor: owner, workspaceId: "ws-1", artifact: { kind: "Action", id: copied.id },
      content: copied, origin: "DERIVED", inputs: [{ kind: "Action", id: source.id }] });
    db.auditLog.findMany.mockResolvedValue([{ ...audit, entityId: copied.id }]);
    expect(await listAuditLogs(other, "ws-1")).toEqual([]);
    expect(await getEntityTimeline(other, "ws-1", "Action", copied.id)).toEqual({ auditLogs: [], relatedEvents: [] });
  });

  it("rechecks the admitted source after asynchronous timeline reads", async () => {
    const { source, event } = await privateSource("Action");
    db.event.findMany.mockImplementation(async () => { source.archivedAt = date as any; return [event]; });
    expect(await getEntityTimeline(owner, "ws-1", "Action", source.id)).toEqual({ auditLogs: [], relatedEvents: [] });
  });

  it("checks current membership before reading either audit or timeline data", async () => {
    authorize.mockRejectedValue(new Error("membership revoked"));
    await expect(listAuditLogs(other, "ws-1")).rejects.toThrow("membership revoked");
    await expect(getEntityTimeline(other, "ws-1", "Action", "private-target")).rejects.toThrow("membership revoked");
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
    expect(db.event.findMany).not.toHaveBeenCalled();
  });
});


describe("build artifact audit lifecycle", () => {
  it.each(["build_artifact.created", "build_artifact.updated"] as const)("retains %s only for readable original targets", async action => {
    const owner = { kind: "user", user: { id: "build-owner" } } as any;
    const other = { kind: "user", user: { id: "other-member" } } as any;
    authorize.mockImplementation(async ({ actor, workspaceId }) => { if (workspaceId !== "ws-1") throw new Error("workspace denied"); return { id: `member-${actor.user.id}`, role: "CONTRIBUTOR" }; });
    const artifact = { id: "private-build", workspaceId: "ws-1", createdByUserId: owner.user.id, brainSourceId: null, repositoryOwner: "synthetic", repositoryName: "private-repository", title: "Private build", summaryMd: "Private details", status: "OPEN", classification: "INTERNAL", visibility: "PRIVATE", createdAt: date, updatedAt: date };
    db.buildArtifact.findFirst.mockImplementation(async ({ where }) => where.id === artifact.id && where.workspaceId === artifact.workspaceId ? artifact : null);
    await recordArtifactInputLineage({ tx: db as any, actor: owner, workspaceId: "ws-1", artifact: { kind: "BuildArtifact", id: artifact.id }, content: artifact, origin: "HUMAN_ORIGINAL", inputs: [] });
    expect(await readableArtifactIds(owner, "ws-1", "BuildArtifact", [artifact])).toEqual(new Set([artifact.id]));
    expect(await readableArtifactIds(other, "ws-1", "BuildArtifact", [artifact])).toEqual(new Set());
    const audit = { id: `audit-${action}`, workspaceId: "ws-1", actorUserId: owner.user.id, action, entityType: "BuildArtifact", entityId: artifact.id, createdAt: date, meta: { private: artifact.summaryMd } };
    db.auditLog.findMany.mockResolvedValue([audit, { ...audit, id: "unknown-operation", action: "build_artifact.private_free_text" }]);
    db.event.findMany.mockResolvedValue([]);
    expect(await listAuditLogs(owner, "ws-1")).toEqual([{ ...audit, meta: null }]);
    expect(await getEntityTimeline(owner, "ws-1", "BuildArtifact", artifact.id)).toEqual({ auditLogs: [{ ...audit, meta: null }], relatedEvents: [] });
    expect(await listAuditLogs(other, "ws-1")).toEqual([]);
    expect(await getEntityTimeline(other, "ws-1", "BuildArtifact", artifact.id)).toEqual({ auditLogs: [], relatedEvents: [] });
    artifact.summaryMd = "Changed unproven content";
    expect(await listAuditLogs(owner, "ws-1")).toEqual([]);
    expect(await getEntityTimeline(owner, "ws-1", "BuildArtifact", artifact.id)).toEqual({ auditLogs: [], relatedEvents: [] });
  });
});
