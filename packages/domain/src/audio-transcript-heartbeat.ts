/** Keep one audio attempt live during storage and provider waits. Failed renewals
 * abort outbound work and remain fatal even if an adapter ignores cancellation. */
export function startAudioTranscriptHeartbeat(renewLease: () => Promise<void>) {
  const controller = new AbortController();
  let failure: unknown;
  let failed = false;
  let stopped = false;
  let pending: Promise<void> | undefined;
  const assertActive = () => {
    if (failed) throw failure;
  };
  const authorizeAttempt = async () => {
    assertActive();
    if (stopped) throw new Error("Audio transcription attempt has ended.");
    if (!pending) {
      pending = Promise.resolve().then(renewLease).catch(error => {
        failed = true;
        failure = error;
        controller.abort(error);
        throw error;
      }).finally(() => { pending = undefined; });
    }
    await pending;
    assertActive();
  };
  const timer = setInterval(() => { void authorizeAttempt().catch(() => undefined); }, 60_000);
  timer.unref?.();
  return {
    signal: controller.signal,
    assertActive,
    authorizeAttempt,
    async stop() {
      stopped = true;
      clearInterval(timer);
      // No lease writes may outlive completion or actor revocation.
      await pending;
      assertActive();
    },
  };
}
