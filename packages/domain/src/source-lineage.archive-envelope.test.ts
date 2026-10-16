import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known } from "../../agents/src/agents/model-consumer.test-fixture";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import { advanceArchivedArtifactEnvelopeLineage, captureArtifactInputProof, captureArtifactInputSnapshotProof, inspectStoredArtifactInputDependencies,
  invalidateArtifactInputLineage, isArtifactInputProofReadable, isArtifactArchiveMetadataReadable, readableArtifactIds, lineageContentFingerprint, withArtifactInputWriteFence } from "./source-lineage";
import { isArtifactPermissionEpochProofCurrent } from "./source-permission-epochs";

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: typeof alpha) =>
  actor.kind === "user" ? fixture.domains.get(actor.user.id) ?? [] : [] }));

let epochs: ReturnType<typeof installSourcePermissionEpochFixture>;
beforeEach(async () => {
  await resetFixture();
  fixture.prisma.$executeRaw.mockReset().mockResolvedValue(1);
  fixture.prisma.$queryRaw = vi.fn(async () => []);
  epochs = installSourcePermissionEpochFixture(fixture.prisma);
});
function article(id = "human-original") {
  return fixture.add("brainArticle", { id, workspaceId, title: "Synthetic original", bodyMd: "Exact original body",
    isPrivate: false, ownerMemberId: null, authority: "DRAFT", archivedAt: null, updatedAt: fixture.timestamp });
}
function advance(before: any, after: any) {
  return advanceArchivedArtifactEnvelopeLineage({ tx: fixture.prisma, workspaceId,
    artifact: { kind: "BrainArticle", id: before.id }, before, after });
}

