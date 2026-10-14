import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, alpha, workspaceId, resetFixture, known } from "../../agents/src/agents/model-consumer.test-fixture";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, captureArtifactPermissionEpochs,
  lineageContentFingerprint, recordArtifactInputLineage, readableArtifactIds } from "./source-lineage";
import { isArtifactInputPermissionEpochCoverageComplete } from "./source-permission-coverage";

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async () => ["WORKSPACE"] }));
let epochs: ReturnType<typeof installSourcePermissionEpochFixture>;
beforeEach(async () => {
  await resetFixture();
  fixture.prisma.$executeRaw.mockReset().mockResolvedValue(1);
  fixture.prisma.$queryRaw = vi.fn(async () => []);
  epochs = installSourcePermissionEpochFixture(fixture.prisma);
});
async function source() {
  const row = fixture.add("document", { id: "original-document", workspaceId, title: "Synthetic original",
    textContent: "Disposable copied input", accessDomain: "WORKSPACE", archivedAt: null });
  await known("Document", row, [], alpha); return row;
}
function output() {
  return fixture.add("action", { id: "derived-action", workspaceId, title: "Derived output",
    bodyMd: "Disposable copied input", isPrivate: false, authorUserId: null, archivedAt: null });
}
function stripDocument(manifest: any) {
  manifest.permissionEpochsJson.entries = manifest.permissionEpochsJson.entries.filter((entry: any) => entry.kind !== "Document");
}
function coverage(action: any, manifest: any) {
  return isArtifactInputPermissionEpochCoverageComplete({ workspaceId, artifact: { kind: "Action", id: action.id },
    content: action, roots: manifest.rootsJson, permissionEpochs: manifest.permissionEpochsJson, db: fixture.prisma });
}

