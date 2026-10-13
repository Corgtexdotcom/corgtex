import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known } from "../../agents/src/agents/model-consumer.test-fixture";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, lineageContentFingerprint,
  rebaseArtifactInputProofToSnapshots, type LineageRoot } from "./source-lineage";

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: typeof alpha) =>
  actor.kind === "user" ? fixture.domains.get(actor.user.id) ?? [] : [] }));

beforeEach(async () => {
  await resetFixture();
  fixture.prisma.$executeRaw.mockReset().mockResolvedValue(1);
  fixture.prisma.$queryRaw = vi.fn(async () => []);
  installSourcePermissionEpochFixture(fixture.prisma);
});

function originalArticle(id = "original") {
  return fixture.add("brainArticle", { id, workspaceId, title: "Synthetic original", bodyMd: "Exact earlier bytes",
    isPrivate: false, ownerMemberId: null, authority: "DRAFT", archivedAt: null });
}

async function olderRootWithReadableSnapshot() {
  const article = originalArticle();
  await known("BrainArticle", article, [], alpha);
  const [original] = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "BrainArticle", id: article.id }], fixture.prisma);
  const [saved] = await captureArtifactInputSnapshotProof(alpha, workspaceId, original, fixture.prisma);
  const snapshot = fixture.rows.artifactInputSnapshot.find((row: any) => row.id === saved.id);
  snapshot.id = "snapshot-zzzz";
  article.bodyMd = "New current bytes";
  return { article, original, snapshot };
}

describe("preserved input rebase keyset scan", () => {
  it("finds an allowed exact revision after more than one page of stale snapshots", async () => {
    const { article, original, snapshot } = await olderRootWithReadableSnapshot();
    const privateDocument = fixture.add("document", { id: "restricted-input", workspaceId,
      accessDomain: "FINANCE", title: "Restricted synthetic source", textContent: "No customer data", archivedAt: null });
    await known("Document", privateDocument, [], beta);
    const [privateRoot] = await captureArtifactInputProof(beta, workspaceId, [{ kind: "Document", id: privateDocument.id }], fixture.prisma);
    for (let index = 0; index < 105; index++) fixture.add("artifactInputSnapshot", {
      ...snapshot, id: `snapshot-${String(index).padStart(4, "0")}`,
      origin: "DERIVED", rootsJson: [privateRoot],
    });

    const rebased = await rebaseArtifactInputProofToSnapshots(alpha, workspaceId, [original], fixture.prisma);
    expect(rebased).toEqual([{ kind: "ArtifactInputSnapshot", id: snapshot.id,
      fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", snapshot) }]);
    expect(fixture.prisma.artifactInputSnapshot.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { gt: "snapshot-0099" } }), orderBy: { id: "asc" }, take: 100,
    }));
    article.isPrivate = true;
    article.ownerMemberId = "member-beta";
    await expect(rebaseArtifactInputProofToSnapshots(alpha, workspaceId, [original], fixture.prisma))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    article.isPrivate = false;
    article.ownerMemberId = null;
    article.archivedAt = new Date();
    await expect(rebaseArtifactInputProofToSnapshots(alpha, workspaceId, [original], fixture.prisma))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("fails closed with an explicit scan-limit error when the only eligible proof lies beyond 5,000 rows", async () => {
    const { original, snapshot } = await olderRootWithReadableSnapshot();
    const quickLookup = new Map<string, any>();
    for (let index = 0; index < 5_001; index++) {
      const row = fixture.add("artifactInputSnapshot", { ...snapshot,
        id: `snapshot-${String(index).padStart(4, "0")}`,
        accessEnvelopeJson: { ...snapshot.accessEnvelopeJson, isPrivate: true, ownerMemberId: "member-beta" },
      });
      quickLookup.set(row.id, row);
    }
    quickLookup.set(snapshot.id, snapshot);
    const findFirst = vi.mocked(fixture.prisma.artifactInputSnapshot.findFirst);
    const originalFindFirst = findFirst.getMockImplementation();
    findFirst.mockImplementation(async ({ where }: any) => quickLookup.get(where.id) ?? null);
    try {
      await expect(rebaseArtifactInputProofToSnapshots(alpha, workspaceId, [original], fixture.prisma))
        .rejects.toMatchObject({ code: "SOURCE_PROOF_SCAN_LIMIT" });
    } finally {
      findFirst.mockImplementation(originalFindFirst!);
    }
  });

  it("does not recover replayed unknown content or an unknown transitive source", async () => {
    const article = originalArticle("unproved-replay");
    await known("BrainArticle", article, [], alpha);
    const oldRoot: LineageRoot = { kind: "BrainArticle", id: article.id,
      fingerprint: lineageContentFingerprint("BrainArticle", article) };
    article.bodyMd = "Intervening unknown edit";
    article.bodyMd = "Exact earlier bytes";
    fixture.add("artifactInputLineage", { workspaceId, artifactType: "BrainArticle", artifactId: article.id,
      revision: 2, origin: "UNKNOWN", contentHash: oldRoot.fingerprint, inputsJson: null, rootsJson: null });
    await expect(rebaseArtifactInputProofToSnapshots(alpha, workspaceId, [oldRoot], fixture.prisma))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });

    const { original, snapshot } = await olderRootWithReadableSnapshot();
    const unknown = originalArticle("unknown-parent");
    const unknownRoot: LineageRoot = { kind: "BrainArticle", id: unknown.id,
      fingerprint: lineageContentFingerprint("BrainArticle", unknown) };
    fixture.add("artifactInputLineage", { workspaceId, artifactType: "BrainArticle", artifactId: unknown.id,
      revision: 1, origin: "UNKNOWN", contentHash: unknownRoot.fingerprint, inputsJson: null, rootsJson: null });
    snapshot.origin = "DERIVED";
    snapshot.rootsJson = [unknownRoot];
    await expect(rebaseArtifactInputProofToSnapshots(alpha, workspaceId, [original], fixture.prisma))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("requires current workspace membership before a saved proof can be reused", async () => {
    const { original } = await olderRootWithReadableSnapshot();
    fixture.rows.member.find((row: any) => row.userId === "alpha").isActive = false;
    await expect(rebaseArtifactInputProofToSnapshots(alpha, workspaceId, [original], fixture.prisma))
      .rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });
});
