import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";

const lineage = vi.hoisted(() => ({
  advanceHumanArtifactInputLineage: vi.fn(),
  captureArtifactInputProof: vi.fn(),
  captureArtifactInputSnapshotProof: vi.fn(),
  currentArtifactInputRoots: vi.fn(),
  invalidateArtifactInputLineage: vi.fn(),
  isArtifactInputProofReadable: vi.fn(),
  recordArtifactInputLineage: vi.fn(),
  lineageContentFingerprint: vi.fn().mockReturnValue("c".repeat(64)),
}));
vi.mock("./source-lineage", () => lineage);
const plan = vi.hoisted(() => ({activeTx: null as unknown, outputs: new Set<string>(), compatible: vi.fn(), covered: vi.fn()}));
vi.mock("./source-commit-lock-plan", async importOriginal => ({
  ...await importOriginal<typeof import("./source-commit-lock-plan")>(),
  assertSourceCommitTransactionCompatible: plan.compatible,
  hasActiveSourceCommitLockPlan: (tx: unknown) => plan.activeTx !== null && plan.activeTx === tx,
  assertSourceCommitOutputHeadReserved: plan.covered,
}));
import { prepareProducerLineage, finishProducerLineage } from "./producer-lineage";

let tx: Prisma.TransactionClient;
const user = { kind: "user", user: { id: "user-1" } } as AppActor;
const agent = { kind: "agent", authProvider: "credential", workspaceIds: ["workspace-1"] } as AppActor;
const root = { kind: "BrainSource" as const, id: "source-1", fingerprint: "a".repeat(64) };
const snapshot = { kind: "ArtifactInputSnapshot" as const, id: "snapshot-1", fingerprint: "b".repeat(64) };
const artifact = { kind: "Action" as const, id: "action-1" };
const base = { get tx() {return tx;}, workspaceId: "workspace-1" };

function persist(actor: AppActor, receipt: Awaited<ReturnType<typeof prepareProducerLineage>>) {
  return finishProducerLineage({ ...base, actor, artifact, content: { id: artifact.id, title: "Synthetic content" }, receipt });
}

