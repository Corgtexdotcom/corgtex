import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { fixture, alpha, workspaceId, resetFixture, known } from "../../agents/src/agents/model-consumer.test-fixture";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, type LineageRoot } from "./source-lineage";
import { allocateArtifactInputSnapshotId, withArtifactInputSnapshotAllocations } from "./artifact-input-snapshot-allocations";

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async () => ["WORKSPACE"] }));

let roots: LineageRoot[], tx: Prisma.TransactionClient;
beforeEach(async () => {
  await resetFixture();
  fixture.prisma.$executeRaw.mockReset().mockResolvedValue(1);
  fixture.prisma.$queryRaw = vi.fn(async () => []);
  installSourcePermissionEpochFixture(fixture.prisma);
  const action = fixture.add("action", { id: "consumed-action", workspaceId,
    title: "Synthetic source", bodyMd: "Original input", isPrivate: false, authorUserId: null, archivedAt: null });
  await known("Action", action, [], alpha);
  roots = await captureArtifactInputProof(alpha, workspaceId, [{ kind: "Action", id: action.id }], fixture.prisma);
  tx = new Proxy(fixture.prisma, { get(target, property) {
    return property === "$transaction" ? undefined : Reflect.get(target, property);
  } });
});

describe("preallocated immutable input snapshots", () => {
  it("reuses an exact original receipt across nested producer captures without another insert", async () => {
    await withArtifactInputSnapshotAllocations(alpha, workspaceId, tx,
      [{ input: roots[0], id: "prepared-snapshot" }], async () => {
        const first = await captureImmutableArtifactInputProof(alpha, workspaceId, roots, tx);
        const retained = structuredClone(fixture.rows.artifactInputSnapshot);
        expect(first[0].id).toBe("prepared-snapshot");
        expect(await captureImmutableArtifactInputProof(alpha, workspaceId, roots, tx)).toEqual(first);
        expect(fixture.rows.artifactInputSnapshot).toEqual(retained);
        expect(fixture.prisma.artifactInputSnapshot.create).toHaveBeenCalledTimes(1);
      });
  });

  it("rejects a colliding allocated receipt with different original bytes before any insertion", async () => {
    const [saved] = await captureImmutableArtifactInputProof(alpha, workspaceId, roots, tx);
    const receipt = fixture.rows.artifactInputSnapshot.find(row => row.id === saved.id);
    receipt.contentJson.bodyMd = "A different earlier source";
    const before = fixture.prisma.artifactInputSnapshot.create.mock.calls.length;
    await expect(withArtifactInputSnapshotAllocations(alpha, workspaceId, tx,
      [{ input: roots[0], id: saved.id }], () => captureImmutableArtifactInputProof(alpha, workspaceId, roots, tx)))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.prisma.artifactInputSnapshot.create).toHaveBeenCalledTimes(before);
    expect(receipt.contentJson.bodyMd).toBe("A different earlier source");
  });

  it("binds allocation to the actual actor, tenant, transaction and consumed fingerprint", async () => {
    await withArtifactInputSnapshotAllocations(alpha, workspaceId, tx,
      [{ input: roots[0], id: "prepared-snapshot" }], async () => {
        for (const [actor, workspace, connection, input] of [
          [structuredClone(alpha), workspaceId, tx, roots[0]],
          [alpha, "other-workspace", tx, roots[0]],
          [alpha, workspaceId, {} as Prisma.TransactionClient, roots[0]],
          [alpha, workspaceId, tx, { ...roots[0], fingerprint: "0".repeat(64) }],
        ] as const) expect(() => allocateArtifactInputSnapshotId(actor, workspace, connection, input))
          .toThrow(expect.objectContaining({ code: "SOURCE_LOCK_UNCOVERED" }));
        expect(allocateArtifactInputSnapshotId(alpha, workspaceId, tx, roots[0])).toBe("prepared-snapshot");
      });
  });

  it("invalidates detached allocation use after the transaction callback and seals submitted identities", async () => {
    let detached!: () => string | undefined;
    const submitted = [{ input: structuredClone(roots[0]), id: "prepared-snapshot" }];
    await withArtifactInputSnapshotAllocations(alpha, workspaceId, tx, submitted, async () => {
      detached = () => allocateArtifactInputSnapshotId(alpha, workspaceId, tx, roots[0]);
      submitted[0].id = "late-replacement";
      expect(detached()).toBe("prepared-snapshot");
      await new Promise<void>(resolve => {
        setTimeout(() => {
          detached = detached.bind(null);
          resolve();
        }, 0);
      });
    });
    // This closure runs outside AsyncLocalStorage; a detached async task retains
    // the expired scope, checked in the test below.
    expect(allocateArtifactInputSnapshotId(alpha, workspaceId, tx, roots[0])).toBeUndefined();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let after!: Promise<void>;
    await withArtifactInputSnapshotAllocations(alpha, workspaceId, tx, [{ input: roots[0], id: "second-snapshot" }], async () => {
      after = pending.then(() => {
        expect(() => allocateArtifactInputSnapshotId(alpha, workspaceId, tx, roots[0]))
          .toThrow(expect.objectContaining({ code: "SOURCE_LOCK_UNCOVERED" }));
      });
    });
    finish(); await after;
  });
});
