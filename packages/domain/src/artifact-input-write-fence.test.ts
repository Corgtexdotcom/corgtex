import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { assertArtifactInputWriteFence, withAdditionalArtifactInputWriteFence,
  withArtifactInputWriteFence } from "./artifact-input-write-fence";

const tx = {} as Prisma.TransactionClient;
describe("shared additive artifact publication fences", () => {
  it("keeps every enclosing owner in order on the exact supplied transaction", async () => {
    const seen: string[] = [];
    const fence = (id: string) => async (actual: Prisma.TransactionClient) => {expect(actual).toBe(tx); seen.push(id);};
    await withArtifactInputWriteFence(fence("worker"), () => withArtifactInputWriteFence(fence("source"),
      () => withAdditionalArtifactInputWriteFence(fence("effect"), () => assertArtifactInputWriteFence(tx))));
    expect(seen).toEqual(["worker", "source", "effect"]);
  });
  it("an absent optional fence preserves the active parent", async () => {
    let checks = 0;
    await withArtifactInputWriteFence(async () => {checks++;}, () => withArtifactInputWriteFence(undefined,
      () => assertArtifactInputWriteFence(tx)));
    expect(checks).toBe(1);
    await expect(assertArtifactInputWriteFence(tx)).resolves.toBeUndefined();
  });
  it("normalizes source-denial callback failures so writers cannot translate them to0", async () => {
    for (const code of ["SOURCE_CHANGED", "SOURCE_RESTRICTED", "UNKNOWN_LINEAGE"]) {
      await expect(withArtifactInputWriteFence(async () => {throw new AppError(409, code, "Synthetic loss");},
        () => assertArtifactInputWriteFence(tx))).rejects.toMatchObject({code: "ARTIFACT_INPUT_WRITE_FENCE_LOST"});
    }
  });
  it("preserves already distinct durable owner errors", async () => {
    await expect(withArtifactInputWriteFence(async () => {throw new AppError(409, "SQL_INGESTION_FENCE_LOST", "Synthetic loss");},
      () => assertArtifactInputWriteFence(tx))).rejects.toMatchObject({code: "SQL_INGESTION_FENCE_LOST"});
  });
  it("a detached continuation cannot use an expired owner context", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {release = resolve;});
    let detached!: Promise<unknown>;
    let checks = 0;
    await withArtifactInputWriteFence(async () => {checks++;}, async () => {
      detached = ready.then(() => assertArtifactInputWriteFence(tx));
    });
    release();
    await expect(detached).rejects.toMatchObject({code: "ARTIFACT_INPUT_WRITE_FENCE_LOST"});
    expect(checks).toBe(0);
  });
  it("an inner live scope cannot escape its expired enclosing owner", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {release = resolve;});
    let detached!: Promise<unknown>;
    await withArtifactInputWriteFence(async () => undefined, async () => {
      detached = withArtifactInputWriteFence(async () => undefined, async () => {await ready; await assertArtifactInputWriteFence(tx);});
    });
    release();
    await expect(detached).rejects.toMatchObject({code: "ARTIFACT_INPUT_WRITE_FENCE_LOST"});
  });
  it("rechecks scope lifetime after an awaited owner assertion", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {release = resolve;});
    let detached!: Promise<unknown>;
    await withArtifactInputWriteFence(async () => {await ready;}, async () => {detached = assertArtifactInputWriteFence(tx);});
    release();
    await expect(detached).rejects.toMatchObject({code: "ARTIFACT_INPUT_WRITE_FENCE_LOST"});
  });
});
