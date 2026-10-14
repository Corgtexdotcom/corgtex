import { beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { listWorkspaceAgreements } from "./agreements";
import { captureArtifactInputProof, recordArtifactInputLineage } from "./source-lineage";
import {
  acquireConstitutionCorpusAdvisoryLock,
  createConstitutionVersion,
  loadConstitutionCorpusSnapshot, fingerprintConstitutionCorpus, getCurrentConstitution, listConstitutionVersions,
} from "./constitutions";

const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables();
});

async function createWorkspace(slug: string) {
  return prisma.workspace.create({ data: { slug, name: slug } });
}

async function createCorpusFixture(slug = "constitution-source") {
  const workspace = await createWorkspace(slug);
  const user = await prisma.user.create({
    data: {
      email: `${slug}@example.com`,
      displayName: "Source Author",
      passwordHash: "test-password-hash",
    },
  });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const proposal = await prisma.proposal.create({
    data: {
      workspaceId: workspace.id,
      authorUserId: user.id,
      title: "Adopt source provenance",
      bodyMd: "Persist immutable source snapshots.",
      status: "RESOLVED",
      resolutionOutcome: "ADOPTED",
      isPrivate: false,
      publishedAt: new Date("2026-08-09T00:00:00.000Z"),
      decidedAt: new Date("2026-08-10T00:00:00.000Z"),
    },
  });
  const tension = await prisma.tension.create({
    data: {
      workspaceId: workspace.id,
      authorUserId: user.id,
      proposalId: proposal.id,
      title: "Missing provenance",
      bodyMd: "Constitution points need durable sources.",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-08-08T00:00:00.000Z"),
    },
  });
  const policy = await prisma.policyCorpus.create({
    data: {
      workspaceId: workspace.id,
      proposalId: proposal.id,
      title: proposal.title,
      bodyMd: proposal.bodyMd,
      acceptedAt: new Date("2026-08-10T00:00:00.000Z"),
    },
  });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: user.displayName } };
  await prisma.$transaction(async (tx) => {
    await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "Proposal", id: proposal.id }, content: proposal, origin: "HUMAN_ORIGINAL", inputs: [] });
    await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "Tension", id: tension.id }, content: tension, origin: "HUMAN_ORIGINAL", inputs: [] });
    await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "PolicyCorpus", id: policy.id }, content: policy, origin: "DERIVED", inputs: [{ kind: "Proposal", id: proposal.id }] });
  });
  return { workspace, user, actor, proposal, tension, policy };
}

