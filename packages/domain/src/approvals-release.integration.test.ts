import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { listActionableApprovalFlows, listProposalDecisionStates } from "./approvals";
import * as lineage from "./source-lineage";

beforeAll(async () => { await prisma.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pg_stat_statements"); });
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture(count = 2, children = true) {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic approvals", slug: randomUUID() } });
  const author = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const reader = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Reviewer" } });
  const authorMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: author.id, role: "ADMIN" } });
  const readerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: reader.displayName } };
  const owner: AppActor = { kind: "user", user: { id: author.id, email: author.email, displayName: "Author" } };
  const proposals = [], flows = [];
  for (let i = 0; i < count; i++) {
    const proposal = await prisma.proposal.create({ data: { workspaceId: workspace.id, authorUserId: author.id,
      title: `Proposal ${i}`, bodyMd: "Synthetic original", status: "OPEN", isPrivate: false } });
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: owner, workspaceId: workspace.id,
      artifact: { kind: "Proposal", id: proposal.id }, content: proposal, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const flow = await prisma.approvalFlow.create({ data: { workspaceId: workspace.id, subjectType: "PROPOSAL",
      subjectId: proposal.id, mode: "CONSENT", status: "ACTIVE", createdByUserId: author.id,
      createdAt: new Date(Date.UTC(2026, 9, 15, 0, 0, count - i)) } });
    await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor: owner, workspaceId: workspace.id,
      artifact: { kind: "ApprovalFlow", id: flow.id }, content: flow, origin: "DERIVED", inputs: [{ kind: "Proposal", id: proposal.id }] }));
    if (children) {
      const decision = await prisma.approvalDecision.create({ data: { flowId: flow.id, memberId: readerMember.id,
        choice: "AGREE", rationale: `Rationale ${i}` } });
      const objection = await prisma.objection.create({ data: { flowId: flow.id, userId: reader.id, bodyMd: `Objection ${i}` } });
      for (const [kind, row] of [["ApprovalDecision", decision], ["Objection", objection]] as const) {
        await prisma.$transaction(tx => lineage.recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
          artifact: { kind, id: row.id }, content: row, origin: "DERIVED", inputs: [{ kind: "Proposal", id: proposal.id }] }));
      }
    }
    proposals.push(proposal); flows.push(flow);
  }
  return { workspaceId: workspace.id, actor, owner, authorMember, readerMember, proposals, flows };
}

