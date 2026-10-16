import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { fixture, workspaceId, alpha, beta, resetFixture, known } from "../../agents/src/agents/model-consumer.test-fixture";
import type { LineageKind } from "./source-lineage";

// Only SQL transport and non-content permalink/event sinks are synthetic. Permissions,
// immutable snapshots, producer receipts and the Action writer execute their real code.
vi.mock("@corgtex/shared", async () => ({ prisma: fixture.prisma,
  ...await import("../../shared/src/mcp-context"), env: {} }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, actorUserIdForWorkspace: async () => "beta", isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) => actor.kind === "agent" ? ["WORKSPACE"] : fixture.domains.get(actor.user.id) ?? [] }));
vi.mock("./audit-trail", () => ({ recordAudit: vi.fn() }));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));
vi.mock("./permalinks", () => ({ ensureWorkspacePermalink: vi.fn(), workspaceEntityCanonicalPath: (_ws: string, kind: string, row: any) => `/${kind}/${row.id}` }));

import { mcpCredentialVersion } from "../../shared/src/mcp-context";
import { captureArtifactInputProof, readableArtifactIds, withArtifactInputReadCapture } from "./source-lineage";
import { createExecutionRequest, getCompanyContext, getExecutionPacket, getExecutionRequest, listExecutionRequests, listWritebackTargets, submitExecutionResult } from "./execution-plumbing";