describe("administrative archive transitions preserve exact ancestry and earlier permission revisions", () => {
  it("advances an unchanged original through archive/restore without replacing its stored epoch vector or reviving a copied snapshot", async () => {
    const row = article();
    await known("BrainArticle", row, [], alpha);
    const prior = structuredClone(fixture.manifest("BrainArticle", row.id));
    const snapshot = await captureArtifactInputSnapshotProof(alpha, workspaceId, { kind: "BrainArticle", id: row.id }, fixture.prisma);
    expect(await isArtifactInputProofReadable(alpha, workspaceId, snapshot, fixture.prisma)).toBe(true);
    const before = structuredClone(row);
    Object.assign(row, { archivedAt: new Date("2026-10-13T10:00:00Z"), archivedByUserId: "alpha", archiveReason: "Synthetic retirement", updatedAt: new Date("2026-10-13T10:00:00Z") });
    epochs.bump(workspaceId, "BrainArticle", row.id);
    const fence = vi.fn(async (tx) => { expect(tx).toBe(fixture.prisma); });
    expect(await withArtifactInputWriteFence(fence, () => advance(before, row))).toBe(true);
    const archived = structuredClone(fixture.manifest("BrainArticle", row.id));
    expect(archived).toMatchObject({ origin: "HUMAN_ORIGINAL", revision: prior.revision + 1,
      contentHash: lineageContentFingerprint("BrainArticle", row), permissionEpochsJson: prior.permissionEpochsJson,
      epochProofVersion: prior.epochProofVersion, rootsJson: [], inputsJson: [] });
    expect(fence).toHaveBeenCalledTimes(2);
    expect(await isArtifactPermissionEpochProofCurrent(workspaceId, archived.permissionEpochsJson, fixture.prisma)).toBe(false);
    expect(await isArtifactInputProofReadable(alpha, workspaceId, snapshot, fixture.prisma)).toBe(false);
    const archivedBody = structuredClone(row);
    Object.assign(row, { archivedAt: null, archivedByUserId: null, archiveReason: null, updatedAt: new Date("2026-10-13T11:00:00Z") });
    epochs.bump(workspaceId, "BrainArticle", row.id);
    expect(await advance(archivedBody, row)).toBe(true);
    const restored = fixture.manifest("BrainArticle", row.id);
    expect(restored.permissionEpochsJson).toEqual(prior.permissionEpochsJson);
    expect(await isArtifactInputProofReadable(alpha, workspaceId, snapshot, fixture.prisma)).toBe(false);
    const fresh = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "BrainArticle", id: row.id }], fixture.prisma);
    expect(await isArtifactInputProofReadable(alpha, workspaceId, fresh, fixture.prisma)).toBe(true);
    expect(row.bodyMd).toBe(before.bodyMd);
  });

  it("preserves derived ancestry for retirement after archive/restore without reviving the old body", async () => {
    const input = article("independent-input"); await known("BrainArticle", input, [], alpha);
    const row = article("copied-output"); await known("BrainArticle", row, [{ kind: "BrainArticle", id: input.id }], alpha);
    const prior = structuredClone(fixture.manifest("BrainArticle", row.id));
    const before = structuredClone(row);
    Object.assign(row, { archivedAt: new Date("2026-10-13T10:00:00Z"), updatedAt: new Date("2026-10-13T10:00:00Z") });
    epochs.bump(workspaceId, "BrainArticle", row.id);
    expect(await advance(before, row)).toBe(true);
    const archived = structuredClone(row);
    Object.assign(row, { archivedAt: null, updatedAt: new Date("2026-10-13T11:00:00Z") });
    epochs.bump(workspaceId, "BrainArticle", row.id);
    expect(await advance(archived, row)).toBe(true);
    const restored = fixture.manifest("BrainArticle", row.id);
    expect(restored).toMatchObject({ origin: "DERIVED", rootsJson: prior.rootsJson, inputsJson: prior.inputsJson,
      permissionEpochsJson: prior.permissionEpochsJson, contentHash: lineageContentFingerprint("BrainArticle", row) });
    expect(await isArtifactPermissionEpochProofCurrent(workspaceId, restored.permissionEpochsJson, fixture.prisma)).toBe(false);
    expect(await readableArtifactIds(alpha, workspaceId, "BrainArticle", [row], fixture.prisma)).toEqual(new Set());
    const ancestry = await inspectStoredArtifactInputDependencies(fixture.prisma, workspaceId, restored.rootsJson);
    expect(ancestry).toMatchObject({ complete: true, roots: expect.arrayContaining([expect.objectContaining({ id: input.id })]) });
    await expect(captureArtifactInputProof(alpha, workspaceId, [{ kind: "BrainArticle", id: row.id }], fixture.prisma))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });
  it.each(["UNKNOWN", "MISSING"] as const)("does not advance %s content", async origin => {
    const row = article();
    if (origin === "UNKNOWN") {
      await invalidateArtifactInputLineage({ tx: fixture.prisma, workspaceId, artifact: { kind: "BrainArticle", id: row.id }, content: row });
    }
    const count = fixture.rows.artifactInputLineage.length;
    expect(await advance(row, { ...row, archivedAt: new Date() })).toBe(false);
    expect(fixture.rows.artifactInputLineage).toHaveLength(count);
  });

  it.each(["bodyMd", "title", "isPrivate", "ownerMemberId"])("refuses a non-archive change to %s alongside the envelope transition", async field => {
    const row = article(); await known("BrainArticle", row, [], alpha);
    const count = fixture.rows.artifactInputLineage.length;
    expect(await advance(row, { ...row, archivedAt: new Date(), [field]: field === "isPrivate" ? true : "Changed value" })).toBe(false);
    expect(fixture.rows.artifactInputLineage).toHaveLength(count);
  });

  it("refuses an unattested before-image and preserves the original receipt", async () => {
    const row = article(); await known("BrainArticle", row, [], alpha);
    const before = { ...row, bodyMd: "An unproved intervening edit" };
    expect(await advance(before, { ...before, archivedAt: new Date() })).toBe(false);
    expect(fixture.manifest("BrainArticle", row.id).revision).toBe(1);
  });

  it("honors the caller write fence before minting the envelope receipt", async () => {
    const row = article(); await known("BrainArticle", row, [], alpha);
    await expect(withArtifactInputWriteFence(async () => { throw new Error("Synthetic lease revoked"); },
      () => advance(row, { ...row, archivedAt: new Date() }))).rejects.toThrow("Synthetic lease revoked");
    expect(fixture.manifest("BrainArticle", row.id).revision).toBe(1);
  });
});


