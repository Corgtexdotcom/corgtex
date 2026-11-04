import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "../../../domain/src/errors";

const {
  listGoalsMock, membershipMock, findManyTensionsMock, findManyActionsMock,
  findManyProposalsMock, tensionCountMock, actionCountMock, proposalCountMock,
  goalCountMock, memberCountMock, findManyMembersMock, circleCountMock, findManyGoalsMock, findManyCirclesMock, captureProofMock,
} = vi.hoisted(() => ({
  captureProofMock: vi.fn(),
  listGoalsMock: vi.fn(),
  membershipMock: vi.fn(),
  findManyTensionsMock: vi.fn(),
  findManyActionsMock: vi.fn(),
  findManyProposalsMock: vi.fn(),
  tensionCountMock: vi.fn(),
  actionCountMock: vi.fn(),
  proposalCountMock: vi.fn(),
  findManyGoalsMock: vi.fn(), findManyCirclesMock: vi.fn(),
  goalCountMock: vi.fn(),
  memberCountMock: vi.fn(),
  findManyMembersMock: vi.fn(),
  circleCountMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    tension: { findMany: findManyTensionsMock, count: tensionCountMock },
    action: { findMany: findManyActionsMock, count: actionCountMock },
    proposal: { findMany: findManyProposalsMock, count: proposalCountMock },
    goal: { count: goalCountMock, findMany: findManyGoalsMock },
    member: { count: memberCountMock, findMany: findManyMembersMock },
    circle: { count: circleCountMock, findMany: findManyCirclesMock },
  },
}));

vi.mock("@corgtex/domain", async () => ({
  ...await import("../../../domain/src/agent-operation-capabilities"),
  requireWorkspaceOperation: vi.fn(async (params: { actor: AppActor; operation: string }) => {
    const { requireAgentOperation } = await import("../../../domain/src/agent-operation-capabilities");
    requireAgentOperation(params.actor, params.operation);
    return null;
  }),
  ...await import("../../../domain/src/errors"),
  ...await import("../../../domain/src/privacy"),
  ...await import("../../../domain/src/source-scoped-read"),
  ...await import("../../../domain/src/digest-lineage"),
  listGoals: listGoalsMock,
  requireWorkspaceMembership: membershipMock,
}));

vi.mock("../../../domain/src/auth", () => ({requireWorkspaceMembership: membershipMock}));
vi.mock("../../../domain/src/source-lineage", async importOriginal => ({
  mergeLineageInputRoot: (await importOriginal<typeof import("../../../domain/src/source-lineage")>()).mergeLineageInputRoot,
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({value: await read(), heads: new Map()}),
  withArtifactCountReleaseSnapshot: async (_actor: unknown, _ws: string, _roots: unknown, remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => {await remote();return finish({});},
  captureArtifactInputProof: captureProofMock,
  readableArtifactIds: vi.fn(async (_actor, _workspaceId, _kind, records) => new Set(records.filter((row: { lineageReadable?: boolean }) => row.lineageReadable !== false).map((row: { id: string }) => row.id))),
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
    globalRole: "USER",
  },
};
const otherActor: AppActor = { ...actor, user: { ...actor.user, id: "user-2" } };
const agent: AppActor = {
  kind: "agent", authProvider: "credential", label: "Assistant", workspaceIds: ["ws-1"],
  scopes: ["workspace:read", "circles:read", "members:read", "actions:read", "tensions:read", "proposals:read", "goals:read"],
};

// A synthetic query evaluator makes the regression observable in returned data,
// rather than accepting an unconditional findMany mock regardless of its where.
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return value.some((clause: Record<string, any>) => matches(row, clause));
    if (key === "AND") return value.every((clause: Record<string, any>) => matches(row, clause));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (value.gt !== undefined) return row[key] > value.gt;
      if (value.lt !== undefined) return row[key] < value.lt;
      if (value.in) return value.in.includes(row[key]);
      if (value.notIn) return !value.notIn.includes(row[key]);
      throw new Error(`Unsupported synthetic predicate: ${key}`);
    }
    return value instanceof Date ? row[key].getTime() === value.getTime() : row[key] === value;
  });
}