let revision = 0;
function matches(row: any, where: any): boolean {
  return Boolean(row) && Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (["workspaceId_idempotencyKey", "executionRequestId_idempotencyKey", "workspaceId_sourceType_sourceId"].includes(key)) return matches(row, value);
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every((part: any) => matches(row, part));
    if (key === "OR") return value.some((part: any) => matches(row, part));
    if (key === "NOT") return !matches(row, value);
    if (value && typeof value === "object" && !(value instanceof Date) && "in" in value) return value.in.includes(row[key]);
    return row[key] === value;
  });
}
function transport(name: string) {
  fixture.rows[name] = [];
  const project = (row: any, args: any = {}) => row ? { ...row, ...(name === "executionRequest" && args.include?.results
    ? { results: fixture.rows.executionResult.filter((r) => r.executionRequestId === row.id).map((r) => ({ ...r })) } : {}) } : null;
  fixture.prisma[name] = {
    findFirst: vi.fn(async (args: any) => project(fixture.rows[name].find((row) => matches(row, args.where)), args)),
    findUnique: vi.fn(async (args: any) => project(fixture.rows[name].find((row) => matches(row, args.where)), args)),
    findUniqueOrThrow: vi.fn(async (args: any) => {
      const row = fixture.rows[name].find((record) => matches(record, args.where));
      if (!row) throw new Error(`Missing synthetic ${name}`);
      return project(row, args);
    }),
    findMany: vi.fn(async (args: any) => fixture.rows[name].filter((row) => matches(row, args.where)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, args.take).map((r) => project(r, args))),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `${name}-${++revision}`, createdAt: fixture.timestamp, updatedAt: new Date(fixture.timestamp.getTime() + revision),
        ...(name === "executionRequest" ? { status: "PENDING", claimedAt: null, completedAt: null, failedAt: null, cancelledAt: null } : {}),
        ...(name === "executionResult" ? { submittedAt: new Date(fixture.timestamp.getTime() + revision) } : {}), ...data };
      fixture.rows[name].push(row); return project(row, { include: { results: true } });
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = fixture.rows[name].find((r) => matches(r, where)); if (!row) throw new Error(`Missing synthetic ${name}`);
      Object.assign(row, data, { updatedAt: new Date(fixture.timestamp.getTime() + ++revision) }); return project(row, { include: { results: true } });
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const rows = fixture.rows[name].filter((r) => matches(r, where));
      for (const row of rows) Object.assign(row, data, { updatedAt: new Date(fixture.timestamp.getTime() + ++revision) });
      return { count: rows.length };
    }),
  };
}
beforeEach(async () => {
  await resetFixture(); revision = 0;
  for (const name of ["executionRequest", "executionResult", "actionCreationSource", "agentCredential",
    "workspaceSupportGrant", "workspaceFeatureFlag", "workspaceModuleGrant", "roleAssignment", "role", "circle"]) transport(name);
  const epochs = new Map<string, bigint>();
  fixture.prisma.$executeRaw = vi.fn(async (sql: any) => {
    if (sql.sql?.includes('INSERT INTO "SourcePermissionEpoch"')) for (let i = 0; i < sql.values.length; i += 4) {
      const [, ws, kind, id] = sql.values.slice(i, i + 4); const key = JSON.stringify([ws, kind, id]);
      if (!epochs.has(key)) epochs.set(key, 0n);
    }
    return 1;
  });
  let connectionId = 0;
  let activeConnectionId = 0;
  fixture.prisma.$queryRaw = vi.fn(async (sql: any, ...values: any[]) => {
    const text = sql.sql ?? sql.join?.("") ?? "";
    const bindings = Array.isArray(sql) ? values : sql.values ?? values;
    if (text.includes("pg_backend_pid()")) return [{ pid: 101, transactionId: String(activeConnectionId) }];
    if (sql.sql?.includes('FROM "SourcePermissionEpoch"')) {
      const [ws, ...pairs] = sql.values; const result = [];
      for (let i = 0; i < pairs.length; i += 2) {
        const [sourceKind, sourceId] = pairs.slice(i, i + 2); const epoch = epochs.get(JSON.stringify([ws, sourceKind, sourceId]));
        if (epoch !== undefined) result.push({ sourceKind, sourceId, epoch });
      }
      return result;
    }
    const table = text.match(/FROM "([A-Za-z]+)"/)?.[1];
    if (table) {
      const name = table[0]!.toLowerCase() + table.slice(1);
      return (fixture.rows[name] ?? []).filter(row => row.id === bindings[0]
        && (table !== "ExecutionRequest" || bindings.length < 2 || row.workspaceId === bindings[1])).map(row => ({ ...row }));
    }
    return [];
  });
  fixture.prisma.$transaction.mockImplementation(async (run: any) => {
    const before = structuredClone(fixture.rows); const beforeEpochs = new Map(epochs);
    const previousConnectionId = activeConnectionId;
    activeConnectionId = ++connectionId;
    const tx = new Proxy(fixture.prisma, { get(target, key) { return key === "$transaction" ? undefined : Reflect.get(target, key); } });
    try { return await run(tx); }
    catch (error) {
      for (const name of Object.keys(before)) fixture.rows[name] = before[name];
      epochs.clear(); beforeEpochs.forEach((value, key) => epochs.set(key, value)); throw error;
    } finally { activeConnectionId = previousConnectionId; }
  });
});
const addInput = async (id = "input", privateInput = false) => {
  const row = fixture.add("brainArticle", { id, workspaceId, title: `${id} title`, bodyMd: `${id} body`, slug: id,
    isPrivate: privateInput, ownerMemberId: "member-beta", authority: "REFERENCE", archivedAt: null, updatedAt: fixture.timestamp });
  await known("BrainArticle", row); return row;
};
const proof = (row: any, actor = beta, kind: LineageKind = "BrainArticle") => captureArtifactInputProof(actor, workspaceId, [{ kind, id: row.id }]);
const request = (params: any = {}, actor = beta) => createExecutionRequest(actor, { workspaceId, goal: "Fresh requested task", writebackTargetType: "COMMENT", ...params });
const nativeKinds = [["Action", "action", "ACTION"], ["Tension", "tension", "TENSION"], ["Proposal", "proposal", "PROPOSAL"], ["Meeting", "meeting", "MEETING"], ["BrainArticle", "brainArticle", "BRAIN_ARTICLE"]] as const;