describe("archive metadata uses current source permissions", () => {
  async function archiveOriginal(row = article()) {
    await known("BrainArticle", row, [], alpha);
    const before = structuredClone(row);
    row.archivedAt = new Date("2026-10-13T10:00:00Z");
    epochs.bump(workspaceId, "BrainArticle", row.id);
    expect(await advance(before, row)).toBe(true);
    return row;
  }

  it("admits metadata for a proven original without allowing its archived body as an input", async () => {
    const row = await archiveOriginal();
    expect(await isArtifactArchiveMetadataReadable(alpha, workspaceId, { kind: "BrainArticle", id: row.id }, fixture.prisma)).toBe(true);
    expect(await readableArtifactIds(alpha, workspaceId, "BrainArticle", [row], fixture.prisma)).toEqual(new Set());
    await expect(captureArtifactInputProof(alpha, workspaceId, [{ kind: "BrainArticle", id: row.id }], fixture.prisma)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("requires the current private owner, membership and workspace even for metadata", async () => {
    const row = article(); row.isPrivate = true; row.ownerMemberId = "member-alpha";
    await archiveOriginal(row);
    expect(await isArtifactArchiveMetadataReadable(alpha, workspaceId, { kind: "BrainArticle", id: row.id }, fixture.prisma)).toBe(true);
    expect(await isArtifactArchiveMetadataReadable(beta, workspaceId, { kind: "BrainArticle", id: row.id }, fixture.prisma)).toBe(false);
    expect(await isArtifactArchiveMetadataReadable(alpha, "ws-b", { kind: "BrainArticle", id: row.id }, fixture.prisma).catch((error: { code: string }) => error.code)).toBe("NOT_A_MEMBER");
    fixture.rows.member.find((member: any) => member.userId === "alpha").isActive = false;
    await expect(isArtifactArchiveMetadataReadable(alpha, workspaceId, { kind: "BrainArticle", id: row.id }, fixture.prisma)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it.each(["DERIVED", "UNKNOWN", "MISSING"] as const)("withholds archived %s identities", async origin => {
    const row = article();
    if (origin === "DERIVED") {
      const input = article("proven-input"); await known("BrainArticle", input, [], alpha);
      await known("BrainArticle", row, [{ kind: "BrainArticle", id: input.id }], alpha);
    } else if (origin === "UNKNOWN") await invalidateArtifactInputLineage({ tx: fixture.prisma, workspaceId,
      artifact: { kind: "BrainArticle", id: row.id }, content: row });
    row.archivedAt = new Date();
    // A matching current hash is insufficient: copied and unknown manifests
    // must never acquire the original-only metadata exception.
    const manifest = fixture.manifest("BrainArticle", row.id);
    if (manifest) manifest.contentHash = lineageContentFingerprint("BrainArticle", row);
    expect(await isArtifactArchiveMetadataReadable(alpha, workspaceId, { kind: "BrainArticle", id: row.id }, fixture.prisma)).toBe(false);
  });

  it("rejects stale or legacy receipt structure and purged targets", async () => {
    const row = await archiveOriginal();
    const manifest = fixture.manifest("BrainArticle", row.id);
    const hash = manifest.contentHash;
    row.bodyMd = "Changed unattested body";
    expect(await isArtifactArchiveMetadataReadable(alpha, workspaceId, { kind: "BrainArticle", id: row.id }, fixture.prisma)).toBe(false);
    row.bodyMd = "Exact original body";
    expect(lineageContentFingerprint("BrainArticle", row)).toBe(hash);
    manifest.permissionEpochsJson = { ...manifest.permissionEpochsJson, policyVersion: "pun68-permissions-v1" };
    expect(await isArtifactArchiveMetadataReadable(alpha, workspaceId, { kind: "BrainArticle", id: row.id }, fixture.prisma)).toBe(false);
    fixture.rows.brainArticle = [];
    expect(await isArtifactArchiveMetadataReadable(alpha, workspaceId, { kind: "BrainArticle", id: row.id }, fixture.prisma)).toBe(false);
  });
});
