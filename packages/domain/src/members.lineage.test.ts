import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const rows: Record<string, any[]> = {};
  const timestamp = new Date("2026-10-01T09:00:00Z");
  const names = ["workspace", "user", "member", "action", "tension", "proposal", "goal", "circle", "role", "roleAssignment", "meeting", "document",
    "auditLog", "artifactInputLineage", "artifactInputSnapshot", "keyResult", "goalLink", "adviceProcess", "actionChecklistItem", "tensionUpvote"];
  const relation = (kind: string, row: any, key: string) => {
    if (key === "user") return rows.user.find((user) => user.id === row.userId);
    if (key === "circle") return rows.circle.find((circle) => circle.id === row.circleId);
    if (key === "role") return rows.role.find((role) => role.id === row.roleId);
    if (key === "member" || key === "assigneeMember" || key === "raisedByMember" || key === "ownerMember") return rows.member.find((member) => member.id === row[key + "Id"]);
    if (key === "author") return rows.user.find((user) => user.id === row.authorUserId);
    if (key === "proposal") return rows.proposal.find((proposal) => proposal.id === row.proposalId);
    if (key === "tension") return rows.tension.find((tension) => tension.id === row.tensionId);
    if (key === "parentCircle") return rows.circle.find((circle) => circle.id === row.parentCircleId);
    return undefined;
  };
  const relatedKind = (key: string) => ({ user: "user", circle: "circle", role: "role", member: "member", assigneeMember: "member", raisedByMember: "member", ownerMember: "member", author: "user", parentCircle: "circle", proposal: "proposal", tension: "tension" } as Record<string, string>)[key];
  const matches = (kind: string, row: any, where: any): boolean => Boolean(row) && Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every((clause: any) => matches(kind, row, clause));
    if (key === "OR") return value.some((clause: any) => matches(kind, row, clause));
    if (key === "NOT") return !matches(kind, row, value);
    if (relatedKind(key)) return matches(relatedKind(key), relation(kind, row, key), value);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("gt" in value) return row[key] > value.gt;
      if ("lt" in value) return row[key] < value.lt;
      if ("in" in value) return value.in.includes(row[key]);
      if ("notIn" in value) return !value.notIn.includes(row[key]);
      if ("not" in value) return row[key] !== value.not;
      if ("has" in value) return row[key]?.includes(value.has);
      if (key === "memberships") return rows.member.some((member) => member.userId === row.id && matches("member", member, value.some));
      throw new Error(`Unsupported synthetic predicate: ${kind}.${key}`);
    }
    return value instanceof Date ? row[key] instanceof Date && row[key].getTime() === value.getTime() : row[key] === value;
  });
  const project = (kind: string, row: any, args: any = {}): any => {
    if (!row) return null;
    let value = { ...row };
    for (const [key, request] of Object.entries(args.include ?? {}) as [string, any][]) {
      if (relatedKind(key)) value[key] = project(relatedKind(key), relation(kind, row, key), request === true ? {} : request);
      else if (key === "roleAssignments") value[key] = rows.roleAssignment.filter((assignment) => assignment.memberId === row.id && matches("roleAssignment", assignment, request.where)).map((assignment) => project("roleAssignment", assignment, request));
      else if (key === "roles") value[key] = rows.role.filter((role) => role.circleId === row.id && matches("role", role, request.where)).map((role) => project("role", role, request));
      else if (key === "assignedActions") value[key] = rows.action.filter((action) => action.assigneeMemberId === row.id && matches("action", action, request.where)).map((action) => project("action", action, request));
      else if (key === "upvotes") value[key] = rows.tensionUpvote.filter((vote) => vote.tensionId === row.id).map((vote) => project("tensionUpvote", vote, request === true ? {} : request));
      else if (["keyResults", "links"].includes(key)) value[key] = [];
      else throw new Error(`Unsupported synthetic include: ${kind}.${key}`);
    }
    if (args.select) value = Object.fromEntries(Object.entries(args.select).map(([key, request]: [string, any]) => [key,
      relatedKind(key) ? project(relatedKind(key), relation(kind, row, key), request) : value[key]]));
    return value;
  };
  const prisma: any = { $queryRaw: vi.fn(async () => []), $executeRaw: vi.fn(async () => 1) };
  for (const kind of names) {
    rows[kind] = [];
    prisma[kind] = {
      findFirst: vi.fn(async (args: any) => { const found = rows[kind].filter((row) => matches(kind, row, args.where));
        return project(kind, kind === "artifactInputLineage" ? found.at(-1) : found[0], args); }),
      findUnique: vi.fn(async (args: any) => project(kind, rows[kind].find((row) => matches(kind, row, args.where)), args)),
      findMany: vi.fn(async (args: any) => rows[kind].filter((row) => matches(kind, row, args.where))
        .sort((left, right) => {
          if (kind === "artifactInputLineage") return right.revision - left.revision;
          for (const order of Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy ?? {id: "asc"}]) {
            for (const [field, direction] of Object.entries(order)) {
              const difference = left[field] instanceof Date ? left[field].getTime() - right[field].getTime() : String(left[field]).localeCompare(String(right[field]));
              if (difference) return direction === "desc" ? -difference : difference;
            }
          }
          return 0;
        })
        .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows[kind].length)).map((row) => project(kind, row, args))),
      count: vi.fn(async (args: any) => rows[kind].filter((row) => matches(kind, row, args.where)).length),
      create: vi.fn(async ({ data }: any) => { const row = { id: `${kind}-${rows[kind].length + 1}`, createdAt: timestamp, updatedAt: timestamp, ...data };
        rows[kind].push(row); return { ...row }; }),
    };
  }
  prisma.$transaction = vi.fn(async (run: any) => run(prisma));
  return { prisma, rows, timestamp };
});
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, env: { APP_URL: "https://synthetic.test", RESEND_API_KEY: "", SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 1 },
  hashPassword: vi.fn(), randomOpaqueToken: vi.fn(), sendEmail: vi.fn(), sha256: vi.fn(), toInputJson: (value: unknown) => value,
  parseAllowedWorkspaceIds: () => new Set<string>(), setSupportAuthorizationActor: vi.fn(), getMcpOrigin: () => undefined }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }: any) => {
  const member = fixture.rows.member.find((row) => row.workspaceId === workspaceId && row.userId === actor.user.id && row.isActive);
  if (!member) throw Object.assign(new Error("Membership denied"), { status: 403, code: "FORBIDDEN" });
  return { id: member.id, role: member.role };
}), isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async (actor: any) => actor.user.id === "beta" ? ["PUBLIC", "FINANCE"] : ["PUBLIC"]) }));
vi.mock("./role-onboarding", () => ({ closeRoleLifecycleForMember: vi.fn(), closeRoleLifecycleForCircleTree: vi.fn() }));
vi.mock("./self-serve-ops", () => ({ maybeCaptureSelfServeSetupEmail: vi.fn() }));
vi.mock("./audit-trail", () => ({ recordAudit: vi.fn() }));
vi.mock("./notifications", () => ({ createNotificationIntent: vi.fn() }));
import { recordArtifactInputLineage, type LineageKind } from "./source-lineage";

