import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma as db, mcpCredentialVersion, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { inspectLegacyRecovery, recoverLegacyArtifact, type LegacyRecoveryKind } from "./legacy-recovery";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";
import * as lineage from "./source-lineage";
import { prepareArtifactSourceCommit, withArtifactSourceCommit } from "./artifact-source-commit";
import { assertSourceCommitRowCovered, assertSourceCommitSemanticRootCovered } from "./source-commit-lock-plan";
import { discoverSourceAuthorityEdges } from "./source-authority-edges";
import { getGoal, listGoals, updateGoal, updateKeyResult } from "./goals";
const auth = vi.hoisted(() => ({ actor: vi.fn() }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: auth.actor }));
beforeEach(async () => { await truncateAllTables(); auth.actor.mockReset(); });
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Legacy goals", slug: randomUUID() } });
  const users = await Promise.all(["admin", "peer"].map(name => db.user.create({ data: { email: `${name}-${randomUUID()}@goals.test`, passwordHash: "synthetic" } })));
  const members = await Promise.all(users.map((user, i) => db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: i === 0 ? "ADMIN" : "CONTRIBUTOR" } })));
  const admin: AppActor = { kind: "user", user: users[0] }, peer: AppActor = { kind: "user", user: users[1] };
  const goal = await db.goal.create({ data: { workspaceId: workspace.id, title: "Historical goal", descriptionMd: "Original content", status: "ACTIVE", authorUserId: users[1].id } });
  const keyResult = await db.keyResult.create({ data: { goalId: goal.id, title: "Original measure", targetValue: 10, currentValue: 2, progressPercent: 20 } });
  const update = await db.goalUpdate.create({ data: { goalId: goal.id, bodyMd: "Original update" } });
  const selection = (kind: string, id: string) => ({ workspaceId: workspace.id, kind: kind as LegacyRecoveryKind, id });
  const request = async (kind: string, id: string) => ({ ...selection(kind, id), expectedFingerprint: (await inspectLegacyRecovery(admin, selection(kind, id))).fingerprint, requestId: randomUUID(), consent: "RESTORE_SELECTED_HISTORY" as const });
  const restore = async (kind: string, id: string) => recoverLegacyArtifact(admin, await request(kind, id));
  return { workspace, users, members, admin, peer, goal, keyResult, update, selection, request, restore };
}
describe("selected legacy Goal recovery", () => {
  it("restores the selected Goal through the route, leaves unknown children withheld, then restores each child explicitly", async () => {
    const f = await fixture();
    expect(await listGoals(f.peer, { workspaceId: f.workspace.id })).toEqual([]);
    await expect(getGoal(f.admin, { workspaceId: f.workspace.id, goalId: f.goal.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updateGoal(f.admin, { workspaceId: f.workspace.id, goalId: f.goal.id, title: "An edit is not recovery", expectedVersion: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.artifactInputLineage.count()).toBe(0);
    auth.actor.mockResolvedValue(f.admin);
    const { GET, POST } = await import("../../../apps/web/app/api/workspaces/[workspaceId]/history-recovery/route");
    const context = { params: Promise.resolve({ workspaceId: f.workspace.id }) };
    for (const [kind, row] of [["Goal", f.goal], ["KeyResult", f.keyResult], ["GoalUpdate", f.update]] as const) {
      const inspected = await GET(new NextRequest(`http://localhost/recovery?kind=${kind}&id=${row.id}`), context);
      expect(inspected.status).toBe(200);
      const body = { kind, id: row.id, expectedFingerprint: (await inspected.json()).fingerprint, requestId: randomUUID(), consent: "RESTORE_SELECTED_HISTORY" };
      const post = () => POST(new NextRequest("http://localhost/recovery", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), context);
      const response = await post();
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ kind, id: row.id, basis: "CURRENT_ATTESTATION", projection: { status: "NOT_REQUIRED" } });
      expect(await (await post()).json()).toEqual(result);
      if (kind === "Goal") expect(await getGoal(f.peer, { workspaceId: f.workspace.id, goalId: f.goal.id })).toMatchObject({ keyResults: [], updates: [] });
    }
    expect(await getGoal(f.peer, { workspaceId: f.workspace.id, goalId: f.goal.id })).toMatchObject({ id: f.goal.id, keyResults: [{ id: f.keyResult.id }], updates: [{ id: f.update.id }] });
    expect(await listGoals(f.peer, { workspaceId: f.workspace.id })).toMatchObject([{ id: f.goal.id, keyResults: [{ id: f.keyResult.id }] }]);
    expect(await db.goal.findUniqueOrThrow({ where: { id: f.goal.id } })).toEqual(f.goal);
    expect(await db.keyResult.findUniqueOrThrow({ where: { id: f.keyResult.id } })).toEqual(f.keyResult);
    expect(await db.goalUpdate.findUniqueOrThrow({ where: { id: f.update.id } })).toEqual(f.update);
    expect(await db.conversationOperationOutcome.count()).toBe(3);
    expect((await db.artifactInputLineage.findMany({ where: { artifactType: { in: ["Goal", "KeyResult", "GoalUpdate"] } } })).map(row => row.origin)).toEqual(["DERIVED", "DERIVED", "DERIVED"]);
    await db.member.update({ where: { id: f.members[0].id }, data: { isActive: false } });
    expect(await getGoal(f.peer, { workspaceId: f.workspace.id, goalId: f.goal.id })).toMatchObject({ keyResults: [{ id: f.keyResult.id }], updates: [{ id: f.update.id }] });
  });
  it("allows a recovered KeyResult update through the governed workflow without certifying untouched history", async () => {
    const f = await fixture();
    await f.restore("Goal", f.goal.id);
    await f.restore("KeyResult", f.keyResult.id);
    await updateKeyResult(f.admin, { workspaceId: f.workspace.id, krId: f.keyResult.id, currentValue: 4, expectedVersion: 1 });
    expect(await getGoal(f.peer, { workspaceId: f.workspace.id, goalId: f.goal.id })).toMatchObject({ progressPercent: 40, keyResults: [{ id: f.keyResult.id, currentValue: 4 }], updates: [] });
    expect(await db.artifactInputLineage.count({ where: { artifactType: "GoalUpdate", artifactId: f.update.id } })).toBe(0);
  });
  it("requires a current admin, explicit consent, same tenant and readable parent; binds retries to the exact target", async () => {
    const f = await fixture();
    await expect(inspectLegacyRecovery(f.peer, f.selection("Goal", f.goal.id))).rejects.toMatchObject({ code: "RECOVERY_ADMIN_REQUIRED" });
    await expect(f.request("KeyResult", f.keyResult.id)).rejects.toThrow();
    await expect(f.request("GoalUpdate", f.update.id)).rejects.toThrow();
    const request = await f.request("Goal", f.goal.id);
    await expect(recoverLegacyArtifact(f.admin, { ...request, consent: "" as never })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const other = await db.workspace.create({ data: { name: "Foreign", slug: randomUUID() } });
    await db.member.create({ data: { workspaceId: other.id, userId: f.users[0].id, role: "ADMIN" } });
    for (const [kind, row] of [["Goal", f.goal], ["KeyResult", f.keyResult], ["GoalUpdate", f.update]] as const) {
      await expect(inspectLegacyRecovery(f.admin, { ...f.selection(kind, row.id), workspaceId: other.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await recoverLegacyArtifact(f.admin, request);
    const childRequest = await f.request("KeyResult", f.keyResult.id);
    await expect(recoverLegacyArtifact(f.admin, { ...childRequest, requestId: request.requestId })).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" });
    await db.keyResult.update({ where: { id: f.keyResult.id }, data: { title: "Changed after inspection" } });
    await expect(recoverLegacyArtifact(f.admin, childRequest)).rejects.toMatchObject({ code: "RECOVERY_STALE" });
    const goalRequest = await f.request("Goal", f.goal.id);
    await db.goal.update({ where: { id: f.goal.id }, data: { title: "Changed Goal" } });
    await expect(recoverLegacyArtifact(f.admin, goalRequest)).rejects.toMatchObject({ code: "RECOVERY_STALE" });
    expect(await db.conversationOperationOutcome.count()).toBe(1);
  });
  it("rejects caller authority revoked and restored immediately before publication without writing a receipt", async () => {
    const f = await fixture();
    const request = await f.request("Goal", f.goal.id);
    const captureEpochs = lineage.captureArtifactPermissionEpochs;
    vi.spyOn(lineage, "captureArtifactPermissionEpochs").mockImplementationOnce(async (...args) => {
      const epochs = await captureEpochs(...args);
      await db.member.update({ where: { id: f.members[0].id }, data: { role: "CONTRIBUTOR" } });
      await db.member.update({ where: { id: f.members[0].id }, data: { role: "ADMIN" } });
      return epochs;
    });
    await expect(recoverLegacyArtifact(f.admin, request)).rejects.toMatchObject({ code: "RECOVERY_STALE" });
    expect(await db.conversationOperationOutcome.count()).toBe(0);
    expect(await db.artifactInputLineage.count()).toBe(0);
  });
  it("keeps private Goals and their children restricted and never restores revoked historical contributors", async () => {
    const f = await fixture();
    await db.goal.update({ where: { id: f.goal.id }, data: { authorUserId: f.users[0].id, status: "DRAFT", isPrivate: true } });
    await f.restore("Goal", f.goal.id);
    await f.restore("KeyResult", f.keyResult.id);
    await f.restore("GoalUpdate", f.update.id);
    expect(await getGoal(f.admin, { workspaceId: f.workspace.id, goalId: f.goal.id })).toMatchObject({ keyResults: [{ id: f.keyResult.id }], updates: [{ id: f.update.id }] });
    await expect(getGoal(f.peer, { workspaceId: f.workspace.id, goalId: f.goal.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const [kind, row] of [["Goal", f.goal], ["KeyResult", f.keyResult], ["GoalUpdate", f.update]] as const) {
      const proof = await captureArtifactInputProof(f.admin, f.workspace.id, [{ kind, id: row.id }]);
      expect(await isArtifactInputProofReadable(f.peer, f.workspace.id, proof)).toBe(false);
    }
    await db.goal.update({ where: { id: f.goal.id }, data: { archivedAt: new Date() } });
    await expect(f.request("KeyResult", f.keyResult.id)).rejects.toThrow();
    await db.goal.update({ where: { id: f.goal.id }, data: { archivedAt: null } });
    await expect(f.request("Goal", f.goal.id)).rejects.toThrow();
  });
  it("retains known private source restrictions on company Goals and children", async () => {
    const f = await fixture();
    const source = await db.action.create({ data: { workspaceId: f.workspace.id, authorUserId: f.users[0].id, title: "Private source", status: "DRAFT", isPrivate: true } });
    await db.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.admin, workspaceId: f.workspace.id, artifact: { kind: "Action", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const roots = await captureArtifactInputProof(f.admin, f.workspace.id, [{ kind: "Action", id: source.id }]);
    await db.artifactInputLineage.create({ data: { workspaceId: f.workspace.id, artifactType: "Goal", artifactId: f.goal.id, revision: 1, origin: "UNKNOWN", contentHash: lineageContentFingerprint("Goal", f.goal), inputsJson: [], rootsJson: JSON.parse(JSON.stringify(roots)) } });
    await f.restore("Goal", f.goal.id);
    await f.restore("KeyResult", f.keyResult.id);
    await f.restore("GoalUpdate", f.update.id);
    expect(await listGoals(f.peer, { workspaceId: f.workspace.id })).toEqual([]);
    expect(await getGoal(f.admin, { workspaceId: f.workspace.id, goalId: f.goal.id })).toMatchObject({ keyResults: [{ id: f.keyResult.id }], updates: [{ id: f.update.id }] });
    await db.action.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
    await db.action.update({ where: { id: source.id }, data: { archivedAt: null } });
    await expect(f.request("Goal", f.goal.id)).rejects.toThrow();
    expect(await listGoals(f.admin, { workspaceId: f.workspace.id })).toEqual([]);
  });
  it("requires a human recovery caller while preserving current credential scopes on recovered company goals", async () => {
    const f = await fixture();
    const credential = await db.agentCredential.create({ data: { workspaceId: f.workspace.id, label: "Scoped goal reader", tokenHash: randomUUID(), scopes: ["goals:read"] } });
    const agent: AppActor = { kind: "agent", authProvider: "credential", label: "Synthetic", workspaceIds: [f.workspace.id], credentialId: credential.id, credentialVersion: mcpCredentialVersion(credential.tokenHash), scopes: credential.scopes };
    await expect(inspectLegacyRecovery(agent, f.selection("Goal", f.goal.id))).rejects.toMatchObject({ code: "RECOVERY_HUMAN_REQUIRED" });
    const request = await f.request("Goal", f.goal.id);
    await expect(recoverLegacyArtifact(agent, request)).rejects.toMatchObject({ code: "RECOVERY_HUMAN_REQUIRED" });
    await recoverLegacyArtifact(f.admin, request);
    await f.restore("KeyResult", f.keyResult.id);
    await f.restore("GoalUpdate", f.update.id);
    for (const [kind, row] of [["Goal", f.goal], ["KeyResult", f.keyResult], ["GoalUpdate", f.update]] as const) {
      const proof = await captureArtifactInputProof(agent, f.workspace.id, [{ kind, id: row.id }]);
      expect(await isArtifactInputProofReadable({ ...agent, scopes: ["workspace:read"] }, f.workspace.id, proof)).toBe(false);
    }
    await db.agentCredential.update({ where: { id: credential.id }, data: { isActive: false } });
    await expect(captureArtifactInputProof(agent, f.workspace.id, [{ kind: "Goal", id: f.goal.id }])).rejects.toThrow();
    await db.member.update({ where: { id: f.members[0].id }, data: { role: "CONTRIBUTOR" } });
    await expect(recoverLegacyArtifact(f.admin, request)).rejects.toMatchObject({ code: "RECOVERY_ADMIN_REQUIRED" });
  });
  it.each(["KeyResult", "GoalUpdate"] as const)("locks a recovered %s and parent in a downstream governed commit", async kind => {
    const f = await fixture();
    await f.restore("Goal", f.goal.id);
    const child = kind === "KeyResult" ? f.keyResult : f.update;
    await f.restore(kind, child.id);
    const roots = await captureArtifactInputProof(f.admin, f.workspace.id, [{ kind, id: child.id }]);
    const options = { writeTargets: [], ownerBinding: { kind: "HUMAN_REQUEST" as const, id: randomUUID(), generation: 1 } };
    const prepared = await prepareArtifactSourceCommit(f.admin, f.workspace.id, roots, options);
    const result = await db.$transaction(tx => withArtifactSourceCommit(f.admin, f.workspace.id, tx,
      roots, options, prepared, async connection => {
        expect(await connection.member.findFirst({ where: { id: f.members[0].id, workspaceId: f.workspace.id,
          userId: f.users[0].id, isActive: true, role: "ADMIN" } })).not.toBeNull();
      }, async () => {
        assertSourceCommitRowCovered(tx, kind, child.id);
        assertSourceCommitRowCovered(tx, "Goal", f.goal.id);
        return isArtifactInputProofReadable(f.admin, f.workspace.id, roots, tx);
      }), { timeout: 30_000 });
    expect(result).toBe(true);
    expect(await db.goal.findUniqueOrThrow({ where: { id: f.goal.id } })).toEqual(f.goal);
  });

  it.each(["KeyResult", "GoalUpdate"] as const)("rejects a recovered %s authority target through a foreign parent scope", async kind => {
    const f = await fixture();
    await f.restore("Goal", f.goal.id);
    const child = kind === "KeyResult" ? f.keyResult : f.update;
    await f.restore(kind, child.id);
    const outcome = await db.conversationOperationOutcome.findFirstOrThrow({ where: {
      workspaceId: f.workspace.id, operation: "LEGACY_RECOVERY_PUBLICATION" }, orderBy: { createdAt: "desc" } });
    const foreign = await db.workspace.create({ data: { name: "Foreign authority", slug: randomUUID() } });
    await expect(discoverSourceAuthorityEdges({ actor: f.admin, workspaceId: foreign.id, db,
      budget: { consume() {}, remaining: () => 1_000 } },
    { kind: "ConversationOperationOutcome", id: outcome.id }, outcome)).rejects.toMatchObject({ code: "SOURCE_LOCK_INCOMPLETE" });
  });

  it.each(["parent-epoch", "caller"] as const)("withholds a recovered child commit after %s changes following preparation", async change => {
    const f = await fixture();
    await f.restore("Goal", f.goal.id);
    await f.restore("KeyResult", f.keyResult.id);
    const roots = await captureArtifactInputProof(f.admin, f.workspace.id, [{ kind: "KeyResult", id: f.keyResult.id }]);
    const options = { writeTargets: [], ownerBinding: { kind: "HUMAN_REQUEST" as const, id: randomUUID(), generation: 1 } };
    const prepared = await prepareArtifactSourceCommit(f.admin, f.workspace.id, roots, options);
    if (change === "parent-epoch") {
      await db.goal.update({ where: { id: f.goal.id }, data: { archivedAt: new Date() } });
      await db.goal.update({ where: { id: f.goal.id }, data: { archivedAt: null } });
    } else await db.member.update({ where: { id: f.members[0].id }, data: { isActive: false } });
    const work = vi.fn(async () => true);
    await expect(db.$transaction(tx => withArtifactSourceCommit(f.admin, f.workspace.id, tx,
      roots, options, prepared, async connection => {
        if (!await connection.member.findFirst({ where: { id: f.members[0].id, workspaceId: f.workspace.id,
          userId: f.users[0].id, isActive: true, role: "ADMIN" } })) throw new Error("Owner is not current");
      }, work), { timeout: 30_000 })).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  });

  it("does not promote a recovery output's governing ancestry into consumed semantic inputs", async () => {
    const f = await fixture();
    await f.restore("Goal", f.goal.id);
    await f.restore("GoalUpdate", f.update.id);
    const outcome = await db.conversationOperationOutcome.findFirstOrThrow({ where: {
      workspaceId: f.workspace.id, operation: "LEGACY_RECOVERY_PUBLICATION" }, orderBy: { createdAt: "desc" } });
    const roots = await captureArtifactInputProof(f.admin, f.workspace.id, [{ kind: "User", id: f.users[0].id }]);
    const goalRoot = (await captureArtifactInputProof(f.admin, f.workspace.id, [{ kind: "Goal", id: f.goal.id }]))[0]!;
    const options = { writeTargets: [{ kind: "ConversationOperationOutcome" as const, id: outcome.id }],
      ownerBinding: { kind: "HUMAN_REQUEST" as const, id: randomUUID(), generation: 1 } };
    const prepared = await prepareArtifactSourceCommit(f.admin, f.workspace.id, roots, options);
    await db.$transaction(tx => withArtifactSourceCommit(f.admin, f.workspace.id, tx,
      roots, options, prepared, async connection => {
        expect(await connection.member.findFirst({ where: { id: f.members[0].id, workspaceId: f.workspace.id,
          userId: f.users[0].id, isActive: true, role: "ADMIN" } })).not.toBeNull();
      }, async () => {
        assertSourceCommitRowCovered(tx, "Goal", f.goal.id);
        expect(() => assertSourceCommitSemanticRootCovered(tx, f.workspace.id, goalRoot)).toThrowError(/not consumed or verified/);
      }), { timeout: 30_000 });
  });

});