describe("producer lineage receipts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    tx = { $executeRaw: vi.fn(async () => 1) } as unknown as Prisma.TransactionClient;
    plan.activeTx = null; plan.outputs.clear();
    plan.compatible.mockImplementation((supplied: unknown) => {
      if (plan.activeTx !== null && supplied !== plan.activeTx) throw Object.assign(new Error("foreign transaction"), {code: "SOURCE_LOCK_UNCOVERED"});
    });
    plan.covered.mockImplementation((supplied: unknown, workspaceId: string, output: {kind: string; id: string}) => {
      if (supplied !== plan.activeTx || workspaceId !== base.workspaceId || !plan.outputs.has(JSON.stringify([output.kind, output.id]))) {
        throw Object.assign(new Error("unreserved output"), {code: "SOURCE_LOCK_UNCOVERED"});
      }
    });
    lineage.lineageContentFingerprint.mockReturnValue("c".repeat(64));
    lineage.currentArtifactInputRoots.mockResolvedValue([root]);
    lineage.captureArtifactInputProof.mockResolvedValue([root]);
    lineage.captureArtifactInputSnapshotProof.mockResolvedValue([snapshot, root]);
    lineage.isArtifactInputProofReadable.mockResolvedValue(true);
  });

  it("records a direct human creation in its producer transaction", async () => {
    await persist(user, await prepareProducerLineage({ ...base, actor: user }));
    expect(lineage.recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({
      tx, origin: "HUMAN_ORIGINAL", inputs: [], inheritedRoots: [],
    }));
  });

  it("leaves model/copy creation unknown when its complete pre-generation roots are missing", async () => {
    await persist(agent, await prepareProducerLineage({ ...base, actor: agent,
      capture: { lineageInputs: [{ kind: "BrainSource", id: "source-1" }] } }));
    await persist(user, await prepareProducerLineage({ ...base, actor: user, copied: true }));
    expect(lineage.invalidateArtifactInputLineage).toHaveBeenCalledTimes(2);
    expect(lineage.recordArtifactInputLineage).not.toHaveBeenCalled();
  });

  it("retains the existing proof on a human partial edit and leaves unknown legacy content unknown", async () => {
    const before = { id: artifact.id, title: "Earlier synthetic body" };
    await persist(user, await prepareProducerLineage({ ...base, actor: user, artifact, before }));
    expect(lineage.advanceHumanArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ before }));
    expect(lineage.recordArtifactInputLineage).not.toHaveBeenCalled();
  });

  it("captures the immutable prior body before adding explicit model input to a partial edit", async () => {
    const before = { id: artifact.id, title: "Earlier synthetic body" };
    const receipt = await prepareProducerLineage({ ...base, actor: agent, artifact, before,
      capture: { lineageRoots: [root], lineageInputs: [{ kind: "BrainSource", id: "source-1" }] } });
    expect(lineage.captureArtifactInputSnapshotProof).toHaveBeenCalledWith(agent, base.workspaceId, { ...artifact, fingerprint: "c".repeat(64) }, tx);
    await persist(agent, receipt);
    expect(lineage.recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({
      origin: "DERIVED", inheritedRoots: expect.arrayContaining([root, snapshot]),
    }));
  });

  it("does not certify an unknown previous body merely because the new inputs are complete", async () => {
    lineage.currentArtifactInputRoots.mockResolvedValue(null);
    await persist(user, await prepareProducerLineage({ ...base, actor: user, artifact, before: { id: artifact.id },
      capture: { lineageRoots: [root] } }));
    expect(lineage.invalidateArtifactInputLineage).toHaveBeenCalled();
    expect(lineage.recordArtifactInputLineage).not.toHaveBeenCalled();
  });

  it("rejects revoked or changed supplied receipts before content mutation", async () => {
    lineage.isArtifactInputProofReadable.mockResolvedValue(false);
    await expect(prepareProducerLineage({ ...base, actor: agent, capture: { lineageRoots: [root] } }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(lineage.recordArtifactInputLineage).not.toHaveBeenCalled();
  });

  it("snapshots all declared mutable inputs for a deterministic version copier", async () => {
    const role = { kind: "Role" as const, id: "role-1" };
    lineage.captureArtifactInputProof.mockResolvedValue([{ ...role, fingerprint: "d".repeat(64) }]);
    await persist(agent, await prepareProducerLineage({ ...base, actor: agent, copied: true,
      completeCopy: true, dependencies: [role], snapshotDependencies: [role] }));
    expect(lineage.recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({
      origin: "DERIVED", inputs: [], inheritedRoots: expect.arrayContaining([snapshot, root]),
    }));
  });

  it("keeps inferred legacy parent copies unknown but rejects invalid explicit proof", async () => {
    lineage.captureArtifactInputProof.mockRejectedValue({ code: "UNKNOWN_LINEAGE" });
    await persist(user, await prepareProducerLineage({ ...base, actor: user,
      dependencies: [{ kind: "Goal", id: "legacy-goal" }] }));
    expect(lineage.invalidateArtifactInputLineage).toHaveBeenCalled();
    await expect(prepareProducerLineage({ ...base, actor: user,
      capture: { lineageInputs: [{ kind: "Goal", id: "legacy-goal" }], lineageRoots: [root] } }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("adds no late standalone head lock before UNKNOWN or ADVANCE returns", async () => {
    const before = {id: artifact.id, title: "Original"};
    expect((await prepareProducerLineage({...base, actor: user, artifact, before})).mode).toBe("ADVANCE");
    expect((await prepareProducerLineage({...base, actor: user, artifact, before, copied: true})).mode).toBe("UNKNOWN");
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(plan.covered).not.toHaveBeenCalled();
  });

  it("asserts active-plan output coverage before UNKNOWN and ADVANCE early returns without SQL", async () => {
    plan.activeTx = tx; plan.outputs.add(JSON.stringify([artifact.kind, artifact.id]));
    const before = {id: artifact.id, title: "Original"};
    expect((await prepareProducerLineage({...base, actor: user, artifact, before})).mode).toBe("ADVANCE");
    expect((await prepareProducerLineage({...base, actor: user, artifact, before, copied: true})).mode).toBe("UNKNOWN");
    expect(plan.covered).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(lineage.advanceHumanArtifactInputLineage).not.toHaveBeenCalled();
  });

  it("rejects unreserved active-plan outputs before lineage checks or early returns", async () => {
    plan.activeTx = tx;
    for (const actor of [user, agent]) await expect(prepareProducerLineage({...base, actor, artifact,
      before: {id: artifact.id}})).rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(lineage.isArtifactInputProofReadable).not.toHaveBeenCalled();
    expect(lineage.currentArtifactInputRoots).not.toHaveBeenCalled();
  });

  it("rejects a foreign client even when creation has no supplied artifact", async () => {
    plan.activeTx = tx;
    const foreign = {$executeRaw: vi.fn(async () => 1)} as unknown as Prisma.TransactionClient;
    await expect(prepareProducerLineage({...base, tx: foreign, actor: user})).rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
    expect(foreign.$executeRaw).not.toHaveBeenCalled();
    expect(lineage.recordArtifactInputLineage).not.toHaveBeenCalled();
  });

  it("does not launder copied content through a direct human partial edit", async () => {
    await persist(user, await prepareProducerLineage({ ...base, actor: user, artifact,
      before: { id: artifact.id, title: "Original human content" }, copied: true }));
    expect(lineage.invalidateArtifactInputLineage).toHaveBeenCalled();
    expect(lineage.advanceHumanArtifactInputLineage).not.toHaveBeenCalled();
  });

  it("compares captured driver rows and removes content snapshots from stored input ids", async () => {
    const driver = { kind: "KeyResult" as const, id: "key-result-1", snapshot: { title: "Synthetic result", progressPercent: 50 } };
    lineage.captureArtifactInputProof.mockResolvedValue([{ kind: driver.kind, id: driver.id, fingerprint: "d".repeat(64) }]);
    await persist(agent, await prepareProducerLineage({ ...base, actor: agent, completeCopy: true, dependencies: [driver] }));
    expect(lineage.captureArtifactInputProof).toHaveBeenCalledWith(agent, base.workspaceId, [driver], tx);
    expect(lineage.recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ inputs: [{ kind: driver.kind, id: driver.id }] }));
  });

  it("keeps deterministic recalculation unknown after an old input was removed", async () => {
    lineage.captureArtifactInputSnapshotProof.mockRejectedValue({ code: "UNKNOWN_LINEAGE" });
    await persist(user, await prepareProducerLineage({ ...base, actor: user, artifact, before: { id: artifact.id },
      completeCopy: true, dependencies: [{ kind: "KeyResult", id: "remaining-result" }] }));
    expect(lineage.invalidateArtifactInputLineage).toHaveBeenCalled();
    expect(lineage.recordArtifactInputLineage).not.toHaveBeenCalled();
  });

});
