import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known } from "../../../../../../../packages/agents/src/agents/model-consumer.test-fixture";

vi.mock("@corgtex/shared", async () => ({
  ...await import("../../../../../../../packages/shared/src/mcp-context"), prisma: fixture.prisma,
}));
vi.mock("../../../../../../../packages/domain/src/auth", () => ({
  requireWorkspaceMembership: fixture.membership,
}));
vi.mock("../../../../../../../packages/domain/src/brain-access", () => ({
  resolveKnowledgeAccessDomains: async (actor: any) => fixture.domains.get(actor.user.id) ?? [],
}));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../../../../../../packages/domain/src/digest-lineage"),
  ...await import("../../../../../../../packages/domain/src/member-identity"),
  ...await import("../../../../../../../packages/domain/src/role-assignment-activity"),
  requireWorkspaceMembership: fixture.membership,
}));
import { loadRoleDirectoryData } from "./role-directory";

function related(row: any, key: string) {
  const table = key === "user" ? "user" : key;
  return fixture.rows[table]?.find((candidate) => candidate.id === row[`${key}Id`]);
}
function matches(row: any, where: any): boolean {
  return Boolean(row) && Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every((part: any) => matches(row, part));
    if (key === "NOT") return !(Array.isArray(value) ? value : [value]).some((part: any) => matches(row, part));
    if (key === "OR") return value.some((part: any) => matches(row, part));
    if (["role", "circle", "member", "user"].includes(key)) return matches(related(row, key), value);
    if (value && typeof value === "object" && "startsWith" in value) return String(row[key]).toLowerCase().startsWith(value.startsWith.toLowerCase());
    if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
    if (value && typeof value === "object" && "not" in value) return row[key] !== value.not;
    return row[key] === value;
  });
}
function project(row: any, args: any = {}): any {
  if (!row) return null;
  const result = { ...row };
  for (const [key, request] of Object.entries(args.include ?? {}) as [string, any][]) {
    if (key === "assignments") result.assignments = fixture.rows.roleAssignment.filter((assignment) => assignment.roleId === row.id)
      .map((assignment) => project(assignment, request));
    else result[key] = project(related(row, key), request === true ? {} : request);
  }
  return args.select ? Object.fromEntries(Object.keys(args.select).map((key) => [key, result[key]])) : result;
}
beforeEach(async () => {
  await resetFixture();
  const query = fixture.prisma.$queryRaw.getMockImplementation()!;
  fixture.prisma.$queryRaw.mockImplementation(async (sql: any) => {
    if (sql.sql?.includes('CROSS JOIN LATERAL') && sql.sql.includes('"ArtifactInputLineage"')) {
      const values = sql.values as unknown[];
      const heads = new Map<string, any>();
      for (const head of fixture.rows.artifactInputLineage) if (values.includes(head.workspaceId)
        && values.includes(head.artifactType) && values.includes(head.artifactId)) {
        const key = `${head.artifactType}:${head.artifactId}`;
        if (!heads.has(key) || heads.get(key).revision < head.revision) heads.set(key, head);
      }
      return [...heads.values()];
    }
    return query(sql);
  });
  for (const name of ["role", "circle", "roleAssignment", "roleOnboardingSession"]) fixture.rows[name] = [];
  for (const name of ["role", "circle", "member", "roleAssignment", "roleOnboardingSession"]) {
    fixture.prisma[name] = {
      findFirst: vi.fn(async (args: any) => project(fixture.rows[name].find((row) => matches(row, args.where)), args)),
      findMany: vi.fn(async (args: any) => fixture.rows[name].filter((row) => matches(row, args.where)).map((row) => project(row, args))),
    };
  }
});
async function setup(privateCircle = false, privateAssignment = false) {
  const input = fixture.add("brainSource", { id: "finance-source", workspaceId, title: "PRIVATE FINANCE SOURCE", content: "private", sourceType: "ARTICLE",
    accessDomain: "FINANCE", channel: "manual", tier: "reference", archivedAt: null, informationCategory: "GENERAL", authorMemberId: "member-beta" });
  await known("BrainSource", input);
  const circle = fixture.add("circle", { id: "circle", workspaceId, name: privateCircle ? "PRIVATE CIRCLE CANARY" : "Public circle", sortOrder: 0, archivedAt: null });
  await known("Circle", circle, privateCircle ? [{ kind: "BrainSource", id: input.id }] : []);
  const role = fixture.add("role", { id: "role", circleId: circle.id, name: "Public role", purposeMd: "purpose", accountabilities: [], artifacts: [],
    coreRoleType: null, sortOrder: 0, archivedAt: null });
  await known("Role", role);
  const assignment = fixture.add("roleAssignment", { id: "assignment", roleId: role.id, memberId: "member-beta", assignedAt: fixture.timestamp,
    expiresAt: null, transferReason: privateAssignment ? "PRIVATE ASSIGNMENT CANARY" : null });
  await known("RoleAssignment", assignment, privateAssignment ? [{ kind: "BrainSource", id: input.id }] : []);
  return { role, circle, input, assignment };
}
describe("role directory source permission release", () => {
  it("keeps an admitted role while omitting its withheld circle, including selector props", async () => {
    await setup(true, false);
    const data = await loadRoleDirectoryData(alpha, workspaceId, { roleIds: ["role"] });
    expect(data.roles.map((role) => role.id)).toEqual(["role"]);
    expect(data.roles[0].circle).toBeNull();
    expect(data.circles).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("PRIVATE");
  });
  it("omits denied assignments and denied member/profile options from serialized data", async () => {
    await setup(false, true);
    const user = fixture.rows.user.find((row) => row.id === "beta");
    user.displayName = "PRIVATE MEMBER CANARY";
    await known("User", user, [{ kind: "BrainSource", id: "finance-source" }]);
    const data = await loadRoleDirectoryData(alpha, workspaceId);
    expect(data.roles[0].assignments).toEqual([]);
    expect(data.members.map((member) => member.id)).toEqual(["member-alpha"]);
    expect(JSON.stringify(data)).not.toContain("PRIVATE");
  });
  it("exposes readable assignment and circle metadata to its authorized actor", async () => {
    await setup(true, true);
    const data = await loadRoleDirectoryData(beta, workspaceId);
    expect(data.roles[0].circle?.name).toBe("PRIVATE CIRCLE CANARY");
    expect(data.roles[0].assignments.map((assignment) => assignment.id)).toEqual(["assignment"]);
  });
  it("filters private onboarding sessions before exposing conversation IDs", async () => {
    await setup();
    const session = fixture.add("roleOnboardingSession", { id: "session", workspaceId, roleId: "role", memberId: "member-beta",
      conversationId: "PRIVATE CONVERSATION CANARY", status: "ACTIVE", startedAt: fixture.timestamp, completedAt: null, dismissedAt: null });
    await known("RoleOnboardingSession", session);
    expect((await loadRoleDirectoryData(alpha, workspaceId)).onboardingByRoleMember.size).toBe(0);
    expect((await loadRoleDirectoryData(beta, workspaceId)).onboardingByRoleMember.size).toBe(1);
  });
  it("does not let an admitted basic or sibling profile certify a stale full projection", async () => {
    const f = await setup();
    const user = fixture.rows.user.find(row => row.id === "beta");
    user.bio = "Current biography"; await known("User", user);
    const role = fixture.add("role", {...f.role, id: "role-second", name: "Second role"});
    await known("Role", role);
    const assignment = fixture.add("roleAssignment", {...f.assignment, id: "assignment-second", roleId: role.id});
    await known("RoleAssignment", assignment);
    const findMany = fixture.prisma.role.findMany.getMockImplementation()!;
    fixture.prisma.role.findMany.mockImplementation(async (args: Prisma.RoleFindManyArgs) => {
      const rows = await findMany(args);
      if (args.include?.assignments) rows[0].assignments[0].member.user.bio = "STALE BIO CANARY";
      return rows;
    });
    const data = await loadRoleDirectoryData(beta, workspaceId);
    expect(data.roles.find(row => row.id === f.role.id)?.assignments).toEqual([]);
    expect(data.roles.find(row => row.id === role.id)?.assignments[0].member.user?.bio).toBe("Current biography");
    expect(data.members.map(member => member.id)).toContain("member-beta");
    expect(JSON.stringify(data)).not.toContain("STALE BIO CANARY");
  });
  it("rejects a revocation after original capture at final release", async () => {
    await setup();
    const findMany = fixture.prisma.roleOnboardingSession.findMany;
    findMany.mockImplementation(async () => []);
    const { DigestReadRelease } = await import("../../../../../../../packages/domain/src/digest-lineage");
    const original = DigestReadRelease.prototype.finish;
    const spy = vi.spyOn(DigestReadRelease.prototype, "finish").mockImplementation(function(this: InstanceType<typeof DigestReadRelease>, value: unknown) {
      fixture.rows.member.find((row) => row.userId === "alpha").isActive = false;
      return original.call(this, value);
    });
    try { await expect(loadRoleDirectoryData(alpha, workspaceId)).rejects.toBeDefined(); }
    finally { spy.mockRestore(); }
  });
});