function fixture(id: string, overrides: Record<string, any> = {}) {
  return {
    id, workspaceId: "ws-1", authorUserId: "user-1", isPrivate: false,
    status: "OPEN", archivedAt: null, version: 3, title: id, bodyMd: "Synthetic body",
    priority: "HIGH", dueAt: null, createdAt: new Date("2026-01-01"),
    assigneeMemberId: "member-2", author: { id: "user-1", displayName: "Author", email: "hidden@example.com" },
    assigneeMember: { id: "member-2", workspaceId: "ws-1", userId: "user-2", isActive: true, user: { id: "user-2", displayName: "Assignee", email: "hidden@example.com" } },
    raisedByMember: { id: "member-3", workspaceId: "ws-1", userId: "user-3", isActive: true, user: { id: "user-3", displayName: "Raised by", email: "hidden@example.com" } },
    proposal: { id: "hidden-proposal", title: "Private related proposal" },
    actions: [{ id: "hidden-action", title: "Private related action" }],
    tensions: [{ id: "hidden-tension", title: "Private related tension" }],
    ...overrides,
  };
}

const rows = [
  fixture("public-open"),
  fixture("own-draft", { isPrivate: true, status: "DRAFT" }),
  fixture("other-draft", { isPrivate: true, status: "DRAFT", authorUserId: "user-2" }),
  fixture("public-draft", { status: "DRAFT", authorUserId: "user-2" }),
  fixture("own-private-open", { isPrivate: true }),
  fixture("other-private-open", { isPrivate: true, authorUserId: "user-2" }),
  fixture("archived-open", { archivedAt: new Date("2026-01-02") }),
  fixture("archived-draft", { isPrivate: true, status: "DRAFT", archivedAt: new Date("2026-01-02") }),
  fixture("foreign-open", { workspaceId: "ws-2" }),
  fixture("foreign-draft", { workspaceId: "ws-2", isPrivate: true, status: "DRAFT" }),
].map((row, index) => ({ ...row, createdAt: new Date(Date.UTC(2026, 0, 20 - index)) }));

const readMocks = [findManyTensionsMock, findManyActionsMock, findManyProposalsMock];
const countMocks = [tensionCountMock, actionCountMock, proposalCountMock, goalCountMock, memberCountMock, circleCountMock];

beforeEach(() => {
  vi.resetAllMocks();
  captureProofMock.mockImplementation(async (_actor, _workspaceId, inputs) => inputs.map((input: { kind: string; id: string; snapshot: { isActive?: boolean; lineageReadable?: boolean } }) => {
    if (!input.id || input.snapshot.isActive === false || input.snapshot.lineageReadable === false) throw new AppError(409, "SOURCE_RESTRICTED", "Profile unavailable.");
    return { kind: input.kind, id: input.id, fingerprint: "a".repeat(64) };
  }));
  membershipMock.mockImplementation(async ({ actor: caller, workspaceId }) => {
    if (caller.kind === "agent") {
      if (!caller.workspaceIds?.includes(workspaceId)) throw new AppError(403, "FORBIDDEN", "Agent workspace denied.");
      return null;
    }
    if (workspaceId !== "ws-1" || !["user-1", "user-2"].includes(caller.user.id)) {
      throw new AppError(403, "NOT_A_MEMBER", "No active membership.");
    }
    return { id: "member-1", workspaceId, userId: caller.user.id, role: "MEMBER", isActive: true };
  });
  for (const mock of readMocks) {
    mock.mockImplementation(async ({ where, take, orderBy }) => rows.filter(row => matches(row, where))
      .sort((a, b) => Array.isArray(orderBy) ? b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id) : a.id.localeCompare(b.id)).slice(0, take));
  }
  for (const mock of [tensionCountMock, actionCountMock, proposalCountMock, goalCountMock]) {
    mock.mockImplementation(async ({ where }) => rows.filter(row => matches(row, where)).length);
  }
  findManyGoalsMock.mockImplementation(async ({ where, take }) => rows.filter(row => matches(row, where)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take));
  findManyCirclesMock.mockResolvedValue([{ id: "circle-1", workspaceId: "ws-1", archivedAt: null }]);
  memberCountMock.mockResolvedValue(2);
  findManyMembersMock.mockResolvedValue([{ id: "member-1", isActive: true }, { id: "member-2", isActive: true }]);
  circleCountMock.mockResolvedValue(1);
  listGoalsMock.mockResolvedValue([{
    id: "goal-1", title: "Launch goal", descriptionMd: "Launch safely.",
    cadence: "QUARTERLY", level: "COMPANY", status: "ACTIVE", progressPercent: 25,
    targetDate: null, startDate: null, circle: { id: "circle-1", name: "General" },
    ownerMember: { id: "owner-1", userId: "owner-user", user: { displayName: "Owner" } },
    keyResults: [{ id: "kr-1", title: "Ship the rollout", currentValue: 1, targetValue: 4, unit: "milestones", progressPercent: 25 }],
  }]);
});

