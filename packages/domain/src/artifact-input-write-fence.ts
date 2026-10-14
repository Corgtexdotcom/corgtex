import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { AppError, invariant } from "./errors";

export type ArtifactInputWriteFence = (tx: Prisma.TransactionClient) => Promise<void>;
type FenceScope = { fence: ArtifactInputWriteFence; prior?: FenceScope; active: boolean };
// All source-lineage and connector entry points import this ONE storage instance.
const writeFence = new AsyncLocalStorage<FenceScope>();

function activeChain(scope: FenceScope | undefined) {
  const chain: FenceScope[] = [];
  while (scope) {
    invariant(scope.active && chain.length < 64, 409, "ARTIFACT_INPUT_WRITE_FENCE_LOST",
      "The artifact publication owner scope is unavailable.");
    chain.push(scope); scope = scope.prior;
  }
  return chain;
}

/** Trusted server callbacks compose with every enclosing owner fence. A missing
 * optional fence never removes a prior owner. No receipt or actor is minted. */
export async function withArtifactInputWriteFence<T>(fence: ArtifactInputWriteFence | undefined, work: () => Promise<T>): Promise<T> {
  const prior = writeFence.getStore();
  activeChain(prior);
  if (!fence) return work();
  const scope: FenceScope = {fence, prior, active: true};
  try { return await writeFence.run(scope, work); }
  finally { scope.active = false; }
}

/** Compatibility alias for callers that explicitly request additive ownership. */
export const withAdditionalArtifactInputWriteFence = withArtifactInputWriteFence;

export async function assertArtifactInputWriteFence(tx: Prisma.TransactionClient) {
  const scope = writeFence.getStore();
  const chain = activeChain(scope);
  for (const entry of chain.reverse()) {
    try { await entry.fence(tx); }
    catch (error) {
      // These source-denial codes are translated to numeric0 by legacy writers.
      // Loss of a supplied publication fence must escape those success paths.
      if (error && typeof error === "object" && "code" in error
        && ["SOURCE_CHANGED", "SOURCE_RESTRICTED", "UNKNOWN_LINEAGE"].includes(String(error.code))) {
        throw new AppError(409, "ARTIFACT_INPUT_WRITE_FENCE_LOST", "The artifact publication owner fence was lost.");
      }
      throw error;
    }
    activeChain(scope);
  }
}
