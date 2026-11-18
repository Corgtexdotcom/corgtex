import { setTimeout as delay } from "node:timers/promises";
import { createManagedAzureContainerAppTransport, ManagedAzureContainerAppError } from "./managed-azure-container-app-transport.mjs";

// Repay actual ARM read pressure before the next method, never after a fresh
// readback or inside the transport's request/census deadlines. Native methods
// retain their complete inventory, retry and mutation semantics. This bounds
// amortized request pressure; it does not claim a provider quota or remove the
// bounded bursts inside a native method (for example mode restoration).
export function createManagedAzurePacedContainerAppTransport({ fetchImpl = fetch, clock = Date.now,
  sleep = (ms, signal) => delay(ms, undefined, { signal }), onProgress,
  abortError = () => new ManagedAzureContainerAppError("AZURE_ARM_PACING_ABORTED", true), ...transport } = {}) {
  let nextMethodAt = 0, serial = Promise.resolve();
  const countedFetch = (url, init) => {
    if (init?.method === "GET" && new URL(url).origin === "https://management.azure.com") {
      nextMethodAt = Math.max(nextMethodAt, clock()) + 1_250;
    }
    return fetchImpl(url, init);
  };
  const apps = createManagedAzureContainerAppTransport({ ...transport, fetchImpl: countedFetch, clock, sleep });
  return Object.freeze(Object.fromEntries(Object.entries(apps).map(([name, method]) => [name, async (input) => {
    const previous = serial;
    let release;
    serial = new Promise(resolve => { release = resolve; });
    const progress = async () => {
      if (input?.signal?.aborted) throw abortError();
      await onProgress?.();
      if (input?.signal?.aborted) throw abortError();
    };
    try {
      await previous;
      await progress();
      while (nextMethodAt > clock()) {
        await sleep(Math.min(15_000, nextMethodAt - clock()), input?.signal);
        await progress();
      }
      // Owner verification may take time; delegate only after its successful
      // completion. Preserve debt even if the native method subsequently fails.
      return await method(input);
    } finally { release(); }
  }])));
}

