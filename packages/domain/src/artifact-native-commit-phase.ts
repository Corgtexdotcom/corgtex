import { AsyncLocalStorage } from "node:async_hooks";
import { invariant } from "./errors";

// This context grants nothing. It only prevents a native reader from opening a
// provider connection during (or after) a database publication callback.
const phase = new AsyncLocalStorage<{ active: boolean }>();

export function assertOutsideArtifactNativeCommitPhase() {
  invariant(!phase.getStore(), 409, "SOURCE_CHANGED",
    "Provider reads cannot run during an artifact commit.");
}

export function isArtifactNativeCommitPhase() { return !!phase.getStore(); }

export async function withArtifactNativeCommitPhase<T>(work: () => Promise<T>): Promise<T> {
  const state = { active: true };
  return phase.run(state, async () => {
    try { return await work(); }
    finally { state.active = false; }
  });
}
