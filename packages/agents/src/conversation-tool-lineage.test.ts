import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const rows: Record<string, any[]> = {};
  const timestamp = new Date("2026-10-01T09:00:00Z");
  const names = ["workspace", "user", "member", "action", "tension", "proposal", "goal", "circle", "role", "roleAssignment", "meeting", "document",
    "auditLog", "artifactInputLineage", "artifactInputSnapshot", "keyResult", "goalLink", "crmActivity", "crmAccount", "crmContact", "crmDeal", "contextGraphObject", "contextGraphRelationship", "contextGraphEvidenceRef", "contextMapView", "contextMapLayoutItem", "contextGraphProposedDiff", "workspaceFeatureFlag"];
  const relation = (kind: string, row: any, key: string) => {
    if (key === "user") return rows.user.find((user) => user.id === row.userId);
    if (["account", "contact", "deal"].includes(key)) return rows["crm" + key[0].toUpperCase() + key.slice(1)].find((record) => record.id === row[key + "Id"]);
    if (key === "circle") return rows.circle.find((circle) => circle.id === row.circleId);
    if (key === "goal") return rows.goal.find((goal) => goal.id === row.goalId);
    if (key === "role") return rows.role.find((role) => role.id === row.roleId);
    if (key === "member" || key === "assigneeMember" || key === "raisedByMember" || key === "ownerMember") return rows.member.find((member) => member.id === row[key + "Id"]);
    if (key === "author") return rows.user.find((user) => user.id === row.authorUserId);
    if (key === "parentCircle") return rows.circle.find((circle) => circle.id === row.parentCircleId);
    return undefined;
  };
  const relatedKind = (key: string) => ({ user: "user", circle: "circle", role: "role", member: "member", assigneeMember: "member", raisedByMember: "member", ownerMember: "member", author: "user", parentCircle: "circle", goal: "goal", account: "crmAccount", contact: "crmContact", deal: "crmDeal" } as Record<string, string>)[key];
  const matches = (kind: string, row: any, where: any): boolean => Boolean(row) && Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every((clause: any) => matches(kind, row, clause));
    if (key === "OR") return value.some((clause: any) => matches(kind, row, clause));
    if (key === "NOT") return !matches(kind, row, value);
    if (relatedKind(key)) return value === null ? relation(kind, row, key) == null : matches(relatedKind(key), relation(kind, row, key), value);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("gt" in value) return row[key] > value.gt;
      if ("in" in value) return value.in.includes(row[key]);
      if ("notIn" in value) return !value.notIn.includes(row[key]);
      if ("not" in value) return row[key] !== value.not;
      if ("has" in value) return row[key]?.includes(value.has);
      if (key === "memberships") return rows.member.some((member) => member.userId === row.id && matches("member", member, value.some));
      throw new Error(`Unsupported synthetic predicate: ${kind}.${key}`);
    }
    return row[key] === value;
  });
  const project = (kind: string, row: any, args: any = {}): any => {
    if (!row) return null;
    let value = { ...row };
    for (const [key, request] of Object.entries(args.include ?? {}) as [string, any][]) {
      if (relatedKind(key)) value[key] = project(relatedKind(key), relation(kind, row, key), request === true ? {} : request);
      else if (key === "roleAssignments") value[key] = rows.roleAssignment.filter((assignment) => assignment.memberId === row.id && matches("roleAssignment", assignment, request.where)).map((assignment) => project("roleAssignment", assignment, request));
      else if (key === "roles") value[key] = rows.role.filter((role) => role.circleId === row.id && matches("role", role, request.where)).map((role) => project("role", role, request));
      else if (key === "assignedActions") value[key] = rows.action.filter((action) => action.assigneeMemberId === row.id && matches("action", action, request.where)).map((action) => project("action", action, request));
      else if (key === "keyResults") value[key] = rows.keyResult.filter((record) => record.goalId === row.id).map((record) => project("keyResult", record, request === true ? {} : request));
      else if (key === "links" || key === "evidenceRefs") value[key] = [];
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
        .sort((left, right) => kind === "artifactInputLineage" ? right.revision - left.revision : left.id.localeCompare(right.id))
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
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }: any) => {
  const member = fixture.rows.member.find((row) => row.workspaceId === workspaceId && row.userId === actor.user.id && row.isActive);
  if (!member) throw Object.assign(new Error("Membership denied"), { status: 403, code: "FORBIDDEN" });
  return { id: member.id, role: member.role };
}), isGlobalOperator: () => false }));
vi.mock("../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async (actor: any) => actor.user.id === "beta" ? ["PUBLIC", "FINANCE"] : ["PUBLIC"]) }));
vi.mock("../../domain/src/role-onboarding", () => ({ closeRoleLifecycleForMember: vi.fn(), closeRoleLifecycleForCircleTree: vi.fn() }));
vi.mock("../../domain/src/self-serve-ops", () => ({ maybeCaptureSelfServeSetupEmail: vi.fn() }));
import { recordArtifactInputLineage, type LineageKind } from "../../domain/src/source-lineage";

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
  add("user", { id: "alpha", email: "alpha@example.test", displayName: "Alpha", bio: "Profile bio", avatarUrl: "https://synthetic.test/alpha.png", linkedinUrl: null, websiteUrl: null });
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
  fixture.prisma.$queryRaw.mockReset().mockImplementation(async (query: { sql?: string; values?: unknown[] }) => {
    if (query.sql?.includes('SELECT DISTINCT ON ("artifactId") "artifactId", "contentHash", "rootsJson"')) {
      const [workspace, kind, ...ids] = query.values!;
      const heads = new Map<string, any>();
      for (const row of fixture.rows.artifactInputLineage) {
        if (row.workspaceId !== workspace || row.artifactType !== kind || !ids.includes(row.artifactId)) continue;
        if (!heads.has(row.artifactId) || heads.get(row.artifactId).revision < row.revision) heads.set(row.artifactId, row);
      }
      return [...heads.values()].map(({ artifactId, contentHash, rootsJson }) => ({ artifactId, contentHash, rootsJson }));
    }
    return [];
  });
  installSourcePermissionEpochFixture(fixture.prisma);
});
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../domain/src/errors"), ...await import("../../domain/src/auth"),
  ...await import("../../domain/src/privacy"), ...await import("../../domain/src/source-scoped-read"),
  ...await import("../../domain/src/digest-lineage"),
  ...await import("../../domain/src/circles"), ...await import("../../domain/src/roles"),
  ...await import("../../domain/src/source-lineage"), ...await import("../../domain/src/conversation-lineage"),
  ...await import("../../domain/src/goals"), ...await import("../../domain/src/members"),
  ...await import("../../domain/src/crm"), ...await import("../../domain/src/context-graph"),
}));
import { executeTrustedConversationReadTool } from "./conversation-tool-lineage";
import { validateConversationInputReceipt } from "../../domain/src/conversation-lineage";
import type { ConversationPageContext } from "./page-context";

