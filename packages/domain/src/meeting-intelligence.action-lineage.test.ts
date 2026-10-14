import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";

const fixture = vi.hoisted(() => {
  const tables = new Map<string, Map<string, any>>();
  const memberships = new Map<string, { id: string; role: string }>();
  const delegates = new Map<string, any>();
  const membership = vi.fn();
  let serial = 0;
  const matches = (row: any, where: any): boolean => {
    if (!row) return false;
    for (const [key, value] of Object.entries(where ?? {})) {
      if (key === "AND") { if (!(value as any[]).every((entry) => matches(row, entry))) return false; }
      else if (key === "NOT") { if ((Array.isArray(value) ? value : [value]).some((entry: any) => matches(row, entry))) return false; }
      else if (key === "OR") { if (!(value as any[]).some((entry) => matches(row, entry))) return false; }
      else if (value instanceof Date) { if (!(row[key] instanceof Date) || row[key].getTime() !== value.getTime()) return false; }
      else if (value && typeof value === "object" && "in" in value) { if (!(value.in as any[]).includes(row[key])) return false; }
      else if (value && typeof value === "object" && "not" in value) { if (row[key] === value.not) return false; }
      else if (value && typeof value === "object" && "startsWith" in value) { if (!String(row[key]).startsWith(String(value.startsWith))) return false; }
      else if (value && typeof value === "object" && key.includes("_") && row[key] === undefined) { if (!matches(row, value)) return false; }
      else if (value && typeof value === "object" && "some" in value) { if (!(row[key] ?? []).some((entry: any) => matches(entry, value.some))) return false; }
      else if (value && typeof value === "object") { if (!matches(row[key], value)) return false; }
      else if (row[key] !== value) return false;
    }
    return true;
  };
  const project = (row: any, select: any): any => select ? Object.fromEntries(Object.keys(select).map((key) => [key, typeof select[key] === "object" && row[key] ? project(row[key], select[key].select) : row[key]])) : structuredClone(row);
  const base = { $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(async () => [] as any[]) };
  const prisma: any = new Proxy(base, { get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    const name = String(property);
    if (!delegates.has(name)) {
      const rows = () => [...(tables.get(name)?.values() ?? [])];
      const find = ({ where, select, orderBy, take }: any) => {
        let result = rows().filter((row) => matches(row, where));
        for (const [field, direction] of Object.entries(orderBy ?? {})) result.sort((a, b) => {
          const left = a[field] instanceof Date ? a[field].getTime() : a[field];
          const right = b[field] instanceof Date ? b[field].getTime() : b[field];
          return (left === right ? 0 : left > right ? 1 : -1) * (direction === "desc" ? -1 : 1);
        });
        return result.slice(0, take ?? result.length).map((row) => project(row, select));
      };
      delegates.set(name, {
        findFirst: vi.fn(async (args) => find(args)[0] ?? null),
        findUnique: vi.fn(async (args) => { const row = find(args)[0] ?? null; if (row && args.include?.meeting) row.meeting = structuredClone(tables.get("meeting")?.get(row.meetingId)); return row; }),
        findMany: vi.fn(async (args) => find(args)),
        count: vi.fn(async ({where}: any = {}) => rows().filter(row => matches(row, where)).length),
        upsert: vi.fn(async ({where, update, create}: any) => { const row = rows().find(entry => matches(entry, where)); if (row) { Object.assign(row, structuredClone(update)); return structuredClone(row); } const made = {id: `${name}-${++serial}`, createdAt: new Date(), ...structuredClone(create)}; if (!tables.has(name)) tables.set(name, new Map()); tables.get(name)!.set(made.id, made); return structuredClone(made); }),
        createMany: vi.fn(async ({data}: any) => { for (const entry of data) { const row = {id: `${name}-${++serial}`, createdAt: new Date(), ...structuredClone(entry)}; if (!tables.has(name)) tables.set(name, new Map()); tables.get(name)!.set(row.id, row); } return {count: data.length}; }),
        create: vi.fn(async ({ data }) => {
          const now = new Date();
          const row = { id: `${name}-${++serial}`, createdAt: now, updatedAt: now,
            ...(["document", "brainSource", "meeting"].includes(name) ? { informationCategory: "GENERAL" } : {}),
            ...(name === "conversationPendingOperation" ? { status: "PENDING", proposedAt: now, resultJson: null, errorCode: null, errorMessage: null, executedAt: null, canceledAt: null } : {}), ...structuredClone(data) };
          if (!tables.has(name)) tables.set(name, new Map());
          tables.get(name)!.set(row.id, row);
          return structuredClone(row);
        }),
        update: vi.fn(async ({ where, data }) => {
          const row = rows().find((entry) => matches(entry, where));
          if (!row) throw new Error("Synthetic row unavailable");
          Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          return structuredClone(row);
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const found = rows().filter((row) => matches(row, where));
          for (const row of found) Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          return { count: found.length };
        }),
      });
    }
    return delegates.get(name);
  } });
  return { tables, memberships, delegates, membership, prisma, base };
});


