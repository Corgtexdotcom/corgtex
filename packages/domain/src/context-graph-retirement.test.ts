import { beforeEach, describe, expect, it, vi } from "vitest";
const { db, fence } = vi.hoisted(() => ({
  fence: vi.fn(),
  db: {
    $transaction: vi.fn(), $queryRaw: vi.fn(), workflowJob: { findFirst: vi.fn() }, event: { findFirst: vi.fn() },
    derivedArtifactRebuildState: { upsert: vi.fn() },
    artifactInputLineage: { findFirst: vi.fn(), create: vi.fn() }, artifactInputSnapshot: { findFirst: vi.fn() },
    nativeTranscriptInput: { findFirst: vi.fn() }, communicationMessageNativeInput: { findFirst: vi.fn() },
    externalProviderFetchInput: { findFirst: vi.fn() },
    contextGraphObject: { findMany: vi.fn(), update: vi.fn() }, contextGraphRelationship: { findMany: vi.fn(), update: vi.fn() },
    contextGraphEvidenceRef: { findMany: vi.fn() }, contextGraphProposedDiff: { findMany: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@corgtex/shared", () => ({ prisma: db }));
vi.mock("./source-permission-epochs", async importOriginal => {
  const actual = await importOriginal<typeof import("./source-permission-epochs")>();
  return { ...actual, capturePermissionEpochs: vi.fn(async () => ({ version: 1, policyVersion: actual.SOURCE_PERMISSION_POLICY_VERSION,
    entries: [{ kind: "Document", id: "document-a", epoch: "2" }] })) };
});
vi.mock("./source-lineage", async () => {
  const actual = await vi.importActual<typeof import("./source-lineage")>("./source-lineage");
  return { assertArtifactInputWriteFence: fence, isLineageKind: actual.isLineageKind, lineageContentFingerprint: actual.lineageContentFingerprint };
});
import { inspectStoredArtifactInputDependencyIdentities, retireContextGraphSourceDescendants, retireContextGraphChangedSourceDescendants } from "./context-graph-retirement";
import type { Prisma } from "@prisma/client";
import { SOURCE_PERMISSION_POLICY_VERSION } from "./source-permission-epochs";
import { lineageContentFingerprint } from "./source-lineage";
const tx = db as unknown as Prisma.TransactionClient;
const lease = { lockedBy: "worker-a", lockedAt: new Date("2026-10-13T10:00:00Z") };
const identity = { workspaceId: "ws-a", workflowJobId: "job-a", sourceType: "DOCUMENT", sourceId: "document-a", attempts: 2, expectedLease: lease };
const capturedEpochs = { epochProofVersion: 1, permissionEpochsJson: { version: 1, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
  entries: [{ kind: "Document", id: "document-a", epoch: "2" }] } };
const manifest = { ...capturedEpochs, id: "manifest-graph", revision: 3, origin: "DERIVED", contentHash: "a".repeat(64), rootsJson: [
  { kind: "ArtifactInputSnapshot", id: "snapshot-a", fingerprint: "b".repeat(64) },
] };
beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async cb => cb(db));
  db.$queryRaw.mockResolvedValue([{ id: "locked" }]);
  db.workflowJob.findFirst.mockResolvedValue({ id: "job-a", workspaceId: "ws-a", type: "context-graph.sync", status: "RUNNING",
    attempts: 2, ...lease, eventId: "event-a", dependsOnJobId: null, dedupeKey: "event-a:context-graph-sync:DOCUMENT:document-a",
    payload: { sourceType: "DOCUMENT", sourceId: "document-a" } });
  db.event.findFirst.mockResolvedValue({ id: "event-a", type: "document.updated", aggregateType: "Document", aggregateId: "document-a", payload: { documentId: "document-a" } });
  db.contextGraphObject.findMany.mockResolvedValue([{ id: "graph-a" }]);
  db.contextGraphRelationship.findMany.mockResolvedValue([]);
  db.contextGraphEvidenceRef.findMany.mockResolvedValue([]);
  db.contextGraphProposedDiff.findMany.mockResolvedValue([]);
  db.artifactInputLineage.findFirst.mockResolvedValue(manifest);
  db.nativeTranscriptInput.findFirst.mockResolvedValue(null);
  db.communicationMessageNativeInput.findFirst.mockResolvedValue(null);
  db.externalProviderFetchInput.findFirst.mockResolvedValue(null);
  db.artifactInputSnapshot.findFirst.mockResolvedValue({ ...capturedEpochs, sourceKind: "Document", sourceId: "document-a", sourceFingerprint: "c".repeat(64), origin: "HUMAN_ORIGINAL", rootsJson: [] });
});
describe("source-bound graph retirement", () => {
  it("retires an unreadable historical snapshot descendant without selecting any body", async () => {
    await retireContextGraphSourceDescendants(identity);
    expect(db.contextGraphObject.update).not.toHaveBeenCalled();
    expect(db.artifactInputLineage.create).toHaveBeenCalledWith({ data: {
      workspaceId: "ws-a", artifactType: "ContextGraphObject", artifactId: "graph-a", revision: 4,
      origin: "UNKNOWN", contentHash: "a".repeat(64), inputsJson: [], rootsJson: [],
    } });
    expect(db.contextGraphObject.findMany.mock.calls[0][0].select).toEqual({ id: true });
    expect(db.artifactInputSnapshot.findFirst.mock.calls[0][0].select).not.toHaveProperty("contentJson");
    expect(db.artifactInputSnapshot.findFirst.mock.calls[0][0].select).not.toHaveProperty("accessEnvelopeJson");
    expect(fence).toHaveBeenCalledWith(db);
    expect(db.derivedArtifactRebuildState.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({
      targetManifestId: "manifest-graph", targetFingerprint: "a".repeat(64), state: "REBUILD_REQUIRED", eventId: "event-a",
      sourceStateJson: { permissionEpochs: expect.objectContaining({ entries: [{ kind: "Document", id: "document-a", epoch: "2" }] }) },
    }) }));
  });
  it("preserves human originals, unknown manifests, unsupported roots and other-source composites", async () => {
    for (const origin of ["HUMAN_ORIGINAL", "UNKNOWN"]) {
      db.artifactInputLineage.findFirst.mockResolvedValue({ ...manifest, origin, rootsJson: [] });
      await retireContextGraphSourceDescendants(identity);
    }
    db.artifactInputLineage.findFirst.mockResolvedValue(manifest);
    db.artifactInputSnapshot.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ ...capturedEpochs, sourceKind: "Document", sourceId: "other", sourceFingerprint: "e".repeat(64), origin: "HUMAN_ORIGINAL", rootsJson: [] });
    await retireContextGraphSourceDescendants(identity);
    await retireContextGraphSourceDescendants(identity);
    expect(db.contextGraphObject.update).not.toHaveBeenCalled();
    expect(db.artifactInputLineage.create).not.toHaveBeenCalled();
  });
  it.each([
    { attempts: 1 }, { expectedLease: { ...lease, lockedBy: "old-worker" } },
    { expectedLease: { ...lease, lockedAt: new Date(0) } }, { sourceId: "unrelated" }, { workspaceId: "ws-b" },
  ])("rejects changed job scope before effects: %j", async change => {
    // Real tenant-scoped lookup has no result for another workspace.
    if ("workspaceId" in change) db.workflowJob.findFirst.mockResolvedValue(null);
    await expect(retireContextGraphSourceDescendants({ ...identity, ...change })).rejects.toThrow();
    expect(db.contextGraphObject.findMany).not.toHaveBeenCalled();
    expect(db.artifactInputLineage.create).not.toHaveBeenCalled();
  });
  it("rechecks the lease before effects and the manifest revision under the graph lock", async () => {
    const job = await db.workflowJob.findFirst();
    db.workflowJob.findFirst.mockResolvedValueOnce(job).mockResolvedValueOnce({ ...job, lockedBy: "replacement" });
    await expect(retireContextGraphSourceDescendants(identity)).rejects.toThrow("lease changed");
    expect(db.contextGraphObject.update).not.toHaveBeenCalled();
    db.workflowJob.findFirst.mockResolvedValue(job);
    db.artifactInputLineage.findFirst.mockResolvedValueOnce(manifest).mockResolvedValueOnce({ ...manifest, id: "new", revision: 4 });
    await expect(retireContextGraphSourceDescendants(identity)).rejects.toThrow("provenance changed");
    expect(db.contextGraphObject.update).not.toHaveBeenCalled();
  });
  it("accepts only a completed, matching durable reconcile parent", async () => {
    const child = { id: "job-a", workspaceId: "ws-a", type: "context-graph.sync", status: "RUNNING", attempts: 2, ...lease,
      eventId: "event-a", dependsOnJobId: "parent", dedupeKey: "ws-a:context-graph-reconcile:DOCUMENT:document-a:rebuild:event-a",
      payload: { sourceType: "DOCUMENT", sourceId: "document-a" } };
    const parent = { id: "parent", type: "context-graph.reconcile", status: "COMPLETED", eventId: "event-a", payload: { dateISO: "rebuild:event-a" } };
    db.workflowJob.findFirst.mockImplementation(async args => args.where.id === "parent" ? parent : child);
    await retireContextGraphSourceDescendants(identity);
    expect(db.artifactInputLineage.create).toHaveBeenCalledOnce();
    db.contextGraphObject.update.mockClear(); parent.status = "RUNNING";
    await expect(retireContextGraphSourceDescendants(identity)).rejects.toThrow("reconciliation scope changed");
    expect(db.contextGraphObject.update).not.toHaveBeenCalled();
  });
  it("withholds evidence and prior approvals while preserving every original field", async () => {
    db.contextGraphEvidenceRef.findMany.mockResolvedValue([{ id: "evidence-a" }]);
    db.contextGraphProposedDiff.findMany.mockResolvedValue([{ id: "diff-a" }]);
    await retireContextGraphSourceDescendants(identity);
    expect(db.contextGraphProposedDiff.update).not.toHaveBeenCalled();
    expect(db.artifactInputLineage.create).toHaveBeenCalledTimes(3);
    db.artifactInputLineage.findFirst.mockResolvedValue({ ...manifest, revision: 4, origin: "UNKNOWN", rootsJson: [] });
    db.artifactInputLineage.create.mockClear(); db.contextGraphObject.update.mockClear();
    await retireContextGraphSourceDescendants(identity);
    expect(db.artifactInputLineage.create).not.toHaveBeenCalled();
    expect(db.contextGraphObject.update).not.toHaveBeenCalled();
  });
  it("retires deleted-source descendants from the actual reconcile event before native enumeration", async () => {
    db.workflowJob.findFirst.mockResolvedValue({ id: "job-a", type: "context-graph.reconcile", status: "RUNNING", attempts: 2,
      ...lease, eventId: "event-a", dedupeKey: "ws-a:source-lineage-rebuild:event-a:native-graph", payload: { dateISO: "rebuild:event-a" } });
    db.event.findFirst.mockResolvedValue({ id: "event-a", type: "source-lineage.changed", aggregateType: "BrainSource", aggregateId: "deleted",
      payload: { kind: "BrainSource", id: "deleted", change: "purged" } });
    db.artifactInputSnapshot.findFirst.mockResolvedValue({ ...capturedEpochs, sourceKind: "BrainSource", sourceId: "deleted", sourceFingerprint: "e".repeat(64), origin: "HUMAN_ORIGINAL", rootsJson: [] });
    await retireContextGraphChangedSourceDescendants(identity);
    expect(db.artifactInputLineage.create).toHaveBeenCalledOnce();
    expect(db.contextGraphObject.update).not.toHaveBeenCalled();
    db.event.findFirst.mockResolvedValue({ id: "event-a", type: "source-lineage.changed", aggregateType: "BrainSource", aggregateId: "deleted",
      payload: { kind: "BrainSource", id: "swapped" } });
    await expect(retireContextGraphChangedSourceDescendants(identity)).rejects.toThrow("event scope changed");
  });

  it("rejects oversized scans before partial retirement", async () => {
    db.contextGraphObject.findMany.mockResolvedValue(Array.from({ length: 5001 }, (_, index) => ({ id: String(index) })));
    await expect(retireContextGraphSourceDescendants(identity)).rejects.toThrow("bounded reconciliation");
    expect(db.contextGraphObject.update).not.toHaveBeenCalled();
  });
});
describe("metadata-only complete ancestry", () => {
  const nativeFetch = (sourceKind = "FILE", toolName = "get_file_content") => {
    const key = sourceKind === "FILE" ? "file_id" : sourceKind === "FOLDER" ? "folder_id" : "hub_id";
    return { id: "native-box", workspaceId: "ws-a", externalContentSourceId: "selected-source", connectionId: "connection",
      localUserId: "owner", providerKey: "box", serverUrl: "https://mcp.box.com", providerAccountId: "provider-owner",
      sourceKind, externalId: "selected-external-id", toolName, requestJson: { [key]: "selected-external-id" },
      encryptedResponseJson: "persisted encrypted original response", responseHash: "c".repeat(64), connectionGrantHash: "d".repeat(64),
      fetchedAt: new Date("2026-10-12T10:00:00Z"), createdAt: new Date("2026-10-12T10:00:00Z") };
  };
  const nativeFetchManifest = (input: ReturnType<typeof nativeFetch>) => ({ ...manifest,
    rootsJson: [{ kind: "ExternalProviderFetchInput", id: input.id, fingerprint: lineageContentFingerprint("ExternalProviderFetchInput", input) }],
    permissionEpochsJson: { version: 1, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
      entries: [{ kind: "ExternalProviderFetchInput", id: input.id, epoch: "7" }] } });

  it.each([
    ["FILE", "get_file_details"], ["FILE", "get_file_content"], ["FOLDER", "get_folder_details"],
    ["FOLDER", "list_folder_content_by_folder_id"], ["HUB", "get_hub_details"], ["HUB", "get_hub_items"],
  ])("recognizes stored native %s/%s metadata without current provider or audience reads", async (sourceKind, toolName) => {
    const native = nativeFetch(sourceKind, toolName);
    db.artifactInputLineage.findFirst.mockResolvedValueOnce(nativeFetchManifest(native)).mockResolvedValue(null);
    db.externalProviderFetchInput.findFirst.mockResolvedValue(native);
    // The historical vector need not equal current counters for fresh recipe
    // discovery; separately admitted original sources must prove current access.
    db.$queryRaw.mockRejectedValue(new Error("Current permission queries are forbidden in metadata discovery"));
    const result = await inspectStoredArtifactInputDependencyIdentities(tx, "ws-a", { kind: "ContextGraphObject", id: "graph-a" });
    expect(result.complete).toBe(true);
    expect(result.dependencies).toContainEqual({ kind: "ExternalProviderFetchInput", id: native.id });
    expect(JSON.stringify(result)).not.toMatch(/encrypted original response|provider-owner|connectionGrantHash/);
    expect(db.externalProviderFetchInput.findFirst).toHaveBeenCalledWith({ where: { id: native.id, workspaceId: "ws-a" } });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.artifactInputLineage.create).not.toHaveBeenCalled();
  });

  it.each(["missing-row", "foreign-row", "edited-fingerprint", "missing-native-epoch", "malformed-root-vector",
    "legacy-target", "account", "binding", "provider", "endpoint", "cipher", "hash", "ai-tool", "wrong-source-tool", "request-id", "extra-argument"])(
    "does not certify unproved external native ancestry: %s", async scenario => {
      const native = nativeFetch();
      if (scenario === "account") native.providerAccountId = "";
      if (scenario === "binding") native.externalContentSourceId = "";
      if (scenario === "provider") native.providerKey = "legacy-http";
      if (scenario === "endpoint") native.serverUrl = "https://untrusted.example.test";
      if (scenario === "cipher") native.encryptedResponseJson = "";
      if (scenario === "hash") native.responseHash = "guessed-hash";
      if (scenario === "ai-tool") native.toolName = "ai_qa_single_file";
      if (scenario === "wrong-source-tool") native.toolName = "get_folder_details";
      if (scenario === "request-id") native.requestJson = { file_id: "other-file" };
      if (scenario === "extra-argument") native.requestJson = { file_id: native.externalId, prompt: "unproved model question" };
      const receipt = nativeFetchManifest(native);
      if (scenario === "legacy-target") receipt.permissionEpochsJson = null as any;
      if (scenario === "missing-native-epoch") receipt.permissionEpochsJson.entries = [{ kind: "Document", id: "other", epoch: "0" }];
      if (scenario === "malformed-root-vector") Object.assign(receipt.rootsJson[0], { permissionEpochs: { version: 1,
        policyVersion: SOURCE_PERMISSION_POLICY_VERSION, entries: [] } });
      db.artifactInputLineage.findFirst.mockResolvedValueOnce(receipt).mockResolvedValue(null);
      if (scenario === "edited-fingerprint") native.encryptedResponseJson = "changed after original capture";
      if (scenario === "foreign-row") native.workspaceId = "ws-other";
      db.externalProviderFetchInput.findFirst.mockResolvedValue(scenario === "missing-row" ? null : native);
      expect((await inspectStoredArtifactInputDependencyIdentities(tx, "ws-a", { kind: "ContextGraphObject", id: "graph-a" })).complete).toBe(false);
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.artifactInputLineage.create).not.toHaveBeenCalled();
    });

  it.each(["version", "null", "empty", "malformed", "obsolete-policy"])("rejects a nonempty legacy derived target with %s captured proof", async kind => {
    const legacy = structuredClone(manifest);
    if (kind === "version") legacy.epochProofVersion = null as any;
    if (kind === "null") legacy.permissionEpochsJson = null as any;
    if (kind === "empty") legacy.permissionEpochsJson.entries = [];
    if (kind === "malformed") legacy.permissionEpochsJson.entries[0].epoch = "new-counter";
    if (kind === "obsolete-policy") legacy.permissionEpochsJson.policyVersion = "pun68-permissions-legacy";
    db.artifactInputLineage.findFirst.mockResolvedValue(legacy);
    expect((await inspectStoredArtifactInputDependencyIdentities(tx, "ws-a", { kind: "ContextGraphObject", id: "graph-a" })).complete).toBe(false);
    expect(db.artifactInputSnapshot.findFirst).not.toHaveBeenCalled();
    expect(db.artifactInputLineage.create).not.toHaveBeenCalled();
  });

  it("can follow exact historical receipts after a source is physically deleted", async () => {
    db.artifactInputLineage.findFirst.mockResolvedValueOnce({ ...manifest, rootsJson: [{ kind: "Document", id: "deleted", fingerprint: "d".repeat(64) }] })
      .mockResolvedValueOnce({ id: "old", revision: 1, contentHash: "d".repeat(64), origin: "HUMAN_ORIGINAL", rootsJson: [] });
    const result = await inspectStoredArtifactInputDependencyIdentities(tx, "ws-a", { kind: "ContextGraphObject", id: "graph-a" });
    expect(result.complete).toBe(true);
    expect(result.dependencies).toContainEqual({ kind: "Document", id: "deleted" });
    expect(db.artifactInputLineage.findFirst.mock.calls[1][0].where.contentHash).toBe("d".repeat(64));
  });
  it("rejects unknown kind tags and copied-only snapshot originals without loading content", async () => {
    db.artifactInputLineage.findFirst.mockResolvedValueOnce({ ...manifest, rootsJson: [{ kind: "Unregistered", id: "x", fingerprint: "f".repeat(64) }] });
    expect((await inspectStoredArtifactInputDependencyIdentities(tx, "ws-a", { kind: "ContextGraphObject", id: "graph-a" })).complete).toBe(false);
    db.artifactInputLineage.findFirst.mockResolvedValue(manifest);
    db.artifactInputSnapshot.findFirst.mockResolvedValue({ ...capturedEpochs, sourceKind: "KnowledgeChunk", sourceId: "chunk", sourceFingerprint: "f".repeat(64), origin: "HUMAN_ORIGINAL", rootsJson: [] });
    expect((await inspectStoredArtifactInputDependencyIdentities(tx, "ws-a", { kind: "ContextGraphObject", id: "graph-a" })).complete).toBe(false);
  });

  it.each(["CommunicationMessageNativeInput", "NativeTranscriptInput"])("accepts only immutable native constructor snapshot ancestry for %s", async kind => {
    db.artifactInputSnapshot.findFirst.mockResolvedValue({ ...capturedEpochs, sourceKind: kind, sourceId: "native-input", sourceFingerprint: "c".repeat(64), origin: "NATIVE_ORIGINAL", rootsJson: [] });
    expect((await inspectStoredArtifactInputDependencyIdentities(tx, "ws-a", { kind: "ContextGraphObject", id: "graph-a" })).complete).toBe(true);
    db.artifactInputLineage.findFirst.mockResolvedValueOnce({ ...manifest, rootsJson: [{ kind, id: "native-input", fingerprint: "c".repeat(64) }] }).mockResolvedValue(null);
    expect((await inspectStoredArtifactInputDependencyIdentities(tx, "ws-a", { kind: "ContextGraphObject", id: "graph-a" })).complete).toBe(false);
    db.artifactInputLineage.findFirst.mockResolvedValue(manifest);
    db.artifactInputSnapshot.findFirst.mockResolvedValue({ ...capturedEpochs, sourceKind: kind, sourceId: "native-input", sourceFingerprint: "c".repeat(64), origin: "UNKNOWN", rootsJson: [] });
    expect((await inspectStoredArtifactInputDependencyIdentities(tx, "ws-a", { kind: "ContextGraphObject", id: "graph-a" })).complete).toBe(false);
  });
  it("does not treat citations or missing native receipts as complete and detects cycles", async () => {
    db.artifactInputLineage.findFirst.mockResolvedValueOnce({ ...manifest, rootsJson: [{ kind: "Document", id: "raw", fingerprint: "e".repeat(64) }] }).mockResolvedValueOnce(null);
    expect((await inspectStoredArtifactInputDependencyIdentities(tx, "ws-a", { kind: "ContextGraphObject", id: "graph-a" })).complete).toBe(false);
    db.artifactInputLineage.findFirst.mockResolvedValue(manifest);
    db.artifactInputSnapshot.findFirst.mockResolvedValue({ ...capturedEpochs, sourceKind: "Document", sourceId: "a", sourceFingerprint: "e".repeat(64), origin: "DERIVED", rootsJson: manifest.rootsJson });
    expect((await inspectStoredArtifactInputDependencyIdentities(tx, "ws-a", { kind: "ContextGraphObject", id: "graph-a" })).complete).toBe(false);
  });
});
