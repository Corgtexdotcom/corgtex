import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { applyInsight } from "./meeting-intelligence";
import { resolveProposal } from "./proposals";
import { AppError } from "./errors";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage,
  withArtifactInputWriteFence, type LineageInput } from "./source-lineage";

const hooks = vi.hoisted(() => ({ transaction: undefined as undefined | ((work: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown>) }));
vi.mock("@corgtex/shared", async () => {
  const actual = await vi.importActual<typeof import("@corgtex/shared")>("@corgtex/shared");
  return { ...actual, prisma: new Proxy(actual.prisma, { get(target, key) {
    return key === "$transaction" && hooks.transaction ? hooks.transaction : Reflect.get(target, key);
  } }) };
});
vi.mock("@corgtex/models", () => ({ defaultModelGateway: { extract: vi.fn(async () => {
  throw new Error("No live model in synthetic resolution tests");
}) } }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const assignedLocalFixture = database.hostname === "127.0.0.1" && database.port === "55468";
const assignedCiFixture = process.env.GITHUB_ACTIONS === "true"
  && database.hostname === "localhost" && database.port === "5432";
const assignedExplicitFixture = process.env.CORGTEX_DISPOSABLE_TEST_DATABASE_URL === process.env.DATABASE_URL
  && ["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) && /^\/[a-z0-9_]+_test$/.test(database.pathname);
if (!["postgres:", "postgresql:"].includes(database.protocol) || (!assignedExplicitFixture &&
  ((!assignedLocalFixture && !assignedCiFixture) || database.pathname !== "/corgtex_test"))
  || database.searchParams.get("schema") !== "public") {
  throw new Error("Meeting resolution requires the assigned disposable local or GitHub Actions PostgreSQL fixture.");
}

type Kind = "Action" | "Tension" | "Proposal";
async function fixture(kind: Kind, privateOriginal = false) {
  const suffix = randomUUID();
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic resolution", slug: `resolution-${suffix}` } });
  const user = await prisma.user.create({ data: { email: `resolution-${suffix}@example.test`, displayName: "Synthetic owner", passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN", kind: "HUMAN" } });
  const second = await prisma.user.create({ data: { email: `resolution-reader-${suffix}@example.test`, displayName: "Synthetic reader", passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: second.id, role: "CONTRIBUTOR", kind: "HUMAN" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: user.displayName } };
  const reader: AppActor = { kind: "user", user: { id: second.id, email: second.email, displayName: second.displayName } };
  const common = { workspaceId: workspace.id, authorUserId: user.id, title: "Original public target canary", bodyMd: "Original target body canary", status: privateOriginal ? "DRAFT" as const : "OPEN" as const, isPrivate: privateOriginal, publishedAt: privateOriginal ? null : new Date() };
  const target = kind === "Action" ? await prisma.action.create({ data: { ...common, assigneeMemberId: member.id } })
    : kind === "Tension" ? await prisma.tension.create({ data: { ...common, assigneeMemberId: member.id } })
      : await prisma.proposal.create({ data: { ...common, ownerMemberId: member.id } });
  const article = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, slug: "uncited-private", title: "Private source title canary",
    bodyMd: "Uncited private model input canary", type: "PROJECT", authority: "DRAFT", isPrivate: true, ownerMemberId: member.id } });
  const meeting = await prisma.meeting.create({ data: { workspaceId: workspace.id, source: "manual", title: "Actual meeting source canary", recordedAt: new Date(), participantIds: [], transcript: null } });
  // These rows are synthetic independent literal human inputs. Their exact full
  // persisted rows are certified by the real receipt writer, not a citation list.
  await prisma.$transaction(async tx => {
    for (const [artifact, content] of [[{ kind, id: target.id }, target], [{ kind: "BrainArticle", id: article.id }, article], [{ kind: "Meeting", id: meeting.id }, meeting]] as const) {
      await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact, content, origin: "HUMAN_ORIGINAL", inputs: [] });
    }
  });
  const flow = kind === "Proposal" && !privateOriginal ? await prisma.approvalFlow.create({ data: { workspaceId: workspace.id, subjectType: "PROPOSAL", subjectId: target.id,
    mode: "CONSENT", status: "ACTIVE", createdByUserId: user.id, openedAt: new Date() } }) : null;
  if (flow) await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "ApprovalFlow", id: flow.id }, content: flow, origin: "DERIVED", inputs: [{ kind, id: target.id }] }));
  const insight = await prisma.meetingInsight.create({ data: { workspaceId: workspace.id, meetingId: meeting.id,
    type: kind === "Action" ? "ACTION_ITEM" : kind === "Tension" ? "TENSION" : "PROPOSAL", operation: "RESOLVE", status: "SUGGESTED",
    title: "Generated resolve target", bodyMd: "Generated resolution decision canary", targetEntityType: kind, targetEntityId: target.id,
    resolutionOutcome: "ADOPTED", confidence: 1 } });
  const inputs: LineageInput[] = [{ kind, id: target.id }, { kind: "Meeting", id: meeting.id }, { kind: "BrainArticle", id: article.id }];
  const modelInputs = await captureArtifactInputProof(actor, workspace.id, inputs);
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "MeetingInsight", id: insight.id },
    content: insight, origin: "DERIVED", inputs: [], inheritedRoots: modelInputs }));
  const getTarget = () => kind === "Action" ? prisma.action.findUniqueOrThrow({ where: { id: target.id } })
    : kind === "Tension" ? prisma.tension.findUniqueOrThrow({ where: { id: target.id } }) : prisma.proposal.findUniqueOrThrow({ where: { id: target.id } });
  return { kind, workspace, actor, reader, target, meeting, article, insight, flow, getTarget };
}