const alpha = { kind: "user", user: { id: "alpha", email: "alpha@example.test", displayName: "Alpha" } } as AppActor;
const beta = { kind: "user", user: { id: "beta", email: "beta@example.test", displayName: "Beta" } } as AppActor;
const workspaceId = "ws-a";

async function known(kind: LineageKind, row: any, inputs: Array<{ kind: LineageKind; id: string }> = []) {
  await recordArtifactInputLineage({ tx: fixture.prisma, actor: beta, workspaceId: row.workspaceId ?? workspaceId,
    artifact: { kind, id: row.id }, content: row, origin: inputs.length ? "DERIVED" : "HUMAN_ORIGINAL", inputs });
}
function add(kind: string, values: any) {
  const row = { archivedAt: null, createdAt: fixture.timestamp, updatedAt: fixture.timestamp, ...values }; fixture.rows[kind].push(row); return row;
}
async function seed() {
  add("user", { id: "alpha", email: "alpha@example.test", displayName: "Alpha", bio: null });
  add("user", { id: "beta", email: "beta@example.test", displayName: "Beta", bio: null });
  add("workspace", { id: workspaceId, name: "First workspace" }); add("workspace", { id: "ws-b", name: "Other workspace" });
  add("member", { id: "member-alpha", workspaceId, userId: "alpha", isActive: true, role: "CONTRIBUTOR", joinedAt: fixture.timestamp });
  add("member", { id: "member-beta", workspaceId, userId: "beta", isActive: true, role: "CONTRIBUTOR", joinedAt: fixture.timestamp });
  add("member", { id: "member-beta-b", workspaceId: "ws-b", userId: "beta", isActive: true, role: "CONTRIBUTOR", joinedAt: fixture.timestamp });
  const privateSource = add("action", { id: "private-input", workspaceId, title: "Beta private input", bodyMd: "Beta private body",
    authorUserId: "beta", assigneeMemberId: "member-beta", isPrivate: true, status: "DRAFT", version: 1, dueAt: null });
  await known("Action", privateSource);
  const publicCircle = add("circle", { id: "circle-public", workspaceId, name: "Public circle", purposeMd: "Public purpose", parentCircleId: null, sortOrder: 0 });
  const privateCircle = add("circle", { id: "circle-restricted", workspaceId, name: "Restricted circle", purposeMd: "Restricted purpose", parentCircleId: null, sortOrder: 1 });
  await known("Circle", publicCircle); await known("Circle", privateCircle, [{ kind: "Action", id: privateSource.id }]);
  const publicRole = add("role", { id: "role-public", circleId: publicCircle.id, name: "Public role", purposeMd: "Public role purpose", sortOrder: 0 });
  const privateRole = add("role", { id: "role-restricted", circleId: publicCircle.id, name: "Restricted role", purposeMd: "Restricted role purpose", sortOrder: 1 });
  await known("Role", publicRole); await known("Role", privateRole, [{ kind: "Action", id: privateSource.id }]);
  add("roleAssignment", { id: "assignment-public", memberId: "member-alpha", roleId: publicRole.id, assignedAt: fixture.timestamp, expiresAt: null });
  add("roleAssignment", { id: "assignment-restricted", memberId: "member-alpha", roleId: privateRole.id, assignedAt: fixture.timestamp, expiresAt: null });
  const publicAction = add("action", { id: "visible-action", workspaceId, title: "Visible action", bodyMd: "Public body", authorUserId: "beta", assigneeMemberId: "member-alpha", isPrivate: false, status: "OPEN", dueAt: null, version: 1 });
  const derivedAction = add("action", { ...publicAction, id: "restricted-derived", title: "Restricted derived", bodyMd: "Restricted copied body" });
  await known("Action", publicAction); await known("Action", derivedAction, [{ kind: "Action", id: privateSource.id }]);
  add("action", { ...publicAction, id: "unknown-legacy", title: "Unknown legacy", bodyMd: "Unknown private history" });
  add("action", { ...publicAction, id: "foreign-action", workspaceId: "ws-b", title: "Foreign workspace body" });
  return { privateSource, publicAction, derivedAction, publicCircle, privateCircle, publicRole, privateRole };
}
beforeEach(() => {
  for (const kind of Object.keys(fixture.rows)) fixture.rows[kind] = [];
  vi.clearAllMocks();
  fixture.prisma.$executeRaw.mockReset().mockResolvedValue(1);
  fixture.prisma.$queryRaw.mockReset().mockResolvedValue([]);
  installSourcePermissionEpochFixture(fixture.prisma);
});
import { getMemberProfile, listMembersEnriched } from "./members";

