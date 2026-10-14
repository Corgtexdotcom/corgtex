import type { Prisma } from "@prisma/client";
import { expect, it } from "vitest";
import * as lineage from "./source-lineage";
import { assertArtifactInputWriteFence, withArtifactInputWriteFence } from "./artifact-input-write-fence";

it("source-lineage compatibility imports share the exact same fence storage", async () => {
  const tx = {} as Prisma.TransactionClient;
  let checks = 0;
  expect(lineage.withArtifactInputWriteFence).toBe(withArtifactInputWriteFence);
  await withArtifactInputWriteFence(async () => {checks++;}, () => lineage.assertArtifactInputWriteFence(tx));
  await lineage.withArtifactInputWriteFence(async () => {checks++;}, () => assertArtifactInputWriteFence(tx));
  expect(checks).toBe(2);
});
