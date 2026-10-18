import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { listPolicyCorpus } from "./constitutions";
import { createNotificationIntent } from "./notifications";
import * as lineage from "./source-lineage";
import { AppError } from "./errors";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic policy intent", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, displayName: "Synthetic author", passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  return { workspaceId: workspace.id, actor, member };
}
async function policyFixture() {
  const f = await fixture();
  const circle = await prisma.circle.create({ data: { workspaceId: f.workspaceId, name: "Original circle" } });
  const proposal = await prisma.proposal.create({ data: { workspaceId: f.workspaceId, authorUserId: f.actor.kind === "user" ? f.actor.user.id : "",
    title: "Original proposal", bodyMd: "Original source", status: "RESOLVED", resolutionOutcome: "ADOPTED", publishedAt: new Date() } });
  const policy = await prisma.policyCorpus.create({ data: { workspaceId: f.workspaceId, proposalId: proposal.id, circleId: circle.id,
    title: "Original policy", bodyMd: "Original policy body", acceptedAt: new Date() } });
  await prisma.$transaction(async tx => {
    await lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId, artifact: { kind: "Circle", id: circle.id }, content: circle, origin: "HUMAN_ORIGINAL", inputs: [] });
    await lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId, artifact: { kind: "Proposal", id: proposal.id }, content: proposal, origin: "HUMAN_ORIGINAL", inputs: [] });
    await lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId, artifact: { kind: "PolicyCorpus", id: policy.id }, content: policy, origin: "DERIVED", inputs: [{ kind: "Proposal", id: proposal.id }] });
  });
  return { ...f, circle, proposal, policy };
}

it("releases proven policy bodies and admitted proposal/circle projections", async () => {
  const f = await policyFixture();
  await expect(listPolicyCorpus(f.actor, f.workspaceId)).resolves.toMatchObject([{
    id: f.policy.id, bodyMd: f.policy.bodyMd, proposalId: f.proposal.id,
    proposal: { id: f.proposal.id, title: f.proposal.title, status: f.proposal.status },
    circleId: f.circle.id, circle: { id: f.circle.id, name: f.circle.name },
  }]);
});

it.each(["policy-head", "input-restore", "caller-restore", "circle-label", "circle-head"] as const)(
  "withholds original policy and joined projections after late %s", async mode => {
    const f = await policyFixture();
    const barrierKind = mode.startsWith("circle") ? "Circle" : "Proposal";
    let changed = false;
    const change = async () => {
      if (changed) return; changed = true;
      if (mode === "caller-restore") {
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
      } else if (mode === "input-restore") {
        await prisma.proposal.update({ where: { id: f.proposal.id }, data: { isPrivate: true } });
        await prisma.proposal.update({ where: { id: f.proposal.id }, data: { isPrivate: false } });
      } else if (mode === "circle-label") {
        await prisma.circle.update({ where: { id: f.circle.id }, data: { name: "Changed circle" } });
      } else if (mode === "circle-head") {
        await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
          artifact: { kind: "Circle", id: f.circle.id }, content: f.circle, origin: "HUMAN_ORIGINAL", inputs: [] }));
      } else {
        await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
          artifact: { kind: "PolicyCorpus", id: f.policy.id }, content: f.policy, origin: "DERIVED", inputs: [{ kind: "Proposal", id: f.proposal.id }] }));
      }
    };
    // The baseline uses readableArtifactIds; the corrected shared release uses
    // captureArtifactInputProof. Both barriers run AFTER actual join admission.
    const readable = lineage.readableArtifactIds;
    vi.spyOn(lineage, "readableArtifactIds").mockImplementation(async (...args) => {
      const result = await readable(...args); if (args[2] === barrierKind) await change(); return result;
    });
    const capture = lineage.captureArtifactInputProof;
    vi.spyOn(lineage, "captureArtifactInputProof").mockImplementation(async (...args) => {
      const result = await capture(...args); if (args[2].some(input => input.kind === barrierKind)) await change(); return result;
    });
    await expect(listPolicyCorpus(f.actor, f.workspaceId)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(changed).toBe(true);
  });

it.each(["database-error", "unexpected-app-error"] as const)(
  "rolls back all producer intent writes on %s and retries each recipient exactly once", async mode => {
    const f = await fixture();
    const source = await prisma.brainSource.create({ data: { workspaceId: f.workspaceId, sourceType: "DOC", tier: 1, content: "Synthetic notification source" } });
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const recipients: string[] = [];
    for (let index = 0; index < 2; index++) {
      const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, displayName: `Recipient ${index}`, passwordHash: "synthetic" } });
      await prisma.member.create({ data: { workspaceId: f.workspaceId, userId: user.id, role: "CONTRIBUTOR" } });
      await prisma.notificationPreference.create({ data: { userId: user.id, notifType: "deliberation.mention", channel: "EMAIL" } });
      recipients.push(user.id);
    }
    const lineageRoots = await lineage.captureArtifactInputProof(f.actor, f.workspaceId, [{ kind: "BrainSource", id: source.id }]);
    const params = { workspaceId: f.workspaceId, lineageActor: f.actor, lineageRoots,
      recipientUserIds: [...recipients, recipients[0]!], type: "deliberation.mention", title: "Retry-safe notification", dedupeKey: `synthetic:${f.workspaceId}` };
    const failure = mode === "database-error" ? new Error("Synthetic proof database unavailable") : new AppError(503, "DATABASE_UNAVAILABLE", "Synthetic proof unavailable");
    const readable = lineage.readableArtifactIds;
    let admissions = 0;
    const spy = vi.spyOn(lineage, "readableArtifactIds").mockImplementation(async (...args) => {
      if (args[2] === "Notification" && ++admissions === 2) throw failure;
      return readable(...args);
    });
    const create = () => prisma.$transaction(tx => createNotificationIntent(tx, params), { timeout: 30_000 });
    const outcome = await create().then(value => ({ value }), error => ({ error }));
    expect(admissions).toBe(2);
    expect(outcome).toEqual({ error: failure });
    expect(await prisma.notification.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    expect(await prisma.notificationDelivery.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    expect(await prisma.workflowJob.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspaceId, artifactType: "Notification" } })).toBe(0);
    spy.mockRestore();
    await expect(create()).resolves.toEqual({ count: 2 });
    await expect(create()).resolves.toEqual({ count: 2 });
    expect(await prisma.notification.count({ where: { workspaceId: f.workspaceId } })).toBe(2);
    expect(await prisma.notificationDelivery.count({ where: { workspaceId: f.workspaceId, status: "PENDING" } })).toBe(2);
    expect(await prisma.workflowJob.count({ where: { workspaceId: f.workspaceId, type: "notification.delivery" } })).toBe(2);
  }, 60_000);
