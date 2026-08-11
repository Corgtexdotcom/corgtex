import { beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import {
  acquireConstitutionCorpusAdvisoryLock,
  createConstitutionVersion,
  loadConstitutionCorpusSnapshot,
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
  return { workspace, proposal, tension, policy };
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
    const [crossProposalPolicy, localPolicy, foreignTension] = await Promise.all([
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
    ]);

    const snapshot = await loadConstitutionCorpusSnapshot(prisma, localWorkspace.id);
    expect(snapshot.corpus.map((row) => Object.keys(row).sort())).toEqual([
      ["acceptedAt", "bodyMd", "id", "title"],
      ["acceptedAt", "bodyMd", "id", "title"],
    ]);
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
  });

  it("rechecks corpus drift after the shared writer lock", async () => {
    const { workspace, policy } = await createCorpusFixture("constitution-drift");
    const snapshot = await loadConstitutionCorpusSnapshot(prisma, workspace.id);
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
    });
    await waitForQueuedCorpusLock(workspace.id);
    releaseWriter();
    await writer;

    await expect(constitution).rejects.toThrow("Constitution policy corpus changed during synthesis.");
    await expect(prisma.constitution.count({ where: { workspaceId: workspace.id } })).resolves.toBe(0);
  });

  it("retains snapshots after source deletion while rejecting invalid source ownership", async () => {
    const { workspace, proposal, tension, policy } = await createCorpusFixture();
    const snapshot = await loadConstitutionCorpusSnapshot(prisma, workspace.id);
    const constitution = await createConstitutionVersion({
      workspaceId: workspace.id,
      bodyMd: "# Constitution",
      modelUsed: "integration-test",
      expectedCorpusFingerprint: snapshot.fingerprint,
      references: [
        { pointOrder: 1, sourceOrder: 1, policyCorpusId: policy.id, sourceKind: "PROPOSAL", proposalId: proposal.id },
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
});