describe("workspace agent tools", () => {
  it("queries goals through the actor-aware domain list", async () => {
    const { queryGoals } = await import("./workspace");

    const result = await queryGoals(actor, "ws-1", "QUARTERLY", "COMPANY", "ACTIVE");

    expect(listGoalsMock).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1",
      cadence: "QUARTERLY",
      level: "COMPANY",
      status: "ACTIVE",
      take: 20,
    });
    expect(result).toEqual([
      expect.objectContaining({
        id: "goal-1",
        title: "Launch goal",
        owner: "Owner",
        keyResults: [
          expect.objectContaining({
            title: "Ship the rollout",
            progressPercent: 25,
          }),
        ],
      }),
    ]);
  });
});

describe("authenticated workspace readers", () => {
  it("documents exact-ID version handoffs", async () => {
    const { queryTensionsTool, queryActionsTool } = await import("./workspace");
    expect(queryTensionsTool.function.description).toContain("update_tension");
    expect(queryActionsTool.function.description).toContain("update_action");
    expect((queryTensionsTool.function.parameters.properties as any).tensionId).toBeDefined();
    expect((queryActionsTool.function.parameters.properties as any).actionId).toBeDefined();
  });

  it.each(["actions", "tensions"] as const)("enforces identical %s list and exact-ID visibility", async (entity) => {
    const { queryActions, queryTensions } = await import("./workspace");
    const query = entity === "actions" ? queryActions : queryTensions;
    const list = await query("ws-1", undefined, undefined, undefined, actor);
    expect(list.map(item => item.id)).toEqual(["public-open", "own-draft", "public-draft"]);
    for (const row of rows) {
      const detail = await query("ws-1", undefined, undefined, row.id, actor);
      expect(detail).toEqual(list.filter(item => item.id === row.id));
    }
    expect(list[0]).toMatchObject({ version: 3, author: "Author", assignee: "Assignee" });
    const otherList = await query("ws-1", undefined, undefined, undefined, otherActor);
    expect(otherList.map(item => item.id)).toEqual(["public-open", "other-draft", "public-draft"]);
  });

  it.each(["actions", "tensions"] as const)("keeps %s privacy conjunctive with model-selected status, assignee and ID", async (entity) => {
    const { queryActions, queryTensions } = await import("./workspace");
    const query = entity === "actions" ? queryActions : queryTensions;
    expect((await query("ws-1", "DRAFT", "member-2", undefined, actor)).map(item => item.id))
      .toEqual(["own-draft", "public-draft"]);
    expect(await query("ws-1", "DRAFT", "member-2", "other-draft", actor)).toEqual([]);
    expect(await query("ws-1", "DRAFT", "foreign-member", undefined, actor)).toEqual([]);
    expect(await query("ws-1", "OPEN", undefined, "own-draft", actor)).toEqual([]);
    expect(membershipMock).toHaveBeenCalledWith({ actor, workspaceId: "ws-1" });
  });

  it("aligns proposal lists and overview counts with each caller's privacy and archives", async () => {
    const { queryProposals, queryActions, queryTensions, getWorkspaceOverview } = await import("./workspace");
    for (const caller of [actor, otherActor]) {
      const proposals = await queryProposals("ws-1", undefined, caller);
      expect(proposals.map(item => item.id)).toEqual(["public-open", caller === actor ? "own-draft" : "other-draft", "public-draft"]);
      const drafts = await queryProposals("ws-1", "DRAFT", caller);
      expect(drafts).toHaveLength(2);
      const overview = await getWorkspaceOverview("ws-1", caller);
      expect(overview).toMatchObject({ memberCount: 2, circleCount: 1, openTensions: 1, openActions: 1, activeProposals: proposals.length, activeGoals: 1 });
      expect((await queryActions("ws-1", "OPEN", undefined, undefined, caller)).length).toBe(overview.openActions);
      expect((await queryTensions("ws-1", "OPEN", undefined, undefined, caller)).length).toBe(overview.openTensions);
    }
  });

  it.each(["admin", "agent"] as const)("applies the current %s draft authority without exposing private non-drafts", async (kind) => {
    const { queryActions, queryTensions, queryProposals, getWorkspaceOverview } = await import("./workspace");
    const caller = kind === "agent" ? agent : actor;
    if (kind === "admin") membershipMock.mockResolvedValue({ id: "member-1", role: "ADMIN", isActive: true });
    for (const query of [queryActions, queryTensions]) {
      expect((await query("ws-1", undefined, undefined, undefined, caller)).map(item => item.id))
        .toEqual(kind === "admin" ? ["public-open", "own-draft", "other-draft", "public-draft"] : ["public-open", "public-draft"]);
      expect((await query("ws-1", "DRAFT", "member-2", "other-draft", caller))[0]?.id).toBe(kind === "admin" ? "other-draft" : undefined);
      expect(await query("ws-1", undefined, undefined, "other-private-open", caller)).toEqual([]);
      expect(await query("ws-1", undefined, undefined, "foreign-draft", caller)).toEqual([]);
    }
    const proposals = await queryProposals("ws-1", undefined, caller);
    expect(proposals).toHaveLength(kind === "admin" ? 4 : 2);
    expect(await getWorkspaceOverview("ws-1", caller)).toMatchObject({ activeProposals: proposals.length, openActions: 1 });
  });

  it("excludes private non-draft and archived goals from overview counts", async () => {
    const { getWorkspaceOverview } = await import("./workspace");
    const goals = [
      fixture("active", { status: "ACTIVE" }),
      fixture("private-active", { status: "ACTIVE", isPrivate: true }),
      fixture("archived-active", { status: "ACTIVE", archivedAt: new Date() }),
      fixture("draft", { status: "DRAFT" }),
      fixture("abandoned", { status: "ABANDONED" }),
      fixture("foreign-active", { status: "ACTIVE", workspaceId: "ws-2" }),
    ];
    findManyGoalsMock.mockImplementation(async ({ where, take }) => goals.filter(row => matches(row, where)).slice(0, take));
    expect(await getWorkspaceOverview("ws-1", actor)).toMatchObject({ activeGoals: 1 });
    expect(findManyGoalsMock).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [expect.objectContaining({ workspaceId: "ws-1", archivedAt: null })] } }));
  });

  it.each(["absent actor", "missing membership", "revoked membership", "foreign workspace", "out-of-scope agent"])("denies every reader before content access for %s", async (scenario) => {
    const { queryActions, queryTensions, queryProposals, getWorkspaceOverview } = await import("./workspace");
    let caller: AppActor | undefined = actor;
    let workspaceId = "ws-1";
    if (scenario === "absent actor") caller = undefined;
    if (scenario === "missing membership") caller = { ...actor, user: { ...actor.user, id: "nonmember" } };
    if (scenario === "revoked membership") membershipMock.mockRejectedValue(new AppError(403, "NOT_A_MEMBER", "Membership revoked."));
    if (scenario === "foreign workspace") workspaceId = "ws-2";
    if (scenario === "out-of-scope agent") { caller = agent; workspaceId = "ws-2"; }
    const expected = { status: scenario === "absent actor" ? 401 : 403 };
    for (const id of [undefined, "other-draft"]) {
      await expect(queryActions(workspaceId, "DRAFT", "member-2", id, caller)).rejects.toMatchObject(expected);
      await expect(queryTensions(workspaceId, "DRAFT", "member-2", id, caller)).rejects.toMatchObject(expected);
    }
    await expect(queryProposals(workspaceId, "DRAFT", caller)).rejects.toMatchObject(expected);
    await expect(getWorkspaceOverview(workspaceId, caller)).rejects.toMatchObject(expected);
    for (const mock of [...readMocks, ...countMocks]) expect(mock).not.toHaveBeenCalled();
  });

  it("rechecks membership for every read after revocation", async () => {
    const { queryActions, getWorkspaceOverview } = await import("./workspace");
    expect(await queryActions("ws-1", undefined, undefined, undefined, actor)).toHaveLength(3);
    for (const mock of [...readMocks, ...countMocks]) mock.mockClear();
    membershipMock.mockRejectedValue(new AppError(403, "NOT_A_MEMBER", "Membership revoked."));
    await expect(queryActions("ws-1", undefined, undefined, undefined, actor)).rejects.toMatchObject({ status: 403 });
    await expect(getWorkspaceOverview("ws-1", actor)).rejects.toMatchObject({ status: 403 });
    for (const mock of [...readMocks, ...countMocks]) expect(mock).not.toHaveBeenCalled();
  });

  it("omits unproved author and inactive member labels without losing the permitted action", async () => {
    const { queryActions } = await import("./workspace");
    const row = fixture("visible-action");
    findManyActionsMock.mockResolvedValue([{ ...row, author: { ...row.author, lineageReadable: false }, assigneeMember: { ...row.assigneeMember, isActive: false } }]);
    expect(await queryActions("ws-1", undefined, undefined, undefined, actor)).toEqual([
      expect.objectContaining({ id: row.id, title: row.title, author: null, assignee: null }),
    ]);
    expect(captureProofMock).toHaveBeenCalledWith(actor, "ws-1", [expect.objectContaining({ kind: "User", id: "user-1" })], undefined);
    expect(captureProofMock).toHaveBeenCalledWith(actor, "ws-1", [expect.objectContaining({ kind: "Member", id: "member-2" })], undefined);
  });

  it("returns only public fields after proving full rows and excludes related private records", async () => {
    const { queryActions, queryTensions, queryProposals } = await import("./workspace");
    const actions = await queryActions("ws-1", undefined, undefined, undefined, actor);
    const tensions = await queryTensions("ws-1", undefined, undefined, undefined, actor);
    const proposals = await queryProposals("ws-1", undefined, actor);
    for (const mock of readMocks) {
      const args = mock.mock.calls[0][0];
      // Full current rows prove visibility before the public result projection.
      expect(args).not.toHaveProperty("select");
      expect(args).toMatchObject({ take: 100, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { author: expect.any(Object) } });
      expect(args.include).not.toHaveProperty("proposal");
      expect(args.include).not.toHaveProperty("actions");
      expect(args.include).not.toHaveProperty("tensions");
    }
    expect(Object.keys(actions[0]).sort()).toEqual(["id", "version", "title", "status", "author", "assignee", "dueAt", "createdAt", "bodySnippet"].sort());
    expect(Object.keys(tensions[0]).sort()).toEqual(["id", "version", "title", "status", "priority", "author", "assignee", "raisedBy", "createdAt", "bodySnippet"].sort());
    expect(Object.keys(proposals[0]).sort()).toEqual(["id", "title", "status", "author", "createdAt"].sort());
    expect(JSON.stringify({ actions, tensions, proposals })).not.toMatch(/hidden@example|hidden-proposal|hidden-action|hidden-tension|Private related/);
  });
});

it.each(["Action", "Tension", "Proposal"] as const)("samples twenty recent %s rows without scanning an older workspace corpus", async kind => {
  const api = await import("./workspace");
  const mock = kind === "Action" ? findManyActionsMock : kind === "Tension" ? findManyTensionsMock : findManyProposalsMock;
  const corpus = Array.from({ length: 5001 }, (_, i) => fixture(`recent-${String(i).padStart(5, "0")}`, { createdAt: new Date(2026, 0, 1), lineageReadable: i < 4901 }));
  mock.mockImplementation(async ({ where, take, orderBy }) => corpus.filter(row => matches(row, where))
    .sort((a, b) => Array.isArray(orderBy) ? b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id) : a.id.localeCompare(b.id)).slice(0, take));
  const result = kind === "Proposal" ? await api.queryProposals("ws-1", undefined, actor)
    : await (kind === "Action" ? api.queryActions : api.queryTensions)("ws-1", undefined, undefined, undefined, actor);
  expect(result.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => `recent-${String(4900 - i).padStart(5, "0")}`));
  expect(mock).toHaveBeenCalledTimes(2);
  expect(mock.mock.calls.every(([args]) => args.take === 100)).toBe(true);
});
