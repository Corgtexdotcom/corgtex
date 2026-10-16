import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createFreshDemoSeedWorkspace, settleFreshDemoInitialization } from "./demo-seed-lifecycle.mjs";
import { assertDemoWorkspaceDisconnected } from "./demo-credentials.mjs";

function fixture() {
  let workspace = null;
  let txId = "42";
  const events = [];
  const epochs = new Map();
  const db = Object.fromEntries(Prisma.dmmf.datamodel.models.map(model => [model.name[0].toLowerCase() + model.name.slice(1), { count: vi.fn(async () => 0) }]));
  db.$queryRawUnsafe = vi.fn(async () => [{ id: txId }]);
  db.workspace = { count: vi.fn(async () => workspace ? 1 : 0), create: vi.fn(async ({ data }) => workspace = { id: "fresh-demo", ...data }),
    findUnique: vi.fn(async () => workspace) };
  const users = [{ id: "public", email: "demo@jnj-demo.corgtex.app", globalRole: "USER" },
    { id: "persona", email: "synthetic@jnj.demo.corgtex.app", globalRole: "USER" }];
  const members = users.map(user => ({ id: `member-${user.id}`, userId: user.id, isActive: true, role: "CONTRIBUTOR" }));
  const circles = [{ id: "circle" }], roles = [{ id: "role", circleId: "circle" }];
  const assignments = [{ id: "assignment", roleId: "role", memberId: "member-persona" }];
  const flags = ["AI_WORKSPACES", "CONTEXT_MAPS", "FINANCE", "RELATIONSHIPS"].map(flag => ({ id: flag, flag, enabled: true,
    config: flag === "FINANCE" ? { financeCapabilities: { reportImports: true, reports: true } } : null }));
  for (const [model, rows] of [["user", users], ["member", members], ["circle", circles], ["role", roles], ["roleAssignment", assignments], ["workspaceFeatureFlag", flags]])
    db[model].findMany = vi.fn(async () => structuredClone(rows));
  db.event = { count: vi.fn(async () => events.length), findMany: vi.fn(async () => structuredClone(events)),
    deleteMany: vi.fn(async ({ where }) => { const index = events.findIndex(event => event.id === where.id);
      if (index < 0) return { count: 0 }; events.splice(index, 1); return { count: 1 }; }) };
  db.sourcePermissionEpoch.findUnique = vi.fn(async ({ where }) => ({ epoch: epochs.get(JSON.stringify(where.workspaceId_sourceKind_sourceId)) ?? 0n }));
  const input = { userIds: users.map(user => user.id), emails: users.map(user => user.email), circleIds: circles.map(row => row.id),
    roleIds: roles.map(row => row.id), assignments: assignments.map(({ roleId, memberId }) => ({ roleId, memberId })) };
  async function begin() {
    const { token } = await createFreshDemoSeedWorkspace(db, { slug: "jnj-demo", name: "Synthetic", description: "Synthetic" });
    const governors = [{ kind: "RoleAssignment", id: "assignment" }, ...flags.map(flag => ({ kind: "WorkspaceFeatureFlag", id: flag.id }))];
    for (const governor of governors) epochs.set(JSON.stringify({ workspaceId: "fresh-demo", sourceKind: governor.kind, sourceId: governor.id }), 1n);
    events.push({ id: createHash("md5").update("pun68-permission:fresh-demo:42").digest("hex"), workspaceId: "fresh-demo",
      type: "source-permission.changed", aggregateType: "SourcePermissionEpoch", aggregateId: "fresh-demo", status: "PENDING", attempts: 0,
      lockedAt: null, lockedBy: null, dispatchedAt: null, error: null, mcpOrigin: null, supportOriginUserId: null, supportGrantVersion: null,
      payload: { version: 1, governors } });
    return token;
  }
  return { db, begin, input, events, epochs, members, flags, assignments, changeTx: () => txId = "43" };
}
describe("exact fresh demo initialization", () => {
  it("settles only its actual unclaimed initialization notice and retains every applied epoch", async () => {
    const f = fixture(), token = await f.begin();
    const before = [...f.epochs];
    await expect(assertDemoWorkspaceDisconnected(f.db, "fresh-demo", f.input.userIds)).rejects.toThrow("asynchronous authority");
    await settleFreshDemoInitialization(f.db, token, f.input);
    expect(f.events).toEqual([]); expect([...f.epochs]).toEqual(before);
    await expect(assertDemoWorkspaceDisconnected(f.db, "fresh-demo", f.input.userIds)).resolves.toBeUndefined();
    await expect(settleFreshDemoInitialization(f.db, token, f.input)).rejects.toThrow("scope");
  });
  it.each(["copy", "other-client", "other-transaction", "existing"])("refuses invented or existing-workspace initialization: %s", async mode => {
    const f = fixture(), token = await f.begin();
    if (mode === "existing") await expect(createFreshDemoSeedWorkspace(f.db, { slug: "jnj-demo" })).rejects.toThrow("already exists");
    else {
      if (mode === "other-transaction") f.changeTx();
      await expect(settleFreshDemoInitialization(mode === "other-client" ? { ...f.db } : f.db,
        mode === "copy" ? { ...token } : token, f.input)).rejects.toThrow("scope");
    }
    expect(f.events).toHaveLength(1); expect(f.db.event.deleteMany).not.toHaveBeenCalled();
  });
  it.each(["id", "status", "attempts", "lockedAt", "lockedBy", "dispatchedAt", "mcpOrigin", "supportOriginUserId", "supportGrantVersion", "governor", "epoch", "extra-event", "jobs", "semantic", "lineage", "public-role", "foreign-assignment"])("retains unsafe initialization authority: %s", async field => {
    const f = fixture(), token = await f.begin();
    if (field === "governor") f.events[0].payload.governors.push({ kind: "AgentCredential", id: "unrelated" });
    else if (field === "epoch") f.epochs.clear();
    else if (field === "extra-event") f.events.push({ ...f.events[0], id: "unrelated" });
    else if (field === "jobs") f.db.workflowJob.count.mockResolvedValue(1);
    else if (field === "semantic") f.db.brainArticle.count.mockResolvedValue(1);
    else if (field === "lineage") f.db.artifactInputLineage.count.mockResolvedValue(1);
    else if (field === "public-role") f.members[0].role = "ADMIN";
    else if (field === "foreign-assignment") f.assignments[0].memberId = "foreign";
    else f.events[0][field] = field === "attempts" || field === "supportGrantVersion" ? 1 : field === "status" ? "DISPATCHED" : "unrelated";
    await expect(settleFreshDemoInitialization(f.db, token, f.input)).rejects.toThrow("initialization refused");
    expect(f.db.event.deleteMany).not.toHaveBeenCalled();
  });
});