describe("complete saved consumption permission coverage", () => {
  it("withholds a missing consumption epoch even while its standalone H0 source is readable", async () => {
    const document = await source(), action = output();
    await known("Action", action, [{ kind: "Document", id: document.id }], alpha);
    const old = fixture.manifest("Action", action.id); stripDocument(old);
    const before = structuredClone(old.permissionEpochsJson);
    expect(await coverage(action, old)).toBe(false);
    expect(await readableArtifactIds(alpha, workspaceId, "Action", [action], fixture.prisma)).toEqual(new Set());
    expect(await readableArtifactIds(alpha, workspaceId, "Document", [document], fixture.prisma)).toEqual(new Set([document.id]));
    expect(old.permissionEpochsJson).toEqual(before);
  });

  it("uses an exact saved consumed root vector and never refreshes it after revoke and restore", async () => {
    const document = await source(), action = output();
    const consumed = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "Document", id: document.id }], fixture.prisma);
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId, artifact: { kind: "Action", id: action.id },
      content: action, origin: "DERIVED", inputs: [], inheritedRoots: consumed });
    const old = fixture.manifest("Action", action.id); stripDocument(old);
    expect(await coverage(action, old)).toBe(true);
    const before = structuredClone(old);
    epochs.bump(workspaceId, "Document", document.id); epochs.bump(workspaceId, "Document", document.id);
    expect(await coverage(action, old)).toBe(false);
    expect(old).toEqual(before);
  });

  it("cannot fill an old hole with a fresh snapshot grafted through a later same-body leaf manifest", async () => {
    const document = await source(), action = output();
    const leaf = fixture.add("brainSource", { id: "derived-leaf", workspaceId, sourceType: "TICKET", tier: "reference",
      content: document.textContent, accessDomain: "WORKSPACE", archivedAt: null });
    await known("BrainSource", leaf, [{ kind: "Document", id: document.id }], alpha);
    await known("Action", action, [{ kind: "BrainSource", id: leaf.id }], alpha);
    const old = fixture.manifest("Action", action.id); stripDocument(old);
    document.accessDomain = "FINANCE"; epochs.bump(workspaceId, "Document", document.id);
    document.accessDomain = "WORKSPACE"; epochs.bump(workspaceId, "Document", document.id);
    const fresh = await captureArtifactInputSnapshotProof(alpha, workspaceId, { kind: "Document", id: document.id }, fixture.prisma);
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: alpha, workspaceId, artifact: { kind: "BrainSource", id: leaf.id },
      content: leaf, origin: "DERIVED", inputs: [], inheritedRoots: fresh });
    expect(await readableArtifactIds(alpha, workspaceId, "BrainSource", [leaf], fixture.prisma)).toEqual(new Set([leaf.id]));
    expect(await coverage(action, old)).toBe(false);
    expect(await readableArtifactIds(alpha, workspaceId, "Action", [action], fixture.prisma)).toEqual(new Set());
  });

  it("requires the reverse native upload governor captured by a Finance batch", async () => {
    if (alpha.kind !== "user") throw new Error("Synthetic uploader must be a user.");
    const document = await source();
    const brain = fixture.add("brainSource", { id: "upload-source", workspaceId, sourceType: "ARTICLE",
      accessDomain: "WORKSPACE", content: "Synthetic independently contributed input" });
    await known("BrainSource", brain, [], alpha);
    for (const name of ["financeImportBatch", "financeReportUploadInput"]) {
      fixture.rows[name] = [];
      fixture.prisma[name] = { findFirst: vi.fn(async ({ where, select }: any) => {
        const row = fixture.rows[name].find(candidate => Object.entries(where).every(([field, value]) => candidate[field] === value));
        return row && select ? Object.fromEntries(Object.keys(select).map(field => [field, row[field]])) : row ?? null;
      }) };
    }
    const batch = fixture.add("financeImportBatch", { id: "upload-batch", workspaceId, createdByUserId: alpha.user.id });
    const upload = fixture.add("financeReportUploadInput", { id: "native-upload", workspaceId, batchId: batch.id,
      documentId: document.id, brainSourceId: brain.id, uploadedByUserId: alpha.user.id });
    const root = { kind: "Document" as const, id: document.id, fingerprint: lineageContentFingerprint("Document", document) };
    const proof = await captureArtifactPermissionEpochs(alpha, workspaceId,
      [{ kind: "FinanceImportBatch", id: batch.id, fingerprint: lineageContentFingerprint("FinanceImportBatch", batch) }, root], fixture.prisma);
    const params = { workspaceId, artifact: { kind: "FinanceImportBatch" as const, id: batch.id },
      content: batch, roots: [root], permissionEpochs: proof, db: fixture.prisma };
    expect(proof.entries).toContainEqual(expect.objectContaining({ kind: "FinanceReportUploadInput", id: upload.id }));
    expect(await isArtifactInputPermissionEpochCoverageComplete(params)).toBe(true);
    expect(await isArtifactInputPermissionEpochCoverageComplete({ ...params,
      permissionEpochs: { ...proof, entries: proof.entries.filter(entry => entry.kind !== "FinanceReportUploadInput") } })).toBe(false);
  });

  it("requires a saved credential snapshot's exact ToolLink parent identity", async () => {
    const document = await source(), action = output();
    fixture.rows.workspaceToolLink = [];
    const link = fixture.add("workspaceToolLink", { id: "synthetic-tool-link", workspaceId,
      createdByUserId: alpha.kind === "user" ? alpha.user.id : null, credentialLabel: "Synthetic credential",
      credentialSecretEnc: "encrypted-test-value", archivedAt: null });
    fixture.prisma.workspaceToolLink = { findFirst: vi.fn(async ({ where, select }: any) => {
      if (where.id !== link.id || where.workspaceId !== workspaceId) return null;
      return select ? Object.fromEntries(Object.keys(select).map(field => [field, link[field]])) : link;
    }) };
    const documentRoot = (await captureArtifactInputProof(alpha, workspaceId,
      [{ kind: "Document", id: document.id }], fixture.prisma))[0]!;
    const credentialRoot = { kind: "WorkspaceToolLinkCredential" as const, id: link.id,
      fingerprint: lineageContentFingerprint("WorkspaceToolLinkCredential", link) };
    const saved = await captureArtifactPermissionEpochs(alpha, workspaceId,
      [credentialRoot, documentRoot], fixture.prisma);
    expect(saved.entries).toContainEqual(expect.objectContaining({ kind: "WorkspaceToolLink", id: link.id }));
    // A malformed historical receipt declares an unrelated root and omits the
    // credential's real parent. It cannot borrow a fresh ToolLink epoch.
    const snapshot = fixture.add("artifactInputSnapshot", { id: "incomplete-credential-snapshot", workspaceId,
      sourceKind: credentialRoot.kind, sourceId: link.id, sourceFingerprint: credentialRoot.fingerprint,
      origin: "DERIVED", contentJson: Object.fromEntries(Object.entries(link).filter(([key]) => key !== "id")),
      accessEnvelopeJson: { createdByUserId: link.createdByUserId },
      rootsJson: [documentRoot], epochProofVersion: 1,
      permissionEpochsJson: { ...saved, entries: saved.entries.filter(entry => entry.kind !== "WorkspaceToolLink") } });
    const snapshotRoot = { kind: "ArtifactInputSnapshot" as const, id: snapshot.id,
      fingerprint: lineageContentFingerprint("ArtifactInputSnapshot", snapshot) };
    const outputProof = await captureArtifactPermissionEpochs(alpha, workspaceId,
      [{ kind: "Action", id: action.id, fingerprint: lineageContentFingerprint("Action", action) }], fixture.prisma);
    expect(await isArtifactInputPermissionEpochCoverageComplete({ workspaceId,
      artifact: { kind: "Action", id: action.id }, content: action, roots: [snapshotRoot],
      permissionEpochs: outputProof, db: fixture.prisma })).toBe(false);
  });
});