beforeEach(async () => { await truncateAllTables(); });
afterEach(() => { hooks.transaction = undefined; vi.restoreAllMocks(); });

describe("Meeting RESOLVE complete transactional lineage", () => {
  it.each(["Action", "Tension", "Proposal"] as const)("publishes %s, APPLIED Insight and every generated receipt with the full original closure", async kind => {
    const f = await fixture(kind);
    const result = await applyInsight(f.actor, { workspaceId: f.workspace.id, insightId: f.insight.id });
    expect(result).toMatchObject({ status: "APPLIED", appliedEntityType: kind, appliedEntityId: f.target.id });
    expect(await f.getTarget()).toMatchObject({ title: f.target.title, bodyMd: f.target.bodyMd, status: kind === "Action" ? "COMPLETED" : "RESOLVED" });
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind, id: f.target.id }, { kind: "MeetingInsight", id: f.insight.id }]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(true);
    expect(await isArtifactInputProofReadable(f.reader, f.workspace.id, roots)).toBe(false);
    const targetManifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: kind, artifactId: f.target.id }, orderBy: { revision: "desc" } });
    expect(targetManifest.origin).toBe("DERIVED");
    const oldTarget = await prisma.artifactInputSnapshot.findFirstOrThrow({ where: { sourceKind: kind, sourceId: f.target.id }, orderBy: { createdAt: "asc" } });
    expect(oldTarget.contentJson).toMatchObject({ status: "OPEN", bodyMd: f.target.bodyMd });
    if (f.flow) {
      expect(await prisma.approvalFlow.findUniqueOrThrow({ where: { id: f.flow.id } })).toMatchObject({ status: "APPROVED", resultJson: { manuallyResolved: true, decisionMd: expect.stringContaining(f.insight.bodyMd) } });
      const policy = await prisma.policyCorpus.findUniqueOrThrow({ where: { proposalId: f.target.id } });
      expect(policy).toMatchObject({ title: f.target.title, bodyMd: f.target.bodyMd });
      const finalProof = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ApprovalFlow", id: f.flow.id }, { kind: "PolicyCorpus", id: policy.id }]);
      expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, finalProof)).toBe(true);
      expect(await isArtifactInputProofReadable(f.reader, f.workspace.id, finalProof)).toBe(false);
    }
  });

  it.each(["Action", "Tension", "Proposal"] as const)("denies uncited private %s ancestry before any canonical mutation", async kind => {
    const f = await fixture(kind);
    await expect(applyInsight(f.reader, { workspaceId: f.workspace.id, insightId: f.insight.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await f.getTarget()).status).toBe("OPEN");
    expect((await prisma.meetingInsight.findUniqueOrThrow({ where: { id: f.insight.id } })).status).toBe("SUGGESTED");
  });

  it.each(["Action", "Tension", "Proposal"] as const)("rolls back all %s canonical effects when the final write fence fails", async kind => {
    const f = await fixture(kind);
    const eventCount = await prisma.event.count({ where: { workspaceId: f.workspace.id } });
    const auditCount = await prisma.auditLog.count({ where: { workspaceId: f.workspace.id } });
    const manifestCount = await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspace.id } });
    await expect(withArtifactInputWriteFence(async tx => {
      if (tx && (await tx.meetingInsight.findUniqueOrThrow({ where: { id: f.insight.id } })).status === "APPLIED")
        throw new AppError(409, "SOURCE_CHANGED", "Synthetic final fence failed");
    }, () => applyInsight(f.actor, { workspaceId: f.workspace.id, insightId: f.insight.id }))).rejects.toMatchObject({ code: "ARTIFACT_INPUT_WRITE_FENCE_LOST" });
    expect((await f.getTarget()).status).toBe("OPEN");
    expect((await prisma.meetingInsight.findUniqueOrThrow({ where: { id: f.insight.id } })).status).toBe("SUGGESTED");
    expect(await prisma.event.count({ where: { workspaceId: f.workspace.id } })).toBe(eventCount);
    expect(await prisma.auditLog.count({ where: { workspaceId: f.workspace.id } })).toBe(auditCount);
    expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspace.id } })).toBe(manifestCount);
    expect(await prisma.policyCorpus.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    if (f.flow) expect((await prisma.approvalFlow.findUniqueOrThrow({ where: { id: f.flow.id } })).status).toBe("ACTIVE");
    expect(await prisma.artifactInputSnapshot.count({ where: { workspaceId: f.workspace.id } })).toBeGreaterThan(0);
  });

  it("preserves explicitly authorized native private original publication without rebasing old history", async () => {
    const f = await fixture("Proposal", true);
    const prior = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "Proposal", artifactId: f.target.id }, orderBy: { revision: "desc" } });
    const published = await resolveProposal(f.actor, { workspaceId: f.workspace.id, proposalId: f.target.id, outcome: "ADOPTED", decisionMd: "Explicit original human publication decision" });
    expect(published).toMatchObject({ status: "RESOLVED", isPrivate: false, bodyMd: f.target.bodyMd });
    const latest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "Proposal", artifactId: f.target.id }, orderBy: { revision: "desc" } });
    expect(latest).toMatchObject({ origin: "HUMAN_ORIGINAL", rootsJson: [], inputsJson: [] });
    expect(await prisma.artifactInputLineage.findUniqueOrThrow({ where: { id: prior.id } })).toEqual(prior);
    const history = await prisma.artifactInputSnapshot.findFirstOrThrow({ where: { sourceKind: "Proposal", sourceId: f.target.id, origin: "HUMAN_ORIGINAL" }, orderBy: { createdAt: "asc" } });
    expect(history.contentJson).toMatchObject({ status: "DRAFT", isPrivate: true, bodyMd: f.target.bodyMd });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, [{ kind: "ArtifactInputSnapshot", id: history.id,
      fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", history) }])).toBe(false);
    const policy = await prisma.policyCorpus.findUniqueOrThrow({ where: { proposalId: f.target.id } });
    const current = await captureArtifactInputProof(f.reader, f.workspace.id, [{ kind: "Proposal", id: f.target.id }, { kind: "PolicyCorpus", id: policy.id }]);
    expect(await isArtifactInputProofReadable(f.reader, f.workspace.id, current)).toBe(true);
  });

  it.each(["Proposal", "Workspace"] as const)("denies native publication when the saved original vector lacks exact %s coverage", async missingKind => {
    const f = await fixture("Proposal", true);
    const prior = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "Proposal", artifactId: f.target.id }, orderBy: { revision: "desc" } });
    const proof = prior.permissionEpochsJson as { version: number; policyVersion: string; entries: Array<{ kind: string; id: string; epoch: string }> };
    await prisma.artifactInputLineage.update({ where: { id: prior.id }, data: { permissionEpochsJson: {
      ...proof, entries: proof.entries.filter(entry => entry.kind !== missingKind),
    } } });
    await expect(resolveProposal(f.actor, { workspaceId: f.workspace.id, proposalId: f.target.id, outcome: "ADOPTED", decisionMd: "Native decision" })).rejects.toBeDefined();
    expect(await f.getTarget()).toMatchObject({ status: "DRAFT", isPrivate: true });
    expect(await prisma.policyCorpus.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  });

  it("does not apply the native original publication distinction to a copied private resolution", async () => {
    const f = await fixture("Proposal", true);
    const inputs = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "MeetingInsight", id: f.insight.id }, { kind: "BrainArticle", id: f.article.id }]);
    await expect(resolveProposal(f.actor, { workspaceId: f.workspace.id, proposalId: f.target.id, outcome: "ADOPTED",
      decisionMd: f.insight.bodyMd, lineageCopied: true, lineageRoots: inputs })).rejects.toBeDefined();
    expect(await f.getTarget()).toMatchObject({ status: "DRAFT", isPrivate: true });
    expect(await prisma.policyCorpus.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  });

  it.each(["proposal", "approvalFlow", "policyCorpus"] as const)("rolls back after the actual %s writer fails", async stage => {
    const f = await fixture("Proposal");
    const original = prisma.$transaction.bind(prisma) as <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
    const manifestCount = await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspace.id } });
    const eventCount = await prisma.event.count({ where: { workspaceId: f.workspace.id } });
    hooks.transaction = work => original(tx => work(new Proxy(tx, { get(target, key) {
      if (key !== stage) return Reflect.get(target, key);
      const operation = stage === "policyCorpus" ? "upsert" : "update";
      return new Proxy(Reflect.get(target, key), { get(delegate, method) {
        if (method !== operation) return Reflect.get(delegate, method);
        return async (args: unknown) => {
          const write = Reflect.get(delegate, method) as (args: unknown) => Promise<unknown>;
          await write.call(delegate, args);
          throw new Error(`Synthetic failure after ${stage} writer`);
        };
      } });
    } })));
    await expect(applyInsight(f.actor, { workspaceId: f.workspace.id, insightId: f.insight.id })).rejects.toThrow(`Synthetic failure after ${stage} writer`);
    expect((await f.getTarget()).status).toBe("OPEN");
    expect((await prisma.approvalFlow.findUniqueOrThrow({ where: { id: f.flow!.id } })).status).toBe("ACTIVE");
    expect((await prisma.meetingInsight.findUniqueOrThrow({ where: { id: f.insight.id } })).status).toBe("SUGGESTED");
    expect(await prisma.policyCorpus.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.event.count({ where: { workspaceId: f.workspace.id } })).toBe(eventCount);
    expect(await prisma.artifactInputLineage.count({ where: { workspaceId: f.workspace.id } })).toBe(manifestCount);
    expect(await prisma.artifactInputSnapshot.count({ where: { workspaceId: f.workspace.id } })).toBeGreaterThan(0);
  });

  it("follows the generation Meeting-before-Insight lock order without deadlock or stale publication", async () => {
    const f = await fixture("Action");
    const generationClient = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    let entered!: () => void;
    let resume!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    const generation = generationClient.$transaction(async tx => {
      // This is the actual lock/write ordering of generateInsights: Meeting
      // owner first, followed by superseding the previous Insight revision.
      await tx.$queryRaw`SELECT id FROM "Meeting" WHERE id = ${f.meeting.id} FOR UPDATE`;
      entered();
      await release;
      await tx.meetingInsight.update({ where: { id: f.insight.id }, data: { supersededAt: new Date() } });
    }, { timeout: 10_000 });
    let resolution: ReturnType<typeof applyInsight> | undefined;
    try {
      await locked;
      resolution = applyInsight(f.actor, { workspaceId: f.workspace.id, insightId: f.insight.id });
      // Attach a handler immediately while the concurrent transaction proceeds.
      const observed = resolution.then(value => ({ value }), error => ({ error }));
      await vi.waitFor(async () => {
        const waiters = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%Meeting%FOR UPDATE%' AND pid <> pg_backend_pid()) AS blocked`;
        expect(waiters[0]?.blocked).toBe(true);
      }, { timeout: 3_000, interval: 20 });
      resume();
      await generation;
      expect(await observed).toMatchObject({ error: { code: "SOURCE_CHANGED" } });
      expect((await f.getTarget()).status).toBe("OPEN");
      expect((await prisma.meetingInsight.findUniqueOrThrow({ where: { id: f.insight.id } })).status).toBe("SUGGESTED");
    } finally {
      resume();
      await Promise.allSettled([generation, ...(resolution ? [resolution] : [])]);
      await generationClient.$disconnect();
    }
  });

  it("rejects a real permission revoke/restore between preparation and publication and preserves old vectors", async () => {
    const f = await fixture("Action");
    const original = prisma.$transaction.bind(prisma) as <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
    let changed = false;
    hooks.transaction = async work => {
      const result = await original(work);
      // Preflight also opens read transactions. Revoke only after the actual
      // preparation transaction has durably frozen the consumed inputs.
      if (!changed && await prisma.artifactInputSnapshot.count({ where: { workspaceId: f.workspace.id } }) > 0) {
        changed = true;
        await prisma.brainArticle.update({ where: { id: f.article.id }, data: { isPrivate: false } });
        await prisma.brainArticle.update({ where: { id: f.article.id }, data: { isPrivate: true } });
      }
      return result;
    };
    await expect(applyInsight(f.actor, { workspaceId: f.workspace.id, insightId: f.insight.id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect((await f.getTarget()).status).toBe("OPEN");
    expect((await prisma.meetingInsight.findUniqueOrThrow({ where: { id: f.insight.id } })).status).toBe("SUGGESTED");
    expect(await prisma.artifactInputSnapshot.count({ where: { workspaceId: f.workspace.id } })).toBeGreaterThan(0);
  });
});