async function waitForQueuedCorpusLock(workspaceId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [lock] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted = false
        AND classid = hashtext('constitution_corpus')::oid
        AND objid = hashtext(${workspaceId})::oid
        AND objsubid = 2
    `;
    if (lock?.count === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Constitution writer did not queue on the corpus lock.");
}

async function legacyFixtureCorpus(workspaceId: string) {
  const corpus = await prisma.policyCorpus.findMany({ where: { workspaceId } });
  return { corpus, fingerprint: fingerprintConstitutionCorpus(corpus) };
}

async function createKnownConstitution(actor: AppActor, params: Parameters<typeof createConstitutionVersion>[0]) {
  const corpus = await loadConstitutionCorpusSnapshot(actor, prisma, params.workspaceId);
  const lineageRoots = await captureArtifactInputProof(actor, params.workspaceId, corpus.corpus.map((policy) => ({ kind: "PolicyCorpus", id: policy.id, snapshot: policy })));
  return createConstitutionVersion({ ...params, lineageActor: actor, lineageRoots });
}

async function waitForBlockedSourceInsert() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [query] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query LIKE '%ConstitutionSourceReference%'
    `;
    if (query?.count === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Source insert did not wait for the eligibility row lock.");
}

describe("Constitution provenance database contract", () => {
  it("serializes six same-workspace writers without retry exhaustion", async () => {
    const workspace = await createWorkspace("constitution-concurrency");
    const versions = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      createConstitutionVersion({
        workspaceId: workspace.id,
        bodyMd: `# Constitution ${index + 1}`,
        modelUsed: "integration-test",
      })));

    expect(versions.map((version) => version.version).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps cross-workspace relation metadata out of synthesis and source resolution", async () => {
    const localWorkspace = await createWorkspace("constitution-tenant-local");
    const foreignWorkspace = await createWorkspace("constitution-tenant-foreign");
    const [localUser, foreignUser] = await Promise.all([
      prisma.user.create({
        data: { email: "constitution-local@example.com", displayName: "Local", passwordHash: "test-password-hash" },
      }),
      prisma.user.create({
        data: { email: "constitution-foreign@example.com", displayName: "Foreign", passwordHash: "test-password-hash" },
      }),
    ]);
    const foreignProposal = await prisma.proposal.create({
      data: {
        workspaceId: foreignWorkspace.id,
        authorUserId: foreignUser.id,
        title: "DO NOT DISCLOSE PROPOSAL",
        bodyMd: "Foreign proposal body",
        status: "RESOLVED",
        resolutionOutcome: "ADOPTED",
        isPrivate: false,
        publishedAt: new Date("2026-08-07T00:00:00.000Z"),
      },
    });
    const foreignCircle = await prisma.circle.create({
      data: { workspaceId: foreignWorkspace.id, name: "DO NOT DISCLOSE CIRCLE" },
    });
    const localProposal = await prisma.proposal.create({
      data: {
        workspaceId: localWorkspace.id,
        authorUserId: localUser.id,
        title: "Local source proposal",
        bodyMd: "Local proposal body",
        status: "RESOLVED",
        resolutionOutcome: "ADOPTED",
        isPrivate: false,
        publishedAt: new Date("2026-08-08T00:00:00.000Z"),
      },
    });
    const [crossProposalPolicy, localPolicy, foreignTension, combinedTension] = await Promise.all([
      prisma.policyCorpus.create({
        data: {
          workspaceId: localWorkspace.id,
          proposalId: foreignProposal.id,
          circleId: foreignCircle.id,
          title: "Workspace-owned policy one",
          bodyMd: "Safe policy body one",
          acceptedAt: new Date("2026-08-09T00:00:00.000Z"),
        },
      }),
      prisma.policyCorpus.create({
        data: {
          workspaceId: localWorkspace.id,
          proposalId: localProposal.id,
          title: "Workspace-owned policy two",
          bodyMd: "Safe policy body two",
          acceptedAt: new Date("2026-08-10T00:00:00.000Z"),
        },
      }),
      prisma.tension.create({
        data: {
          workspaceId: foreignWorkspace.id,
          authorUserId: foreignUser.id,
          proposalId: localProposal.id,
          title: "DO NOT DISCLOSE TENSION",
          bodyMd: "Foreign tension body",
          status: "OPEN",
          isPrivate: false,
          publishedAt: new Date("2026-08-08T00:00:00.000Z"),
        },
      }),
      prisma.tension.create({
        data: {
          workspaceId: localWorkspace.id,
          authorUserId: localUser.id,
          proposalId: foreignProposal.id,
          title: "Local tension linked to a foreign proposal",
          bodyMd: "This combined malformed relation must fail closed.",
          status: "OPEN",
          isPrivate: false,
          publishedAt: new Date("2026-08-08T00:00:00.000Z"),
        },
      }),
    ]);

    const localActor: AppActor = { kind: "user", user: { id: localUser.id, email: localUser.email, displayName: localUser.displayName } };
    await prisma.member.create({ data: { workspaceId: localWorkspace.id, userId: localUser.id, role: "CONTRIBUTOR" } });
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: localActor, workspaceId: localWorkspace.id, artifact: { kind: "Proposal", id: localProposal.id }, content: localProposal, origin: "HUMAN_ORIGINAL", inputs: [] });
      await recordArtifactInputLineage({ tx, actor: localActor, workspaceId: localWorkspace.id, artifact: { kind: "PolicyCorpus", id: localPolicy.id }, content: localPolicy, origin: "DERIVED", inputs: [{ kind: "Proposal", id: localProposal.id }] });
    });
    const snapshot = await loadConstitutionCorpusSnapshot(localActor, prisma, localWorkspace.id);
    expect(snapshot.corpus.map((row) => row.id)).toEqual([localPolicy.id]);
    expect(JSON.stringify(snapshot.corpus)).not.toContain("DO NOT DISCLOSE");

    await expect(createConstitutionVersion({
      workspaceId: localWorkspace.id,
      bodyMd: "# Cross-workspace proposal",
      modelUsed: "integration-test",
      references: [{
        pointOrder: 1,
        sourceOrder: 1,
        policyCorpusId: crossProposalPolicy.id,
        sourceKind: "PROPOSAL",
        proposalId: foreignProposal.id,
      }],
    })).rejects.toThrow("Invalid Constitution source reference.");
    await expect(createConstitutionVersion({
      workspaceId: localWorkspace.id,
      bodyMd: "# Unknown policy",
      modelUsed: "integration-test",
      references: [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: "unknown-policy-id", sourceKind: "PROPOSAL" }],
    })).rejects.toThrow("Invalid Constitution source reference.");
    await expect(createConstitutionVersion({
      workspaceId: localWorkspace.id,
      bodyMd: "# Cross-workspace tension",
      modelUsed: "integration-test",
      references: [{
        pointOrder: 1,
        sourceOrder: 1,
        policyCorpusId: localPolicy.id,
        sourceKind: "TENSION",
        tensionId: foreignTension.id,
      }],
    })).rejects.toThrow("Invalid Constitution source reference.");
    await expect(prisma.constitution.count({ where: { workspaceId: localWorkspace.id } })).resolves.toBe(0);

    await expect(createConstitutionVersion({
      workspaceId: localWorkspace.id,
      bodyMd: "# Combined malformed tension",
      modelUsed: "integration-test",
      references: [{
        pointOrder: 1,
        sourceOrder: 1,
        policyCorpusId: crossProposalPolicy.id,
        sourceKind: "TENSION",
        tensionId: combinedTension.id,
      }],
    })).rejects.toThrow("Invalid Constitution source reference.");
    const constitution = await createConstitutionVersion({
      workspaceId: localWorkspace.id,
      bodyMd: "# Trigger boundary",
      modelUsed: "integration-test",
    });
    await expect(prisma.constitutionSourceReference.create({
      data: {
        workspaceId: localWorkspace.id,
        constitutionId: constitution.id,
        pointKey: "point-1",
        pointOrder: 1,
        sourceOrder: 1,
        policyCorpusId: crossProposalPolicy.id,
        sourceKind: "TENSION",
        tensionId: combinedTension.id,
        labelSnapshot: combinedTension.title,
        acceptedAtSnapshot: crossProposalPolicy.acceptedAt,
      },
    })).rejects.toThrow();
    await expect(prisma.constitutionSourceReference.count({ where: { constitutionId: constitution.id } }))
      .resolves.toBe(0);
  });

  it("linearizes tension eligibility at the source insert boundary", async () => {
    const { workspace, tension, policy } = await createCorpusFixture("constitution-eligibility-race");
    const constitution = await createConstitutionVersion({
      workspaceId: workspace.id,
      bodyMd: "# Eligibility race",
      modelUsed: "integration-test",
    });
    let releaseWriter = () => {};
    let writerLocked = () => {};
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const locked = new Promise<void>((resolve) => { writerLocked = resolve; });

    const writer = prisma.$transaction(async (tx) => {
      await tx.tension.update({ where: { id: tension.id }, data: { archivedAt: new Date() } });
      writerLocked();
      await release;
    });
    await locked;
    const sourceInsertRejection = expect(prisma.constitutionSourceReference.create({
      data: {
        workspaceId: workspace.id,
        constitutionId: constitution.id,
        pointKey: "point-1",
        pointOrder: 1,
        sourceOrder: 1,
        policyCorpusId: policy.id,
        sourceKind: "TENSION",
        tensionId: tension.id,
        labelSnapshot: tension.title,
        acceptedAtSnapshot: policy.acceptedAt,
      },
    })).rejects.toThrow();
    await waitForBlockedSourceInsert();
    releaseWriter();
    await writer;

    await sourceInsertRejection;
    await expect(prisma.constitutionSourceReference.count({ where: { constitutionId: constitution.id } }))
      .resolves.toBe(0);
  });

  it("rechecks corpus drift after the shared writer lock", async () => {
    const { workspace, policy } = await createCorpusFixture("constitution-drift");
    const snapshot = await legacyFixtureCorpus(workspace.id);
    let releaseWriter = () => {};
    let writerLocked = () => {};
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const locked = new Promise<void>((resolve) => { writerLocked = resolve; });

    const writer = prisma.$transaction(async (tx) => {
      await acquireConstitutionCorpusAdvisoryLock(tx, workspace.id);
      await tx.policyCorpus.update({ where: { id: policy.id }, data: { title: "Changed policy" } });
      writerLocked();
      await release;
    });
    await locked;
    const constitution = createConstitutionVersion({
      workspaceId: workspace.id,
      bodyMd: "# Stale synthesis",
      modelUsed: "integration-test",
      expectedCorpusFingerprint: snapshot.fingerprint,
      references: [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: policy.id, sourceKind: "PROPOSAL" }],
    });
    await waitForQueuedCorpusLock(workspace.id);
    releaseWriter();
    await writer;

    await expect(constitution).rejects.toThrow("Constitution policy corpus changed during synthesis.");
    await expect(prisma.constitution.count({ where: { workspaceId: workspace.id } })).resolves.toBe(0);
  });

  it("retains snapshots after source deletion while rejecting invalid source ownership", async () => {
    const { workspace, proposal, tension, policy } = await createCorpusFixture();
    const snapshot = await legacyFixtureCorpus(workspace.id);
    const constitution = await createConstitutionVersion({
      workspaceId: workspace.id,
      bodyMd: "# Constitution",
      modelUsed: "integration-test",
      expectedCorpusFingerprint: snapshot.fingerprint,
      references: [
        { pointOrder: 1, sourceOrder: 1, policyCorpusId: policy.id, sourceKind: "PROPOSAL" },
        { pointOrder: 1, sourceOrder: 2, policyCorpusId: policy.id, sourceKind: "TENSION", tensionId: tension.id },
      ],
    });
    const other = await createCorpusFixture("constitution-other");

    await expect(prisma.constitutionSourceReference.create({
      data: {
        workspaceId: workspace.id,
        constitutionId: constitution.id,
        pointKey: "point-2",
        pointOrder: 2,
        sourceOrder: 1,
        policyCorpusId: other.policy.id,
        sourceKind: "PROPOSAL",
        proposalId: other.proposal.id,
        labelSnapshot: other.proposal.title,
        acceptedAtSnapshot: other.policy.acceptedAt,
      },
    })).rejects.toThrow();

    await prisma.policyCorpus.delete({ where: { id: policy.id } });
    await prisma.tension.delete({ where: { id: tension.id } });
    await prisma.proposal.delete({ where: { id: proposal.id } });

    const references = await prisma.constitutionSourceReference.findMany({
      where: { constitutionId: constitution.id },
      orderBy: { sourceOrder: "asc" },
    });
    expect(references).toMatchObject([
      { policyCorpusId: policy.id, proposalId: proposal.id, labelSnapshot: proposal.title },
      { policyCorpusId: policy.id, tensionId: tension.id, labelSnapshot: tension.title },
    ]);
  });

  it("shows current authorized origins and hides archived or private sources without snapshot fallback", async () => {
    const { workspace, user, proposal, tension, policy } = await createCorpusFixture("constitution-visible-origins");
    const actor = { kind: "user" as const, user: { id: user.id, email: user.email, displayName: user.displayName } };
    const snapshot = await legacyFixtureCorpus(workspace.id);
    await createKnownConstitution(actor, {
      workspaceId: workspace.id,
      bodyMd: "# Constitution with sources",
      modelUsed: "integration-test",
      expectedCorpusFingerprint: snapshot.fingerprint,
      references: [
        { pointOrder: 1, sourceOrder: 1, policyCorpusId: policy.id, sourceKind: "PROPOSAL" },
        { pointOrder: 1, sourceOrder: 2, policyCorpusId: policy.id, sourceKind: "TENSION", tensionId: tension.id },
      ],
    });

    const visible = await listWorkspaceAgreements(actor, { workspaceId: workspace.id });
    expect(visible.currentConstitution?.sourceReferences).toMatchObject([
      { targetId: proposal.id, title: proposal.title },
      { targetId: tension.id, title: tension.title },
    ]);
    expect(visible.policyCorpus[0]?.proposal).toEqual({ id: proposal.id, title: proposal.title });
    expect(visible.currentConstitution?.bodyMd).toBe("# Constitution with sources");
    await prisma.proposal.update({ where: { id: proposal.id }, data: { title: "Current proposal title" } });
    const changed = await listWorkspaceAgreements(actor, { workspaceId: workspace.id });
    expect(changed.currentConstitution).toBeNull();
    expect(changed.policyCorpus).toEqual([]);

    await prisma.tension.update({ where: { id: tension.id }, data: { archivedAt: new Date() } });
    await prisma.proposal.update({ where: { id: proposal.id }, data: { archivedAt: new Date() } });
    const archived = await listWorkspaceAgreements(actor, { workspaceId: workspace.id });
    expect(archived.currentConstitution).toBeNull();
    expect(archived.policyCorpus).toEqual([]);
    expect(JSON.stringify(archived)).not.toContain(proposal.id);
    expect(JSON.stringify(archived)).not.toContain(tension.id);

    await prisma.proposal.update({ where: { id: proposal.id }, data: { archivedAt: null, status: "DRAFT", isPrivate: true, publishedAt: null } });
    const privateOrigin = await listWorkspaceAgreements(actor, { workspaceId: workspace.id });
    expect(privateOrigin.currentConstitution).toBeNull();
    expect(privateOrigin.policyCorpus).toEqual([]);
    expect(JSON.stringify(privateOrigin)).not.toContain(proposal.id);
  });

  it("withholds unknown legacy Constitutions and drops deleted source IDs and labels", async () => {
    const { workspace, user, proposal, tension, policy } = await createCorpusFixture("constitution-deleted-origins");
    const actor = { kind: "user" as const, user: { id: user.id, email: user.email, displayName: user.displayName } };
    await createConstitutionVersion({ workspaceId: workspace.id, bodyMd: "# Legacy Constitution", modelUsed: "integration-test" });
    const legacy = await listWorkspaceAgreements(actor, { workspaceId: workspace.id });
    expect(legacy.currentConstitution).toBeNull();

    await createConstitutionVersion({
      workspaceId: workspace.id,
      bodyMd: "# Constitution with source",
      modelUsed: "integration-test",
      references: [
        { pointOrder: 1, sourceOrder: 1, policyCorpusId: policy.id, sourceKind: "PROPOSAL" },
        { pointOrder: 1, sourceOrder: 2, policyCorpusId: policy.id, sourceKind: "TENSION", tensionId: tension.id },
      ],
    });
    await prisma.policyCorpus.delete({ where: { id: policy.id } });
    await prisma.tension.delete({ where: { id: tension.id } });
    await prisma.proposal.delete({ where: { id: proposal.id } });

    const deleted = await listWorkspaceAgreements(actor, { workspaceId: workspace.id });
    expect(deleted.currentConstitution).toBeNull();
    expect(JSON.stringify(deleted)).not.toContain(proposal.id);
    expect(JSON.stringify(deleted)).not.toContain(tension.id);
    expect(JSON.stringify(deleted)).not.toContain("Missing provenance");
    expect(JSON.stringify(deleted)).not.toContain("Adopt source provenance");
  });

  it("keeps public demo agreement reads inside the dedicated workspace without writes", async () => {
    const { workspace, user } = await createCorpusFixture("jnj-demo");
    await prisma.user.update({ where: { id: user.id }, data: { email: "demo@jnj-demo.corgtex.app" } });
    const actor = { kind: "user" as const, user: { id: user.id, email: "demo@jnj-demo.corgtex.app", displayName: user.displayName } };
    const foreign = await createWorkspace("constitution-demo-foreign");
    const before = await prisma.constitution.count({ where: { workspaceId: workspace.id } });

    const agreements = await listWorkspaceAgreements(actor, { workspaceId: workspace.id });
    expect(agreements.policyCorpus).toHaveLength(1);
    await expect(listWorkspaceAgreements(actor, { workspaceId: foreign.id })).rejects.toMatchObject({ status: 403 });
    await expect(prisma.constitution.count({ where: { workspaceId: workspace.id } })).resolves.toBe(before);
  });
  it("captures a consumed known prior Constitution as immutable history while keeping unknown newer bodies out", async () => {
    const f = await createCorpusFixture("constitution-prior-snapshot");
    const old = await createConstitutionVersion({ workspaceId: f.workspace.id, bodyMd: "# Independent human mission", modelUsed: "human-fixture" });
    const prior = await prisma.constitution.findUniqueOrThrow({ where: { id: old.id } });
    await prisma.$transaction((tx) => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "Constitution", id: prior.id }, content: prior, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const unknown = await createConstitutionVersion({ workspaceId: f.workspace.id, bodyMd: "UNKNOWN PRIOR CANARY", modelUsed: "unknown-model" });
    expect(await getCurrentConstitution(f.actor, f.workspace.id)).toMatchObject({ id: prior.id, bodyMd: prior.bodyMd });
    const corpus = await loadConstitutionCorpusSnapshot(f.actor, prisma, f.workspace.id);
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [
      ...corpus.corpus.map((policy) => ({ kind: "PolicyCorpus" as const, id: policy.id, snapshot: policy })),
      { kind: "Constitution", id: prior.id, snapshot: prior },
    ]);
    const created = await createConstitutionVersion({ workspaceId: f.workspace.id, lineageActor: f.actor, lineageRoots: roots,
      bodyMd: "# Updated independent human mission with known policy", modelUsed: "synthetic-model",
      expectedCorpusFingerprint: corpus.fingerprint,
      references: [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: f.policy.id, sourceKind: "PROPOSAL" }] });
    const manifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "Constitution", artifactId: created.id }, orderBy: { revision: "desc" } });
    expect(manifest.origin).toBe("DERIVED");
    const storedRoots = manifest.rootsJson as Array<{ kind: string; id: string }>;
    const snapshotRoot = storedRoots.find((root) => root.kind === "ArtifactInputSnapshot");
    expect(snapshotRoot).toBeDefined();
    expect(await prisma.artifactInputSnapshot.findUniqueOrThrow({ where: { id: snapshotRoot!.id } }))
      .toMatchObject({ sourceKind: "Constitution", sourceId: prior.id, contentJson: expect.objectContaining({ bodyMd: prior.bodyMd }) });
    const versions = await listConstitutionVersions(f.actor, f.workspace.id);
    expect(versions.total).toBe(2);
    expect(versions.items.map((version) => version.id)).toEqual([created.id, prior.id]);
    expect(JSON.stringify(versions)).not.toContain("UNKNOWN PRIOR CANARY");
    expect(await prisma.constitution.findUniqueOrThrow({ where: { id: unknown.id } })).toMatchObject({ bodyMd: "UNKNOWN PRIOR CANARY" });
    const ref = await prisma.constitutionSourceReference.findFirstOrThrow({ where: { constitutionId: created.id } });
    expect(await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "ConstitutionSourceReference", artifactId: ref.id }, orderBy: { revision: "desc" } }))
      .toMatchObject({ origin: "DERIVED" });
  });

  it("rolls back Constitution and copied reference writes when an uncited prompt input changes", async () => {
    const f = await createCorpusFixture("constitution-uncited-input");
    const proposal = await prisma.proposal.create({ data: { workspaceId: f.workspace.id, authorUserId: f.user.id,
      title: "Second policy", bodyMd: "Uncited policy facts", status: "RESOLVED", resolutionOutcome: "ADOPTED", isPrivate: false, publishedAt: new Date() } });
    const uncited = await prisma.policyCorpus.create({ data: { workspaceId: f.workspace.id, proposalId: proposal.id,
      title: proposal.title, bodyMd: proposal.bodyMd, acceptedAt: new Date() } });
    await prisma.$transaction(async (tx) => {
      await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
        artifact: { kind: "Proposal", id: proposal.id }, content: proposal, origin: "HUMAN_ORIGINAL", inputs: [] });
      await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
        artifact: { kind: "PolicyCorpus", id: uncited.id }, content: uncited, origin: "DERIVED", inputs: [{ kind: "Proposal", id: proposal.id }] });
    });
    const captured = await loadConstitutionCorpusSnapshot(f.actor, prisma, f.workspace.id);
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, captured.corpus.map((policy) => ({ kind: "PolicyCorpus", id: policy.id, snapshot: policy })));
    await prisma.policyCorpus.update({ where: { id: uncited.id }, data: { bodyMd: "Changed after model context capture" } });
    await expect(createConstitutionVersion({ workspaceId: f.workspace.id, lineageActor: f.actor, lineageRoots: roots,
      bodyMd: "Candidate using both policies", modelUsed: "synthetic-model",
      references: [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: f.policy.id, sourceKind: "PROPOSAL" }] }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await prisma.constitution.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await prisma.constitutionSourceReference.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  });

});