describe("execution lineage closure with real current permissions", () => {
  it.each(nativeKinds)("gates %s title matches, rank and context before samples", async (kind, model, type) => {
    const privateInput = await addInput("private", true);
    const visible = fixture.add(model, { id: "zz-visible", workspaceId, title: "Visible match", bodyMd: "Original", summaryMd: "Visible summary", summary: "Visible summary",
      status: "OPEN", slug: "visible", authority: "REFERENCE", type: "PROCESS", archivedAt: null, isPrivate: false, priority: 0,
      assigneeMemberId: null, raisedByMemberId: null, ownerMemberId: null, recordedAt: fixture.timestamp, updatedAt: fixture.timestamp });
    await known(kind, visible);
    for (let i = 0; i < 25; i++) {
      const hidden = fixture.add(model, { ...visible, id: `aa-hidden-${i}`, title: "PRIVATE MATCH CANARY", summaryMd: "PRIVATE SUMMARY CANARY",
        updatedAt: new Date(fixture.timestamp.getTime() + i + 1), recordedAt: new Date(fixture.timestamp.getTime() + i + 1) });
      if (i % 2) await known(kind, hidden, [{ kind: "BrainArticle", id: privateInput.id }]);
    }
    const targets = await listWritebackTargets(alpha, { workspaceId, targetTypes: [type], query: "match", take: 1 });
    expect(targets.items.map((row) => row.id)).toEqual([visible.id]);
    const captured = await withArtifactInputReadCapture(alpha, workspaceId, () => getCompanyContext(alpha, workspaceId));
    expect(JSON.stringify(captured.value)).not.toContain("CANARY");
    expect(captured.roots.some((root) => root.kind === kind && root.id === visible.id)).toBe(true);
    expect(captured.roots.some((root) => root.id.startsWith("aa-hidden"))).toBe(false);
    expect(fixture.prisma[model].findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5001 }));
    expect(fixture.prisma[model].findMany.mock.calls.every(([args]: any) => !args.select && !args.where.title)).toBe(true);
    await expect(request({ writebackTargetType: type, writebackTargetId: "aa-hidden-1" }, alpha)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    fixture.add("member", { id: "foreign-member", workspaceId: "ws-b", userId: "alpha", isActive: true, role: "ADMIN" });
    expect((await listWritebackTargets(alpha, { workspaceId: "ws-b", targetTypes: [type] })).items).toEqual([]);
  });

  it("captures authoritative populated User labels and redacts inactive affiliation IDs", async () => {
    Object.assign(fixture.rows.user.find((r) => r.id === "alpha"), { avatarUrl: "https://synthetic.test/a.png", linkedinUrl: "https://synthetic.test/alpha", websiteUrl: "https://synthetic.test" });
    const row = fixture.add("action", { id: "labeled", workspaceId, title: "Original action", bodyMd: "SECRET UNUSED BODY", status: "OPEN", isPrivate: false,
      assigneeMemberId: "member-alpha", archivedAt: null, priority: 2, dueAt: null, updatedAt: fixture.timestamp });
    await known("Action", row);
    const captured = await withArtifactInputReadCapture(beta, workspaceId, () => getCompanyContext(beta, workspaceId));
    expect((captured.value as any).recent.actions[0]).toMatchObject({ assigneeMemberId: "member-alpha", assignee: "Alpha" });
    expect(JSON.stringify(captured.value)).not.toContain("SECRET UNUSED BODY");
    expect(captured.roots.some((r) => r.kind === "Member" && r.id === "member-alpha")).toBe(true);
    expect(captured.roots.some((r) => r.kind === "User" && r.id === "alpha")).toBe(true);
    fixture.rows.member.find((r) => r.id === "member-alpha").isActive = false;
    expect((await getCompanyContext(beta, workspaceId) as any).recent.actions[0]).toMatchObject({ assigneeMemberId: null, assignee: null });
  });

  it("creates complete request receipts, gates replays/packets and never blesses unknown requests", async () => {
    const source = await addInput("private", true);
    const roots = await proof(source);
    await expect(request({ context: { title: "Unproved copy" } })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    const created = await request({ context: { title: source.title }, lineageRoots: roots, idempotencyKey: "recipe" });
    expect(fixture.manifest("ExecutionRequest", created.id).origin).toBe("DERIVED");
    await expect(getExecutionRequest(alpha, { workspaceId, requestId: created.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const packet = await getExecutionPacket(beta, { workspaceId, requestId: created.id });
    expect(packet).toMatchObject({ status: "IN_PROGRESS" });
    expect(await readableArtifactIds(beta, workspaceId, "ExecutionRequest", fixture.rows.executionRequest)).toEqual(new Set([created.id]));
    fixture.rows.brainArticle.find((r) => r.id === source.id).archivedAt = fixture.timestamp;
    await expect(request({ idempotencyKey: "recipe" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getExecutionPacket(beta, { workspaceId, requestId: created.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixture.add("executionRequest", { id: "unknown", workspaceId, createdByUserId: "beta", status: "PENDING", goal: "UNKNOWN CANARY" });
    expect(await listExecutionRequests(beta, { workspaceId, take: 1 })).toEqual([]);
  });

  it("records copied comment and failure results atomically and gates current ancestry on replay", async () => {
    const input = await addInput(); const roots = await proof(input);
    const created = await request();
    await expect(submitExecutionResult(beta, { workspaceId, requestId: created.id, idempotencyKey: "no-proof", output: { bodyMd: "unproved" } })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(fixture.rows.executionRequest[0].status).toBe("PENDING");
    expect(fixture.rows.executionResult).toEqual([]);
    const accepted = await submitExecutionResult(beta, { workspaceId, requestId: created.id, idempotencyKey: "once", output: { bodyMd: "Actual copied note" }, lineageRoots: roots });
    expect(accepted).toMatchObject({ status: "ACCEPTED", writeback: { entityType: "ExecutionResult", entityId: accepted.id } });
    expect(fixture.manifest("ExecutionResult", accepted.id).origin).toBe("DERIVED");
    expect(fixture.sources("ExecutionResult", accepted.id)).toContain(`ExecutionRequest:${created.id}`);
    expect(fixture.sources("ExecutionResult", accepted.id)).toContain(`BrainArticle:${input.id}`);
    expect((await submitExecutionResult(beta, { workspaceId, requestId: created.id, idempotencyKey: "once", output: { bodyMd: "Replay cannot replace" } })).output).toEqual({ bodyMd: "Actual copied note" });
    await expect(submitExecutionResult(alpha, { workspaceId, requestId: created.id, idempotencyKey: "once" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixture.rows.brainArticle.find((r) => r.id === input.id).archivedAt = fixture.timestamp;
    // Completion is a new derived current revision. Preserve the independent
    // original request rather than exposing a now-restricted completion state.
    await expect(getExecutionRequest(beta, { workspaceId, requestId: created.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const original = fixture.rows.artifactInputSnapshot.find(row => row.sourceKind === "ExecutionRequest"
      && row.sourceId === created.id && row.contentJson.status === "PENDING");
    expect(original.contentJson).toMatchObject({ goal: "Fresh requested task", status: "PENDING", contextJson: {} });
    expect(await readableArtifactIds(beta, workspaceId, "ArtifactInputSnapshot", [original])).toEqual(new Set([original.id]));
    await expect(submitExecutionResult(beta, { workspaceId, requestId: created.id, idempotencyKey: "once" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const failedRequest = await request({ writebackTargetType: null });
    const freshInput = await addInput("failure-input");
    expect(await submitExecutionResult(beta, { workspaceId, requestId: failedRequest.id, idempotencyKey: "failure", errorMessage: "Actual failure", lineageRoots: await proof(freshInput) })).toMatchObject({ status: "REJECTED", writeback: null });
  });

  it("carries immutable Result ancestry into an actual private Action and rolls back native failures", async () => {
    const input = await addInput("private", true); const roots = await proof(input);
    const created = await request({ writebackTargetType: "ACTION" });
    const result = await submitExecutionResult(beta, { workspaceId, requestId: created.id, idempotencyKey: "native", output: { title: "Derived draft", bodyMd: "Copied body" }, lineageRoots: roots });
    expect(result).toMatchObject({ status: "ACCEPTED", writeback: { entityType: "Action" } });
    const action = fixture.rows.action.find((r) => r.id === result.writeback?.entityId)!;
    expect(action).toMatchObject({ authorUserId: "beta", isPrivate: true, status: "DRAFT" });
    expect(fixture.sources("Action", action.id)).toContain(`ExecutionResult:${result.id}`);
    expect(fixture.sources("Action", action.id)).toContain(`BrainArticle:${input.id}`);
    expect(await readableArtifactIds(alpha, workspaceId, "Action", [action])).toEqual(new Set());
    expect(await readableArtifactIds(beta, workspaceId, "Action", [action])).toEqual(new Set([action.id]));
    const retry = await request({ writebackTargetType: "ACTION" });
    const sourceCount = fixture.rows.artifactInputLineage.length;
    fixture.prisma.action.create.mockRejectedValueOnce(new Error("native writer failed"));
    await expect(submitExecutionResult(beta, { workspaceId, requestId: retry.id, idempotencyKey: "rollback", output: { title: "Must rollback" }, lineageRoots: roots })).rejects.toThrow("native writer failed");
    expect(fixture.rows.executionRequest.find((r) => r.id === retry.id).status).toBe("PENDING");
    expect(fixture.rows.executionResult).toHaveLength(1);
    expect(fixture.rows.artifactInputLineage).toHaveLength(sourceCount);
    // Read-side epoch capture adds transactions; assert the durable proof and
    // rollback outcome above instead of counting implementation-level calls.
    expect(fixture.manifest("Action", action.id)).toMatchObject({ epochProofVersion: 1,
      permissionEpochsJson: { entries: expect.arrayContaining([{ kind: "Action", id: action.id, epoch: "0" }]) },
    });
  });

  it("rechecks actual source and recipient membership before acceptance and rolls back the whole result", async () => {
    const input = await addInput(); const roots = await proof(input);
    const created = await request();
    const create = fixture.prisma.executionResult.create.getMockImplementation();
    fixture.prisma.executionResult.create.mockImplementationOnce(async (args: any) => {
      const row = await create(args);
      fixture.rows.brainArticle.find((r) => r.id === input.id).archivedAt = fixture.timestamp;
      return row;
    });
    await expect(submitExecutionResult(beta, { workspaceId, requestId: created.id, idempotencyKey: "archive-drift", output: { bodyMd: "Cannot accept" }, lineageRoots: roots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.rows.executionResult).toEqual([]);
    expect(fixture.rows.executionRequest[0].status).toBe("PENDING");
    fixture.prisma.executionResult.create.mockImplementationOnce(async (args: any) => {
      const row = await create(args);
      fixture.rows.member.find((r) => r.id === "member-beta").isActive = false;
      return row;
    });
    await expect(submitExecutionResult(beta, { workspaceId, requestId: created.id, idempotencyKey: "member-drift", output: { bodyMd: "Cannot accept" }, lineageRoots: roots })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(fixture.rows.executionResult).toEqual([]);
    expect(fixture.rows.executionRequest[0].status).toBe("PENDING");
  });

  it("binds credential comment output to the actual credential and checks live scopes on replay", async () => {
    const scopes = ["execution:read", "execution:write", "workspace:read", "brain:read"];
    const credential = fixture.add("agentCredential", { id: "credential", workspaceId, isActive: true, tokenHash: "synthetic-hash", scopes });
    const actor: AppActor = { kind: "agent", authProvider: "credential", credentialId: credential.id, credentialVersion: mcpCredentialVersion(credential.tokenHash), workspaceIds: [workspaceId], scopes, label: "Synthetic provider" };
    const input = await addInput(); const roots = await proof(input, actor);
    const created = await request({ lineageRoots: roots, copied: true }, actor);
    const result = await submitExecutionResult(actor, { workspaceId, requestId: created.id, idempotencyKey: "actual-owner", output: { bodyMd: "Credential private result" }, lineageRoots: roots });
    expect(fixture.rows.executionResult[0]).toMatchObject({ submittedByUserId: null, agentCredentialId: credential.id });
    expect((await getExecutionRequest(beta, { workspaceId, requestId: created.id })).results).toEqual([]);
    expect(await readableArtifactIds(actor, workspaceId, "ExecutionResult", fixture.rows.executionResult)).toEqual(new Set([result.id]));
    fixture.rows.agentCredential.find((r) => r.id === credential.id).scopes = ["execution:write"];
    await expect(submitExecutionResult(actor, { workspaceId, requestId: created.id, idempotencyKey: "actual-owner" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires the live transitive source-family grant and exact scope hash for COMMENT input", async () => {
    const input = await addInput();
    const scopes = ["execution:read", "execution:write", "workspace:read"];
    const credential = fixture.add("agentCredential", { id: "scoped", workspaceId, isActive: true, tokenHash: "synthetic-hash", scopes: [...scopes] });
    const actor: AppActor = { kind: "agent", authProvider: "credential", credentialId: credential.id, credentialVersion: mcpCredentialVersion(credential.tokenHash), workspaceIds: [workspaceId], scopes: [...scopes], label: "Synthetic provider" };
    await expect(proof(input, actor)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    credential.scopes = [...scopes, "brain:read"];
    await expect(proof(input, actor)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" }); // actor's scope hash is stale
    const current = { ...actor, scopes: [...credential.scopes] };
    const roots = await proof(input, current);
    const created = await request({ lineageRoots: roots, copied: true }, current);
    fixture.rows.agentCredential.find((r) => r.id === credential.id).scopes = [...scopes];
    const revoked = { ...current, scopes: [...scopes] };
    await expect(getExecutionPacket(revoked, { workspaceId, requestId: created.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(submitExecutionResult(revoked, { workspaceId, requestId: created.id, idempotencyKey: "revoked", output: { bodyMd: "Blocked" }, lineageRoots: roots })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fixture.rows.executionResult).toEqual([]);
    expect(fixture.rows.executionRequest[0].status).toBe("PENDING");
  });

  it("never converts a credential into its administrative fallback user to own a private draft", async () => {
    const scopes = ["execution:read", "execution:write", "workspace:read", "brain:read", "actions:read", "actions:write"];
    const credential = fixture.add("agentCredential", { id: "credential", workspaceId, isActive: true, tokenHash: "synthetic-hash", scopes });
    const actor: AppActor = { kind: "agent", authProvider: "credential", credentialId: credential.id, credentialVersion: mcpCredentialVersion(credential.tokenHash), workspaceIds: [workspaceId], scopes, label: "Synthetic provider" };
    const input = await addInput(); const roots = await proof(input, actor);
    const created = await request({ writebackTargetType: "ACTION", lineageRoots: roots, copied: true }, actor);
    await expect(submitExecutionResult(actor, { workspaceId, requestId: created.id, idempotencyKey: "private", output: { title: "Private output" }, lineageRoots: roots })).rejects.toMatchObject({ code: "PRIVATE_AGENT_ARTIFACT_UNSUPPORTED" });
    expect(fixture.rows.executionRequest[0].status).toBe("PENDING");
    expect(fixture.rows.executionResult).toEqual([]);
    expect(fixture.rows.action).toEqual([]);
    fixture.rows.agentCredential.find((r) => r.id === credential.id).isActive = false;
    await expect(getExecutionRequest(actor, { workspaceId, requestId: created.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