async function queryCalls() {
  const rows = await prisma.$queryRaw<Array<{ calls: bigint }>>`SELECT COALESCE(sum(calls), 0)::bigint AS calls FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return Number(rows[0].calls);
}

it.each([false, true])("collects a normal 200-flow decision page with bounded kind authorizations (children=%s)", async children => {
  const f = await fixture(200, children);
  const reads = vi.spyOn(lineage, "readableArtifactIds");
  const before = await queryCalls(); const started = Date.now();
  const states = await listProposalDecisionStates(f.actor, { workspaceId: f.workspaceId, proposalIds: f.proposals.map(row => row.id) });
  const calls = await queryCalls() - before;
  process.stdout.write("APPROVAL_QUERY_RECEIPT " + JSON.stringify({ flows: 200, children, sqlCalls: calls, durationMs: Date.now() - started,
    authorizationCalls: reads.mock.calls.length, authorizationPageSizes: reads.mock.calls.map(call => [call[2], call[3].length]) }) + "\n");
  expect(states.size).toBe(200);
  expect(calls).toBeLessThan(5_000);
  expect(reads.mock.calls.length).toBeLessThanOrEqual(10);
  expect(reads.mock.calls.every(call => call[3].length <= 100)).toBe(true);
}, 120_000);

for (const consumer of ["states", "actionable"] as const) {
  describe(`${consumer} approval release`, () => {
    const read = async (f: Awaited<ReturnType<typeof fixture>>) => consumer === "states"
      ? listProposalDecisionStates(f.actor, { workspaceId: f.workspaceId, proposalIds: f.proposals.map(row => row.id) })
      : listActionableApprovalFlows(f.actor, f.workspaceId);
    it("preserves decisions, rationales, objection bodies, reviewer identities and defaults", async () => {
      const f = await fixture();
      const result = await read(f);
      if (result instanceof Map) {
        expect(result.size).toBe(2);
        expect(result.get(f.proposals[0].id)).toMatchObject({ currentMemberDecision: { choice: "AGREE", rationale: "Rationale 0" },
          openObjections: [{ bodyMd: "Objection 0", user: { displayName: "Reviewer" } }],
          reviewers: [{ memberId: f.readerMember.id, name: "Reviewer" }], canReview: true, needsReview: false });
      } else expect(result).toMatchObject({ total: 2, take: 20, skip: 0, items: [{ subjectLabel: "Proposal 0" }, { subjectLabel: "Proposal 1" }] });
      expect(await listProposalDecisionStates(f.actor, { workspaceId: f.workspaceId, proposalIds: [] })).toEqual(new Map());
    });
    it.each(["caller-restore", "proposal-restore", "head", "decision-parent-restore", "objection-parent-restore"] as const)(
      "withholds earlier state after %s during later flow admission", async change => {
        const f = await fixture();
        const original = lineage.readableArtifactIds;
        let changed = false;
        vi.spyOn(lineage, "readableArtifactIds").mockImplementation(async (...args) => {
          const ids = await original(...args);
          if (!changed && args[2] === "ApprovalFlow" && args[3].some(row => row.id === f.flows[1].id)) {
            changed = true;
            if (change === "caller-restore") {
              await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: false } });
              await prisma.member.update({ where: { id: f.readerMember.id }, data: { isActive: true } });
            } else if (change === "proposal-restore") {
              await prisma.proposal.update({ where: { id: f.proposals[0].id }, data: { isPrivate: true, ownerMemberId: f.authorMember.id } });
              await prisma.proposal.update({ where: { id: f.proposals[0].id }, data: { isPrivate: false, ownerMemberId: null } });
            } else if (change === "head") {
              const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspaceId,
                artifactType: "ApprovalFlow", artifactId: f.flows[0].id }, orderBy: { revision: "desc" } });
              await prisma.$executeRaw`INSERT INTO "ArtifactInputLineage" ("id", "workspaceId", "artifactType", "artifactId", "revision", "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson") SELECT ${randomUUID()}, "workspaceId", "artifactType", "artifactId", "revision" + 1, "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson" FROM "ArtifactInputLineage" WHERE "id" = ${head.id}`;
            } else if (change === "decision-parent-restore") {
              const row = await prisma.approvalDecision.findFirstOrThrow({ where: { flowId: f.flows[0].id } });
              await prisma.approvalDecision.update({ where: { id: row.id }, data: { memberId: f.authorMember.id } });
              await prisma.approvalDecision.update({ where: { id: row.id }, data: { memberId: row.memberId } });
            } else {
              const row = await prisma.objection.findFirstOrThrow({ where: { flowId: f.flows[0].id } });
              await prisma.objection.update({ where: { id: row.id }, data: { userId: f.authorMember.userId } });
              await prisma.objection.update({ where: { id: row.id }, data: { userId: row.userId } });
            }
          }
          return ids;
        });
        await expect(read(f)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
        expect(changed).toBe(true);
      });
  });
}


describe("approval reviewer continuity", () => {
  it.each(["reviewer-restore", "reviewer-label", "reviewer-head", "reviewer-user-head", "objection-label", "new-reviewer"] as const)(
    "withholds decision states after %s during later flow admission", async change => {
      const f = await fixture();
      const other = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Other"}});
      const otherMember = await prisma.member.create({data: {workspaceId: f.workspaceId, userId: other.id, role: "CONTRIBUTOR"}});
      // The original objection remains readable when its historical author leaves.
      if (change === "objection-label") {
        await prisma.objection.create({data: {flowId: f.flows[0].id, userId: other.id, bodyMd: "Historical objection"}}).then(async row => {
          await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: f.owner, workspaceId: f.workspaceId,
            artifact: {kind: "Objection", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
        });
        await prisma.member.update({where: {id: otherMember.id}, data: {isActive: false}});
      }
      let changed = false;
      const original = lineage.readableArtifactIds;
      vi.spyOn(lineage, "readableArtifactIds").mockImplementation(async (...args) => {
        const ids = await original(...args);
        if (!changed && args[2] === "ApprovalFlow" && args[3].some(row => row.id === f.flows[1].id)) {
          changed = true;
          if (change === "reviewer-restore") {
            await prisma.member.update({where: {id: otherMember.id}, data: {isActive: false}});
            await prisma.member.update({where: {id: otherMember.id}, data: {isActive: true}});
          } else if (change === "reviewer-head") {
            const member = await prisma.member.findUniqueOrThrow({where: {id: otherMember.id}, include: {user: {select: {id: true, displayName: true, email: true}}}});
            await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: f.owner, workspaceId: f.workspaceId,
              artifact: {kind: "Member", id: member.id}, content: member, origin: "HUMAN_ORIGINAL", inputs: []}));
          } else if (change === "reviewer-user-head") {
            await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: f.owner, workspaceId: f.workspaceId,
              artifact: {kind: "User", id: other.id}, content: other, origin: "HUMAN_ORIGINAL", inputs: []}));
          } else if (change === "new-reviewer") {
            const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "New reviewer"}});
            await prisma.member.create({data: {workspaceId: f.workspaceId, userId: user.id, role: "CONTRIBUTOR"}});
          } else await prisma.user.update({where: {id: other.id}, data: {displayName: "Changed"}});
        }
        return ids;
      });
      await expect(listProposalDecisionStates(f.actor, {workspaceId: f.workspaceId, proposalIds: f.proposals.map(row => row.id)}))
        .rejects.toMatchObject({code: "SOURCE_CHANGED"});
      expect(changed).toBe(true);
    });
});


it("keeps historical snapshot ancestry on the ordinary evaluator fallback", async () => {
  const f = await fixture();
  const proof = await prisma.$transaction(tx => lineage.captureArtifactInputSnapshotProof(f.owner, f.workspaceId,
    {kind: "Proposal", id: f.proposals[0].id, fingerprint: lineage.lineageContentFingerprint("Proposal", f.proposals[0])}, tx));
  await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: f.owner, workspaceId: f.workspaceId,
    artifact: {kind: "ApprovalFlow", id: f.flows[0].id}, content: f.flows[0], origin: "DERIVED", inheritedRoots: proof, inputs: []}));
  const fallback = vi.spyOn(prisma.approvalFlow, "findFirst");
  const states = await listProposalDecisionStates(f.actor, {workspaceId: f.workspaceId, proposalIds: f.proposals.map(row => row.id)});
  expect(states.size).toBe(2);
  expect(fallback.mock.calls.some(([args]) => !args?.select)).toBe(true);
});

it("rejects a denied reviewer contributor instead of returning its identity", async () => {
  const f = await fixture();
  const member = await prisma.member.findUniqueOrThrow({where: {id: f.readerMember.id}, include: {user: true}});
  await prisma.$transaction(tx => lineage.invalidateArtifactInputLineage({tx, workspaceId: f.workspaceId,
    artifact: {kind: "Member", id: member.id}, content: member}));
  await expect(listProposalDecisionStates(f.actor, {workspaceId: f.workspaceId, proposalIds: f.proposals.map(row => row.id)}))
    .rejects.toMatchObject({code: "SOURCE_CHANGED"});
});

it("preserves empty reviewer defaults without capturing an empty policy vector", async () => {
  const f = await fixture(2, false);
  await prisma.member.updateMany({where: {workspaceId: f.workspaceId}, data: {kind: "SYSTEM"}});
  for (const flow of f.flows) await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx, actor: f.owner,
    workspaceId: f.workspaceId, artifact: {kind: "ApprovalFlow", id: flow.id}, content: flow, origin: "DERIVED",
    inputs: [{kind: "Proposal", id: flow.subjectId}]}));
  const states = await listProposalDecisionStates(f.actor, {workspaceId: f.workspaceId, proposalIds: f.proposals.map(row => row.id)});
  expect(states.size).toBe(2);
  expect([...states.values()].every(state => state.eligibleApprovers === 0 && state.reviewers.length === 0 && !state.canReview)).toBe(true);
});


it("omits private inputs and foreign proposal IDs while retaining actionable pagination", async () => {
  const f = await fixture();
  await prisma.proposal.update({where: {id: f.proposals[0].id}, data: {isPrivate: true, ownerMemberId: f.authorMember.id}});
  const foreign = await fixture(1, false);
  const states = await listProposalDecisionStates(f.actor, {workspaceId: f.workspaceId,
    proposalIds: [...f.proposals.map(row => row.id), foreign.proposals[0].id]});
  expect([...states.keys()]).toEqual([f.proposals[1].id]);
  expect(await listActionableApprovalFlows(f.actor, f.workspaceId, {take: 1, skip: 0}))
    .toMatchObject({total: 1, take: 1, skip: 0, items: [{id: f.flows[1].id, subjectLabel: "Proposal 1"}]});
  expect(await listActionableApprovalFlows(f.actor, f.workspaceId, {take: 1, skip: 1}))
    .toMatchObject({total: 1, take: 1, skip: 1, items: []});
});