async function read(toolName: string, args: Record<string, unknown> = {}, actor = alpha, pageContext?: ConversationPageContext) {
  return executeTrustedConversationReadTool({ actor, workspaceId, toolName, args, pageContext });
}
async function roots(result: NonNullable<Awaited<ReturnType<typeof read>>>, actor = alpha) {
  return validateConversationInputReceipt({ actor, workspaceId, ...result });
}



describe("audited conversation read dispatch with real current receipts", () => {
  it("captures permitted action inputs and joined identities, excluding unknown and restricted records", async () => {
    await seed();
    const result = (await read("query_actions", { status: "OPEN" }))!;
    expect(result.value).toMatchObject([{ id: "visible-action", author: "Beta", assignee: "Alpha" }]);
    const proof = await roots(result);
    expect(proof).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "Workspace", id: workspaceId }),
      expect.objectContaining({ kind: "Action", id: "visible-action" }),
      expect.objectContaining({ kind: "User", id: "beta" }),
      expect.objectContaining({ kind: "Member", id: "member-alpha" }),
    ]));
    expect(proof.some((root) => ["restricted-derived", "unknown-legacy", "private-input"].includes(root.id))).toBe(false);
    expect(JSON.stringify(result.value)).not.toMatch(/Restricted|Unknown|Foreign/);
  });

  it("collects transitive private ancestry only for an entitled caller and rechecks its live permission", async () => {
    const { privateSource } = await seed();
    const result = (await read("query_actions", { status: "OPEN" }, beta))!;
    expect(await roots(result, beta)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "Action", id: privateSource.id })]));
    privateSource.archivedAt = new Date("2026-10-12");
    await expect(roots(result, beta)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("captures joined Goal inputs and omits unproven key results and affiliations", async () => {
    const { publicCircle, privateCircle, privateSource } = await seed();
    const goal = add("goal", { id: "goal-public", workspaceId, title: "Goal title", descriptionMd: "Goal body", status: "ACTIVE", isPrivate: false,
      authorUserId: "beta", ownerMemberId: "member-alpha", circleId: publicCircle.id, cadence: "ANNUAL", level: "COMPANY", progressPercent: 0 });
    await known("Goal", goal);
    const result = add("keyResult", { id: "result-public", goalId: goal.id, title: "Public result", progressPercent: 0 });
    await known("KeyResult", result);
    const restricted = add("keyResult", { ...result, id: "result-private", title: "Restricted result" });
    await known("KeyResult", restricted, [{ kind: "Action", id: privateSource.id }]);
    const output = (await read("query_goals"))!;
    expect(output.value).toMatchObject([{ circle: "Public circle", owner: "Alpha", keyResults: [{ title: "Public result" }] }]);
    expect(await roots(output)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "KeyResult", id: result.id }), expect.objectContaining({ kind: "Circle", id: publicCircle.id }), expect.objectContaining({ kind: "User", id: "alpha" })]));
    goal.circleId = privateCircle.id;
    await known("Goal", goal);
    expect((await read("query_goals"))?.value).toMatchObject([{ circle: null, keyResults: [{ title: "Public result" }] }]);
  });

  it("captures the current CRM activity and linked account, and rechecks both", async () => {
    const { privateSource } = await seed();
    const account = add("crmAccount", { id: "account-public", workspaceId, name: "Synthetic account", slug: "synthetic-account", source: "manual" });
    await known("CrmAccount", account);
    const activity = add("crmActivity", { id: "task-public", workspaceId, accountId: account.id, contactId: null, dealId: null,
      title: "Permitted follow-up", type: "TASK", completedAt: null, dueAt: null, actorUserId: "alpha", source: "manual" });
    await known("CrmActivity", activity);
    const hidden = add("crmActivity", { ...activity, id: "task-hidden", title: "Restricted follow-up" });
    await known("CrmActivity", hidden, [{ kind: "Action", id: privateSource.id }]);
    const output = (await read("list_due_relationship_work", { accountId: account.id }))!;
    expect(output.value).toMatchObject({ total: 1, items: [{ id: activity.id, title: "Permitted follow-up", accountId: account.id }] });
    expect(await roots(output)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "CrmAccount", id: account.id }), expect.objectContaining({ kind: "CrmActivity", id: activity.id })]));
    account.archivedAt = new Date("2026-10-12");
    await expect(roots(output)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("binds the receipt to output content, caller, current membership and current source fingerprints", async () => {
    const { publicAction } = await seed();
    const result = (await read("query_actions"))!;
    await expect(roots({ ...result, value: [{ title: "Injected private text" }] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(roots(result, beta)).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    publicAction.bodyMd = "Edited after capture";
    await expect(roots(result)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("captures every native member count driver and invalidates when an admitted member leaves", async () => {
    await seed();
    const result = (await read("get_workspace_overview"))!;
    expect(result.value).toMatchObject({ memberCount: 2, circleCount: 1, openActions: 1 });
    expect(await roots(result)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "Member", id: "member-beta" })]));
    fixture.rows.member.find((row) => row.id === "member-beta").isActive = false;
    await expect(roots(result)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect((await read("get_workspace_overview"))?.value).toMatchObject({ memberCount: 1 });
  });

  it("denies foreign audiences and revokes a completed receipt when its caller leaves", async () => {
    await seed();
    await expect(executeTrustedConversationReadTool({ actor: alpha, workspaceId: "ws-b", toolName: "get_workspace_overview", args: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const result = (await read("query_actions"))!;
    fixture.rows.member.find((row) => row.id === "member-alpha").isActive = false;
    await expect(roots(result)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(read("query_actions")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("certifies a permitted empty result with Workspace and current caller membership", async () => {
    await seed();
    const result = (await read("query_tensions"))!;
    expect(result.value).toEqual([]);
    expect(await roots(result)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "Workspace", id: workspaceId }), expect.objectContaining({ kind: "Member", id: "member-alpha" }),
    ]));
  });

  it("captures complete profile inputs and redacts raw unsupported Member metadata", async () => {
    await seed();
    fixture.rows.member.find((row) => row.id === "member-alpha").mergeReason = "Unreceipted historical note";
    const result = (await read("list_members"))!;
    expect(result.value).toMatchObject({ members: expect.arrayContaining([expect.objectContaining({ user: expect.objectContaining({ bio: "Profile bio" }) })]) });
    expect(JSON.stringify(result.value)).not.toMatch(/Unreceipted|Restricted/);
    expect(await roots(result)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "User", id: "alpha" })]));
    fixture.rows.user.find((row) => row.id === "alpha").avatarUrl = "https://synthetic.test/changed.png";
    await expect(roots(result)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("withholds historical audit text while capturing current profile content", async () => {
    await seed();
    fixture.rows.action.find((row) => row.id === "visible-action").completedVia = "Unreceipted operational metadata";
    fixture.rows.action.find((row) => row.id === "visible-action").duplicateOfActionId = "restricted-private-path";
    add("auditLog", { id: "historical-audit", workspaceId, actorUserId: "alpha", action: "Unreceipted historical text", entityType: "Action", entityId: "visible-action" });
    const result = (await read("get_member_profile", { memberId: "member-alpha" }))!;
    expect(result.value).toMatchObject({ recentActivity: [], member: { id: "member-alpha" } });
    expect(JSON.stringify(result.value)).not.toMatch(/Unreceipted|restricted-private-path/);
    expect(await roots(result)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "User", id: "alpha" })]));
  });

  it("captures role holder identity with populated partial profiles", async () => {
    await seed();
    const result = (await read("query_org_structure"))!;
    expect(result.value).toMatchObject([{ roles: [{ assignedMembers: ["Alpha"] }] }]);
    expect(await roots(result)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "User", id: "alpha" }), expect.objectContaining({ kind: "Role", id: "role-public" })]));
  });

  it.each(["query_goals", "list_due_relationship_work"])("certifies the actual empty audited %s reader", async (name) => {
    await seed();
    const result = (await read(name))!;
    expect(await roots(result)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "Workspace", id: workspaceId })]));
  });

  it("captures actual context region graph inputs and excludes raw page context titles", async () => {
    await seed();
    for (const flag of ["CONTEXT_MAPS", "CONTEXT_MAP_AI"]) add("workspaceFeatureFlag", { id: flag, workspaceId, flag, enabled: true });
    const object = add("contextGraphObject", { id: "graph-public", workspaceId, objectType: "Task", title: "Graph task", status: "approved", properties: {}, sensitivity: "INTERNAL" });
    await known("ContextGraphObject", object);
    const view = add("contextMapView", { id: "map-select", workspaceId, name: "Permitted map", viewType: "process", query: {}, createdByUserId: null });
    await known("ContextMapView", view);
    const page = { surface: "context-map", mapView: { id: "map-select", name: "Unreceipted page title", viewType: "process" }, selectedObjectIds: [object.id], selectedObjects: [{ title: "Injected page body" }], includeStale: false } as ConversationPageContext;
    const result = (await read("get_selected_context_map_region", { depth: 0 }, alpha, page))!;
    expect(result.value).toMatchObject({ objects: [{ title: "Graph task" }], knowledgeChunks: [] });
    expect(JSON.stringify(result.value)).not.toMatch(/Unreceipted|Injected/);
    expect(await roots(result)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ContextGraphObject", id: object.id }), expect.objectContaining({ kind: "ContextMapView", id: view.id })]));
  });

  it("requires a current map-view proof even when selected objects are permitted", async () => {
    await seed();
    await expect(read("get_selected_context_map_region", { mapViewId: "unproven-view", objectIds: ["graph-public"] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("never echoes client context map metadata in the info receipt", async () => {
    const { privateSource } = await seed();
    for (const flag of ["CONTEXT_MAPS", "CONTEXT_MAP_AI"]) add("workspaceFeatureFlag", { id: flag, workspaceId, flag, enabled: true });
    const view = add("contextMapView", { id: "map-select", workspaceId, name: "Permitted map", viewType: "process", query: {}, createdByUserId: null });
    await known("ContextMapView", view);
    const object = add("contextGraphObject", { id: "graph-visible", workspaceId, objectType: "Task", title: "Graph task", status: "approved", properties: {}, sensitivity: "INTERNAL", evidenceRefs: [] });
    await known("ContextGraphObject", object);
    const hidden = add("contextGraphObject", { ...object, id: "graph-hidden", title: "Restricted graph task" });
    await known("ContextGraphObject", hidden, [{ kind: "Action", id: privateSource.id }]);
    const page = { surface: "context-map", mapView: { id: view.id, name: "Injected title", viewType: "process" }, selectedObjectIds: [object.id], selectedObjects: [{ title: "Injected body" }], includeStale: false } as ConversationPageContext;
    const output = (await read("get_context_map_info", {}, alpha, page))!;
    expect(output.value).toMatchObject({ currentPageContext: null, selectedObjects: [{ title: "Graph task" }], visibleObjects: [{ title: "Graph task" }] });
    expect(JSON.stringify(output.value)).not.toMatch(/Injected|Restricted/);
    expect(await roots(output)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ContextMapView", id: view.id }), expect.objectContaining({ kind: "ContextGraphObject", id: object.id })]));
  });

  it.each(["execute_external_tool", "list_tool_links", "reveal_tool_link_credential", "check_calendar_availability", "create_action", "save_to_brain", "search_brain"])("does not run or certify unsupported %s", async (toolName) => {
    expect(await read(toolName)).toBeNull();
    expect(fixture.prisma.workspace.findFirst).not.toHaveBeenCalled();
    expect(fixture.prisma.member.findFirst).not.toHaveBeenCalled();
  });
  it.each(["fetch_connected_context", "search_connected_context"])("requires current membership before running native %s", async toolName => {
    await expect(read(toolName)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
