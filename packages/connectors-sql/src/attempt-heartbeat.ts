const RENEW_EVERY_MS = 60_000;

/** Renew the original attempt only; never replace its captured authority. */
export function startAttemptHeartbeat(renew: () => Promise<unknown>) {
  let pending: Promise<void> | undefined;
  let failed = false;
  let failure: unknown;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || failed || pending) return;
    pending = Promise.resolve().then(renew).then(
      () => undefined,
      (error: unknown) => { failed = true; failure = error; },
    ).finally(() => { pending = undefined; });
  }, RENEW_EVERY_MS);
  timer.unref();

  async function assertHealthy() {
    await pending;
    if (failed) throw failure;
  }

  return {
    assertHealthy,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await assertHealthy();
    },
  };
}
