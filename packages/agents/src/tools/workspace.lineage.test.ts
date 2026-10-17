import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSourcePermissionEpochFixture } from "../../../domain/src/source-permission-epochs.test-fixture";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const rows: Record<string, any[]> = {};
  const timestamp = new Date("2026-10-01T09:00:00Z");
  const names = ["workspace", "user", "member", "action", "tension", "proposal", "goal", "circle", "role", "roleAssignment", "meeting", "document",
    "auditLog", "artifactInputLineage", "artifactInputSnapshot", "keyResult", "goalLink"];
  const relation = (kind: string, row: any, key: string) => {
    if (key === "user") return rows.user.find((user) => user.id === row.userId);
    if (key === "circle") return rows.circle.find((circle) => circle.id === row.circleId);
    if (key === "role") return rows.role.find((role) => role.id === row.roleId);
    if (key === "member" || key === "assigneeMember" || key === "raisedByMember" || key === "ownerMember") return rows.member.find((member) => member.id === row[key + "Id"]);
    if (key === "author") return rows.user.find((user) => user.id === row.authorUserId);
    if (key === "parentCircle") return rows.circle.find((circle) => circle.id === row.parentCircleId);
    return undefined;
  };
  const relatedKind = (key: string) => ({ user: "user", circle: "circle", role: "role", member: "member", assigneeMember: "member", raisedByMember: "member", ownerMember: "member", author: "user", parentCircle: "circle" } as Record<string, string>)[key];
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
    return value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value;
  });
  const project = (kind: string, row: any, args: any = {}): any => {
    if (!row) return null;
    let value = { ...row };
    for (const [key, request] of Object.entries(args.include ?? {}) as [string, any][]) {
      if (relatedKind(key)) value[key] = project(relatedKind(key), relation(kind, row, key), request === true ? {} : request);
      else if (key === "roleAssignments") value[key] = rows.roleAssignment.filter((assignment) => assignment.memberId === row.id && matches("roleAssignment", assignment, request.where)).map((assignment) => project("roleAssignment", assignment, request));
      else if (key === "roles") value[key] = rows.role.filter((role) => role.circleId === row.id && matches("role", role, request.where)).map((role) => project("role", role, request));
      else if (key === "assignedActions") value[key] = rows.action.filter((action) => action.assigneeMemberId === row.id && matches("action", action, request.where)).map((action) => project("action", action, request));
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
        .sort((left, right) => kind === "artifactInputLineage" ? right.revision - left.revision : Array.isArray(args.orderBy)
          ? right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id)
          : left.id.localeCompare(right.id))
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
vi.mock("../../../domain/src/auth", () => ({ requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }: any) => {
  const member = fixture.rows.member.find((row) => row.workspaceId === workspaceId && row.userId === actor.user.id && row.isActive);
  if (!member) throw Object.assign(new Error("Membership denied"), { status: 403, code: "FORBIDDEN" });
  return { id: member.id, role: member.role };
}), isGlobalOperator: () => false }));
vi.mock("../../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async (actor: any) => actor.user.id === "beta" ? ["PUBLIC", "FINANCE"] : ["PUBLIC"]) }));
vi.mock("../../../domain/src/role-onboarding", () => ({ closeRoleLifecycleForMember: vi.fn(), closeRoleLifecycleForCircleTree: vi.fn() }));
vi.mock("../../../domain/src/self-serve-ops", () => ({ maybeCaptureSelfServeSetupEmail: vi.fn() }));
import { captureArtifactInputProof, recordArtifactInputLineage, readableArtifactIds, type LineageKind } from "../../../domain/src/source-lineage";

const alpha = { kind: "user", user: { id: "alpha", email: "alpha@example.test", displayName: "Alpha" } } as AppActor;
const beta = { kind: "user", user: { id: "beta", email: "beta@example.test", displayName: "Beta" } } as AppActor;
const workspaceId = "ws-a";

async function known(kind: LineageKind, row: any, inputs: Array<{ kind: LineageKind; id: string }> = []) {
  await recordArtifactInputLineage({ tx: fixture.prisma, actor: beta, workspaceId: row.workspaceId ?? workspaceId,
    artifact: { kind, id: row.id }, content: row, origin: inputs.length ? "DERIVED" : "HUMAN_ORIGINAL", inputs,
    inheritedRoots: inputs.length ? await captureArtifactInputProof(beta, row.workspaceId ?? workspaceId, inputs, fixture.prisma) : undefined });
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
let epochFixture: ReturnType<typeof installSourcePermissionEpochFixture>;
beforeEach(() => { for (const kind of Object.keys(fixture.rows)) fixture.rows[kind] = []; vi.clearAllMocks();
  fixture.prisma.$queryRaw.mockReset().mockResolvedValue([]);
  fixture.prisma.$executeRaw.mockReset().mockResolvedValue(1);
  epochFixture = installSourcePermissionEpochFixture(fixture.prisma);
});
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../../domain/src/errors"), ...await import("../../../domain/src/auth"),
  ...await import("../../../domain/src/privacy"), ...await import("../../../domain/src/source-scoped-read"),
  ...await import("../../../domain/src/digest-lineage"),
  ...await import("../../../domain/src/circles"), ...await import("../../../domain/src/roles"),
  listGoals: vi.fn(async () => []),
}));
import { DigestReadRelease } from "../../../domain/src/digest-lineage";
import { getWorkspaceOverview, queryActions, queryTensions, queryProposals, queryOrgStructure } from "./workspace";