describe("member readers with current source receipts", () => {
  it("withholds assigned private bodies, public copies of private inputs, unknown lineage and historical audit payloads", async () => {
    const { publicAction } = await seed();
    const legacyPrivate = add("action", { ...publicAction, id: "legacy-private-open", isPrivate: true, title: "Legacy private action", bodyMd: "Legacy private body" });
    await known("Action", legacyPrivate);
    add("auditLog", { id: "audit-visible", workspaceId, actorUserId: "alpha", entityType: "Action", entityId: publicAction.id, action: "action.updated", meta: { bodyMd: "Old private audit copy" } });
    add("auditLog", { id: "audit-hidden", workspaceId, actorUserId: "alpha", entityType: "Action", entityId: "restricted-derived", action: "action.updated", meta: { title: "Restricted audit title" } });
    const result = await getMemberProfile(alpha, workspaceId, "member-alpha");
    expect(result.member.assignedActions.map((row) => row.id)).toEqual([publicAction.id]);
    expect(result.member.assignedActions[0].bodyMd).toBe("Public body");
    expect(result.recentActivity).toHaveLength(1); expect(result.recentActivity[0].meta).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/Restricted|Unknown|Legacy private|Old private audit|Foreign workspace/);
    const privileged = await getMemberProfile(beta, workspaceId, "member-alpha");
    expect(privileged.member.assignedActions.map((row) => row.id)).toContain("restricted-derived");
  });

  it("filters nested assignment counts and role names by every source and the live circle envelope", async () => {
    const { publicCircle, privateSource } = await seed();
    expect((await listMembersEnriched(alpha, workspaceId)).find((row) => row.id === "member-alpha")?.roleAssignments.map((row) => row.role.name)).toEqual(["Public role"]);
    expect((await listMembersEnriched(beta, workspaceId)).find((row) => row.id === "member-alpha")?.roleAssignments).toHaveLength(2);
    privateSource.bodyMd = "Changed private input";
    expect((await listMembersEnriched(beta, workspaceId)).find((row) => row.id === "member-alpha")?.roleAssignments).toHaveLength(1);
    publicCircle.archivedAt = fixture.timestamp;
    expect((await listMembersEnriched(alpha, workspaceId)).find((row) => row.id === "member-alpha")?.roleAssignments).toHaveLength(0);
  });

  it("filters before sampling so a hidden first page cannot crowd out five visible assigned actions", async () => {
    const { privateSource, publicAction } = await seed();
    for (let index = 0; index < 105; index++) {
      const row = add("action", { ...publicAction, id: `00-hidden-${String(index).padStart(3, "0")}`, title: "Hidden newest", bodyMd: "Hidden newest body", createdAt: new Date("2026-10-11") });
      await known("Action", row, [{ kind: "Action", id: privateSource.id }]);
    }
    for (let index = 0; index < 5; index++) await known("Action", add("action", { ...publicAction, id: `visible-${index}`, title: `Visible ${index}` }));
    const result = await getMemberProfile(alpha, workspaceId, "member-alpha");
    expect(result.member.assignedActions).toHaveLength(5);
    expect(result.member.assignedActions.every((row) => row.title.startsWith("Visible"))).toBe(true);
    const pages = fixture.prisma.action.findMany.mock.calls.map(([args]: any[]) => args);
    expect(pages.some((page: any) => page.where.AND?.some((clause: any) => clause.OR?.some((condition: any) => condition.id?.lt)))).toBe(true);
  });

  it("replenishes recent audit references and rejects selected content changed during later audit reads", async () => {
    const {publicAction, privateSource} = await seed();
    for (let i = 0; i < 101; i++) add("auditLog", {id: `hidden-audit-${String(i).padStart(3, "0")}`, workspaceId,
      actorUserId: "alpha", entityType: "Action", entityId: privateSource.id, action: "action.updated", createdAt: new Date("2026-10-12")});
    add("auditLog", {id: "visible-audit", workspaceId, actorUserId: "alpha", entityType: "Action", entityId: publicAction.id,
      action: "action.updated", meta: {private: "never deliver"}, createdAt: new Date("2026-10-01")});
    const profile = await getMemberProfile(alpha, workspaceId, "member-alpha");
    expect(profile.recentActivity.map(row => row.id)).toEqual(["visible-audit"]);
    expect(profile.recentActivity[0].meta).toBeNull();
    expect(fixture.prisma.auditLog.findMany).toHaveBeenCalledTimes(2);
    const query = fixture.prisma.auditLog.findMany.getMockImplementation()!;
    fixture.prisma.auditLog.findMany.mockImplementationOnce(async (args: any) => {
      publicAction.bodyMd = "Changed after assigned-action admission";
      return query(args);
    });
    await expect(getMemberProfile(alpha, workspaceId, "member-alpha")).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  });

  it.each(["role", "circle", "caller"])("does not release profile joins after late %s withdrawal", async kind => {
    const {publicRole, publicCircle} = await seed();
    // Keep all recent collections empty, so the profile itself supplies the fence.
    fixture.rows.action = []; fixture.rows.roleAssignment = kind === "caller" ? [] : fixture.rows.roleAssignment;
    const query = fixture.prisma.auditLog.findMany.getMockImplementation()!;
    fixture.prisma.auditLog.findMany.mockImplementationOnce(async (args: any) => {
      if (kind === "role") publicRole.archivedAt = new Date();
      else if (kind === "circle") publicCircle.archivedAt = new Date();
      else fixture.rows.member.find(row => row.id === "member-alpha").isActive = false;
      return query(args);
    });
    await expect(getMemberProfile(alpha, workspaceId, "member-alpha")).rejects.toMatchObject({code: kind === "caller" ? "FORBIDDEN" : "SOURCE_CHANGED"});
  });

  it("loads only recent bounded pages even with over five thousand lifetime records", async () => {
    const {publicAction} = await seed();
    for (let index = 0; index < 5001; index++) add("action", {...publicAction, id: `old-${index}`, createdAt: new Date("2025-01-01"), title: "Old unproven"});
    const expected: string[] = [];
    for (let index = 0; index < 5; index++) {
      const row = add("action", {...publicAction, id: `new-${index}`, createdAt: new Date("2026-10-12")});
      await known("Action", row); expected.unshift(row.id);
    }
    const result = await getMemberProfile(alpha, workspaceId, "member-alpha");
    expect(result.member.assignedActions.map(row => row.id)).toEqual(expected);
    expect(fixture.prisma.action.findMany).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.action.findMany.mock.calls[0][0]).toMatchObject({take: 100, orderBy: [{createdAt: "desc"}, {id: "desc"}]});
  });

  it("rejects other workspace profiles and reacts immediately to membership loss", async () => {
    await seed();
    await expect(getMemberProfile(alpha, "ws-b", "member-beta-b")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getMemberProfile(beta, workspaceId, "member-beta-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixture.rows.member.find((row) => row.userId === "alpha").isActive = false;
    await expect(listMembersEnriched(alpha, workspaceId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("independently gates direct public Action/Tension joins and votes with real current source receipts", async () => {
    const { publicAction, privateCircle } = await seed();
    publicAction.assigneeMemberId = "member-beta"; publicAction.circleId = privateCircle.id;
    await known("Action", publicAction);
    const rawWinner = add("tension", { ...publicAction, id: "raw-winner", raisedByMemberId: "member-beta", priority: 1,
      createdAt: new Date("2026-10-12") });
    const safeWinner = add("tension", { ...publicAction, id: "safe-winner", raisedByMemberId: "member-alpha", priority: 1,
      createdAt: new Date("2026-10-11") });
    await known("Tension", rawWinner); await known("Tension", safeWinner);
    add("tensionUpvote", { id: "withdrawn-vote-1", tensionId: rawWinner.id, userId: "beta" });
    add("tensionUpvote", { id: "permitted-vote", tensionId: safeWinner.id, userId: "alpha" });
    const { listActions, getAction } = await import("./actions");
    const { listTensions, getTension } = await import("./tensions");
    expect((await getAction(beta, { workspaceId, actionId: publicAction.id })).circle?.name).toBe("Restricted circle");
    expect((await getTension(alpha, { workspaceId, tensionId: rawWinner.id })).upvotes).toHaveLength(1);
    fixture.rows.member.find((member) => member.id === "member-beta").isActive = false;
    fixture.rows.user.find((user) => user.id === "beta").displayName = "WITHDRAWN_LABEL";
    const detail = await getAction(alpha, { workspaceId, actionId: publicAction.id });
    const page = await listActions(alpha, workspaceId);
    for (const record of [detail, ...page.items]) {
      expect(record).toMatchObject({ title: "Visible action", bodyMd: "Public body", authorUserId: null,
        author: { id: "", email: "", displayName: null }, circleId: null, circle: null, assigneeMemberId: null, assigneeMember: null });
      expect(JSON.stringify(record)).not.toMatch(/WITHDRAWN_LABEL|Restricted circle/);
    }
    const tensionDetail = await getTension(alpha, { workspaceId, tensionId: rawWinner.id });
    expect(tensionDetail).toMatchObject({ upvotes: [], raisedByMemberId: null, raisedByMember: null, author: { displayName: null }, circle: null });
    const ranked = await listTensions(alpha, workspaceId, { take: 1 });
    expect(ranked.total).toBe(2); expect(ranked.items[0].id).toBe(safeWinner.id);
    expect(ranked.items[0].upvotes.map((vote) => vote.id)).toEqual(["permitted-vote"]);
    await expect(getAction(alpha, { workspaceId: "ws-b", actionId: publicAction.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