vi.mock("@corgtex/shared", async importOriginal => ({...await importOriginal<typeof import("@corgtex/shared")>(), prisma: fixture.prisma}));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership,
  actorUserIdForWorkspace: vi.fn(async (_ws, actor) => actor.user.id), isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async () => ["WORKSPACE"]) }));
vi.mock("@corgtex/models", () => ({ defaultModelGateway: {extract: vi.fn(async () => { throw new Error("No live model in resolution tests"); })} }));

import { applyInsight } from "./meeting-intelligence";
import { captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage,
  withArtifactInputWriteFence } from "./source-lineage";
import { AppError } from "./errors";
const workspaceId = "synthetic-meeting-ws";
const alice: AppActor = {kind: "user", user: {id: "alice", email: "alice@example.test", displayName: "Synthetic Alice"}};
const bob: AppActor = {kind: "user", user: {id: "bob", email: "bob@example.test", displayName: "Synthetic Bob"}};
const tx = new Proxy(fixture.prisma, { get(target, property) { return property === "$transaction" ? undefined : Reflect.get(target, property); } });
const at = new Date("2026-10-13T12:00:00Z");
let epochs: ReturnType<typeof installSourcePermissionEpochFixture>;
const put = (delegate: string, data: any) => { const row = {createdAt: at, updatedAt: at, ...(["document", "brainSource", "meeting"].includes(delegate) ? { informationCategory: "GENERAL" } : {}), ...data}; if (!fixture.tables.has(delegate)) fixture.tables.set(delegate, new Map()); fixture.tables.get(delegate)!.set(row.id, row); return row; };
const rows = (delegate: string) => [...(fixture.tables.get(delegate)?.values() ?? [])];
const find = (delegate: string, id: string) => fixture.tables.get(delegate)!.get(id);
beforeEach(() => {
  vi.clearAllMocks(); fixture.tables.clear();
  epochs = installSourcePermissionEpochFixture(fixture.prisma);
  fixture.base.$transaction.mockImplementation(async callback => {
    const prior = structuredClone(fixture.tables);
    try { return await callback(tx); } catch (error) { fixture.tables.clear(); for (const [name, table] of prior) fixture.tables.set(name, table); throw error; }
  });
  fixture.membership.mockImplementation(async ({actor, workspaceId: ws}) => {
    const member = rows("member").find(row => row.workspaceId === ws && row.userId === actor.user.id && row.isActive);
    if (!member) throw new AppError(403, "MEMBERSHIP_REQUIRED", "Synthetic current member required"); return member;
  });
  put("workspace", {id: workspaceId, name: "Synthetic meeting", slug: "synthetic-meeting", description: null, plan: "FREE"});
  for (const actor of [alice, bob]) {
    const user = put("user", {...actor.user, memberships: [{workspaceId, isActive: true}]});
    put("member", {id: `member-${actor.user.id}`, workspaceId, userId: actor.user.id, isActive: true, kind: "HUMAN", role: "CONTRIBUTOR", user});
  }
});
async function setup(kind: "Action" | "Tension" | "Proposal") {
  const target = put(kind[0].toLowerCase() + kind.slice(1), {id: "target", workspaceId, authorUserId: "alice", title: "Original public body",
    bodyMd: "Original public body remains recorded", status: "OPEN", isPrivate: false, archivedAt: null, version: 1,
    assigneeMemberId: "member-alice", ownerMemberId: "member-alice", duplicateOfActionId: null, circleId: null,
    publishedAt: at, proposalId: null, dueAt: null, priority: 0, completedVia: null, resolvedVia: null});
  await recordArtifactInputLineage({tx, actor: alice, workspaceId, artifact: {kind, id: target.id}, content: target, origin: "HUMAN_ORIGINAL", inputs: []});
  const privateSource = put("brainArticle", {id: "uncited-private", workspaceId, title: "Uncited private context", bodyMd: "Private decision context canary",
    type: "PROJECT", slug: "private-context", isPrivate: true, ownerMemberId: "member-alice", archivedAt: null});
  await recordArtifactInputLineage({tx, actor: alice, workspaceId, artifact: {kind: "BrainArticle", id: privateSource.id}, content: privateSource, origin: "HUMAN_ORIGINAL", inputs: []});
  const meeting = put("meeting", {id: "meeting", workspaceId, title: "Meeting source title canary", source: "manual", transcript: null,
    summaryMd: null, status: "COMPLETED", archivedAt: null, blocksJson: null, participantIds: [], participantEmails: []});
  await recordArtifactInputLineage({tx, actor: alice, workspaceId, artifact: {kind: "Meeting", id: meeting.id}, content: meeting, origin: "HUMAN_ORIGINAL", inputs: []});
  if (kind === "Proposal") {
    const flow = put("approvalFlow", {id: "flow", workspaceId, subjectType: "PROPOSAL", subjectId: target.id, mode: "CONSENT",
      status: "ACTIVE", createdByUserId: "alice", quorumPercent: 50, minApproverCount: 1, openedAt: at, closesAt: null, closedAt: null, resultJson: null});
    await recordArtifactInputLineage({tx, actor: alice, workspaceId, artifact: {kind: "ApprovalFlow", id: flow.id}, content: flow,
      origin: "DERIVED", inputs: [{kind, id: target.id}]});
  }
  const insight = put("meetingInsight", {id: "insight", workspaceId, meetingId: meeting.id, type: kind === "Proposal" ? "PROPOSAL" : kind === "Tension" ? "TENSION" : "ACTION_ITEM",
    operation: "RESOLVE", status: "SUGGESTED", title: "Resolve the target", bodyMd: "Generated source-grounded resolution canary",
    targetEntityType: kind, targetEntityId: target.id, resolutionOutcome: "ADOPTED", confidence: 1, supersededAt: null,
    sourceRecordId: null, metadataJson: {}, sourceQuote: null});
  // Actual low-level writers certify these synthetic human originals and the
  // full declared generated input set, including the uncited private source.
  const inputs = [{kind, id: target.id}, {kind: "Meeting" as const, id: meeting.id}, {kind: "BrainArticle" as const, id: privateSource.id}];
  const modelInputs = await captureArtifactInputProof(alice, workspaceId, inputs, tx);
  await recordArtifactInputLineage({tx, actor: alice, workspaceId, artifact: {kind: "MeetingInsight", id: insight.id}, content: insight,
    origin: "DERIVED", inputs: [], inheritedRoots: modelInputs});
  return {target, meeting, insight};
}
describe("meeting resolution actual lineage helpers", () => {
  it.each(["Action", "Tension", "Proposal"] as const)("atomically applies %s with the full immutable self-target and uncited source closure", async kind => {
    const f = await setup(kind);
    const result = await applyInsight(alice, {workspaceId, insightId: f.insight.id});
    expect(result).toMatchObject({status: "APPLIED", appliedEntityType: kind, appliedEntityId: f.target.id});
    const target = find(kind[0].toLowerCase() + kind.slice(1), f.target.id);
    expect(target.status).toBe(kind === "Action" ? "COMPLETED" : "RESOLVED");
    const roots = await captureArtifactInputProof(alice, workspaceId, [{kind, id: f.target.id}, {kind: "MeetingInsight", id: result.id}]);
    expect(await isArtifactInputProofReadable(alice, workspaceId, roots)).toBe(true);
    expect(await isArtifactInputProofReadable(bob, workspaceId, roots)).toBe(false);
    expect(rows("artifactInputSnapshot").some(row => row.sourceKind === kind && row.sourceId === "target" && row.contentJson.status === "OPEN")).toBe(true);
    if (kind === "Proposal") {
      expect(find("approvalFlow", "flow").status).toBe("APPROVED");
      const policy = rows("policyCorpus")[0];
      expect(policy).toMatchObject({proposalId: "target", bodyMd: f.target.bodyMd});
      await expect(captureArtifactInputProof(alice, workspaceId, [{kind: "ApprovalFlow", id: "flow"}, {kind: "PolicyCorpus", id: policy.id}])).resolves.not.toEqual([]);
    }
  });
  it.each(["Action", "Tension", "Proposal"] as const)("rejects inaccessible %s model ancestry before canonical changes", async kind => {
    const f = await setup(kind);
    await expect(applyInsight(bob, {workspaceId, insightId: f.insight.id})).rejects.toMatchObject({code: "NOT_FOUND"});
    expect(find(kind[0].toLowerCase() + kind.slice(1), "target").status).toBe("OPEN");
    expect(find("meetingInsight", "insight").status).toBe("SUGGESTED");
  });
  it.each(["Action", "Tension", "Proposal"] as const)("rolls back every canonical %s effect when final persistence fence fails", async kind => {
    await setup(kind);
    const before = rows("artifactInputLineage").filter(row => row.artifactType === kind).length;
    await expect(withArtifactInputWriteFence(async () => {
      if (find("meetingInsight", "insight").status === "APPLIED") throw new AppError(409, "SOURCE_CHANGED", "Synthetic final fence revoked");
    }, () => applyInsight(alice, {workspaceId, insightId: "insight"}))).rejects.toMatchObject({code: "ARTIFACT_INPUT_WRITE_FENCE_LOST"});
    expect(find(kind[0].toLowerCase() + kind.slice(1), "target").status).toBe("OPEN");
    expect(find("meetingInsight", "insight").status).toBe("SUGGESTED");
    expect(rows("auditLog")).toEqual([]); expect(rows("event")).toEqual([]); expect(rows("policyCorpus")).toEqual([]);
    expect(rows("artifactInputLineage").filter(row => row.artifactType === kind)).toHaveLength(before);
    expect(rows("artifactInputSnapshot").length).toBeGreaterThan(0); // Durable, verified preparation history only.
  });
  it("rejects permission revoke/restore between phases without recapturing the old vector", async () => {
    await setup("Action");
    let phases = 0;
    const run = fixture.base.$transaction.getMockImplementation()!;
    fixture.base.$transaction.mockImplementation(async work => {
      const result = await run(work); if (++phases === 1) {
        epochs.bump(workspaceId, "BrainArticle", "uncited-private"); epochs.bump(workspaceId, "BrainArticle", "uncited-private");
      } return result;
    });
    await expect(applyInsight(alice, {workspaceId, insightId: "insight"})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(find("action", "target").status).toBe("OPEN"); expect(find("meetingInsight", "insight").status).toBe("SUGGESTED");
  });
});