describe("workspace tools with committed current source receipts", () => {
  it("gates SQL-visible private-derived titles, bodies and totals for two users", async () => {
    const { privateSource } = await seed();
    for (const [table, kind] of [["tension", "Tension"], ["proposal", "Proposal"], ["goal", "Goal"]] as [string, LineageKind][]) {
      const original = add(table, { id: `${table}-visible`, workspaceId, title: "Visible title", bodyMd: "Visible body", authorUserId: "beta",
        isPrivate: false, status: table === "goal" ? "ACTIVE" : "OPEN", priority: 1, version: 1 });
      await known(kind, original);
      const restricted = add(table, { ...original, id: `${table}-restricted`, title: "Restricted title", bodyMd: "Restricted body" });
      await known(kind, restricted, [{ kind: "Action", id: privateSource.id }]);
      add(table, { ...original, id: `${table}-unknown`, title: "Unknown raw title", bodyMd: "Unknown raw body" });
    }
    const plain = await getWorkspaceOverview(workspaceId, alpha);
    expect(plain).toMatchObject({ memberCount: 2, circleCount: 1, openActions: 1, openTensions: 1, activeProposals: 1, activeGoals: 1 });
    const privileged = await getWorkspaceOverview(workspaceId, beta);
    expect(privileged).toMatchObject({ circleCount: 2, openActions: 2, openTensions: 2, activeProposals: 2, activeGoals: 2 });
    const outputs = await Promise.all([queryActions(workspaceId, undefined, undefined, undefined, alpha),
      queryTensions(workspaceId, undefined, undefined, undefined, alpha), queryProposals(workspaceId, undefined, alpha)]);
    expect(outputs.map((items) => items.length)).toEqual([1, 1, 1]);
    expect(JSON.stringify(outputs)).not.toMatch(/Restricted|Unknown|private body|Foreign workspace/);
  });

  it("replenishes hidden pages before ranking and the twenty-result limit", async () => {
    const { privateSource, publicAction } = await seed();
    for (let index = 0; index < 105; index++) await known("Action", add("action", { ...publicAction,
      id: `00-hidden-${String(index).padStart(3, "0")}`, title: "Hidden recent action", createdAt: new Date("2026-10-11") }), [{ kind: "Action", id: privateSource.id }]);
    for (let index = 0; index < 21; index++) await known("Action", add("action", { ...publicAction,
      id: `visible-${String(index).padStart(3, "0")}`, title: `Visible ${index}`, createdAt: new Date(Date.UTC(2026, 9, 2, 0, index)) }));
    const visible = await queryActions(workspaceId, "OPEN", undefined, undefined, alpha);
    expect(visible).toHaveLength(20); expect(visible[0].title).toBe("Visible 20"); expect(visible.at(-1)?.title).toBe("Visible 1");
    expect(visible.every((row) => row.title.startsWith("Visible"))).toBe(true);
    expect(fixture.prisma.action.findMany.mock.calls.some(([args]: any[]) => args.where.AND?.some((clause: any) => clause.OR?.some((cursor: any) => cursor.createdAt?.lt)))).toBe(true);
  });

  it("gates organizational circles, nested roles and assignee labels using real source ancestry", async () => {
    await seed();
    const publicProfile = fixture.rows.user.find((row) => row.id === "alpha");
    Object.assign(publicProfile, {
      avatarUrl: "https://synthetic.test/alpha.png", linkedinUrl: "https://synthetic.test/alpha-profile", websiteUrl: "https://synthetic.test/alpha",
    });
    expect(await captureArtifactInputProof(alpha, workspaceId, [{ kind: "User", id: publicProfile.id,
      snapshot: { email: publicProfile.email, displayName: publicProfile.displayName, avatarUrl: publicProfile.avatarUrl,
        linkedinUrl: publicProfile.linkedinUrl, websiteUrl: publicProfile.websiteUrl } }])).toEqual([
      expect.objectContaining({ kind: "User", id: "alpha" }),
    ]);
    const ordinary = await queryOrgStructure(workspaceId, alpha);
    expect(ordinary).toHaveLength(1); expect(ordinary[0].roles.map((role) => role.name)).toEqual(["Public role"]);
    expect(ordinary[0].roles[0].assignedMembers).toEqual(["Alpha"]);
    const privileged = await queryOrgStructure(workspaceId, beta);
    expect(privileged).toHaveLength(2); expect(privileged.find((circle) => circle.name === "Public circle")?.roles).toHaveLength(2);
    expect(JSON.stringify(ordinary)).not.toContain("Restricted");
  });

  it.each(["Action", "Tension", "Proposal"] as const)("withholds late-joined %s profile labels after that profile leaves the workspace", async (kind) => {
    const { publicAction } = await seed();
    Object.assign(fixture.rows.user.find((row) => row.id === "beta"), {
      avatarUrl: "https://synthetic.test/beta.png", linkedinUrl: "https://synthetic.test/beta-profile", websiteUrl: "https://synthetic.test/beta",
    });
    const table = kind.toLowerCase();
    const record = kind === "Action" ? publicAction : add(table, { ...publicAction, id: `visible-${table}`, raisedByMemberId: "member-beta" });
    record.assigneeMemberId = "member-beta";
    await known(kind, record);
    const query = () => kind === "Action" ? queryActions(workspaceId, "OPEN", undefined, record.id, alpha)
      : kind === "Tension" ? queryTensions(workspaceId, "OPEN", undefined, record.id, alpha) : queryProposals(workspaceId, "OPEN", alpha);
    expect((await query())[0]).toMatchObject({ author: "Beta" });
    fixture.rows.member.find((row) => row.id === "member-beta").isActive = false;
    fixture.rows.user.find((row) => row.id === "beta").displayName = "WITHDRAWN_PROFILE_SECRET";
    const privateProfile = fixture.rows.user.find((row) => row.id === "beta");
    expect(await readableArtifactIds(alpha, workspaceId, "User", [{ id: privateProfile.id, email: privateProfile.email, displayName: privateProfile.displayName, bio: privateProfile.bio }], fixture.prisma)).toEqual(new Set());
    const result = await query();
    expect(result).toHaveLength(1); expect(result[0].title).toBe("Visible action");
    expect(JSON.stringify(result)).not.toContain("WITHDRAWN_PROFILE_SECRET");
  });

  it("rechecks source privacy, archive and membership on every read and rejects another workspace", async () => {
    const { privateSource } = await seed();
    expect(await queryActions(workspaceId, undefined, undefined, "restricted-derived", beta)).toHaveLength(1);
    privateSource.archivedAt = fixture.timestamp;
    expect(await queryActions(workspaceId, undefined, undefined, "restricted-derived", beta)).toEqual([]);
    privateSource.archivedAt = null; privateSource.authorUserId = "alpha";
    expect(await queryActions(workspaceId, undefined, undefined, "restricted-derived", beta)).toEqual([]);
    await expect(getWorkspaceOverview("ws-b", alpha)).rejects.toMatchObject({ code: "FORBIDDEN" });
    fixture.rows.member.find((row) => row.userId === "beta" && row.workspaceId === workspaceId).isActive = false;
    await expect(queryOrgStructure(workspaceId, beta)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

it.each(["head", "epoch", "caller"] as const)("fences original selected work-item %s through later pages", async mode => {
  const { publicAction } = await seed();
  const top = add("action", { ...publicAction, id: "top-original", createdAt: new Date("2026-10-12") });
  await known("Action", top);
  for (let i = 0; i < 101; i++) add("action", { ...publicAction, id: `unproved-${i}`, createdAt: new Date("2026-10-11") });
  const load = fixture.prisma.action.findMany.getMockImplementation(); let changed = false;
  fixture.prisma.action.findMany.mockImplementation(async (args: { where: { AND?: Array<{ OR?: Array<{ createdAt?: { lt?: Date } }> }> } }) => {
    if (!changed && args.where.AND?.some(clause => clause.OR?.some(cursor => cursor.createdAt?.lt))) {
      changed = true;
      if (mode === "head") await known("Action", top);
      if (mode === "epoch") epochFixture.bump(workspaceId, "Action", top.id);
      if (mode === "caller") fixture.rows.member.find(row => row.id === "member-alpha").isActive = false;
    }
    return load(args);
  });
  await expect(queryActions(workspaceId, "OPEN", undefined, undefined, alpha)).rejects.toMatchObject({ code: mode === "caller" ? "FORBIDDEN" : "SOURCE_CHANGED" });
  expect(changed).toBe(true);
});

it("bounds overview raw candidates and reports incomplete counts instead of global zeros", async () => {
  const { publicAction } = await seed();
  for (let index = 0; index < 501; index++) add("action", { ...publicAction, id: `a-unknown-${String(index).padStart(4, "0")}` });
  const result = await getWorkspaceOverview(workspaceId, alpha);
  expect(result).toMatchObject({ openActions: null,
    countWindows: { openActions: { count: 0, complete: false, scope: "WINDOW" }, memberCount: { count: 2, complete: true } } });
  const pages = fixture.prisma.action.findMany.mock.calls.filter(([args]: any[]) => args.take === 100);
  expect(pages).toHaveLength(2);
});

it.each(["head", "caller-epoch"] as const)("seals all overview families against late %s changes", async mode => {
  await seed();
  const finish = DigestReadRelease.prototype.finish;
  const hook = vi.spyOn(DigestReadRelease.prototype, "finish").mockImplementation(function<T>(this: DigestReadRelease, value: T) {
    if (mode === "head") {
      const original = fixture.rows.artifactInputLineage.find(row => row.artifactType === "Action" && row.artifactId === "visible-action");
      fixture.rows.artifactInputLineage.push({ ...original, id: "late-identical-head", revision: original.revision + 1 });
    } else epochFixture.bump(workspaceId, "MemberUserPolicy", "alpha");
    return finish.call(this, value) as Promise<T>;
  });
  try {
    await expect(getWorkspaceOverview(workspaceId, alpha)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(hook).toHaveBeenCalledTimes(1);
  } finally { hook.mockRestore(); }
});

it("reports a healthy large overview as an admitted lower bound without exhausting its corpus", async () => {
  const { publicAction } = await seed();
  for (let index = 0; index < 201; index++) await known("Action", add("action", {
    ...publicAction, id: `a-proven-${String(index).padStart(4, "0")}`,
  }));
  const result = await getWorkspaceOverview(workspaceId, alpha);
  expect(result).toMatchObject({ openActions: null, countWindows: {
    openActions: { count: 200, complete: false, scope: "WINDOW" },
  } });
  expect(fixture.prisma.action.findMany.mock.calls.filter(([args]: any[]) => args.take === 100)).toHaveLength(2);
});
