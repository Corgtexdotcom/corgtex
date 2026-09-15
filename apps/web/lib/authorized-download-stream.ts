import { AppError } from "@corgtex/domain";

export const DOWNLOAD_AUTH_BYTES = 4 * 1024 * 1024;
export const DOWNLOAD_AUTH_INTERVAL_MS = 1000;
const CHUNK_BYTES = 64 * 1024;

// No polling while idle and no DB query per network chunk. Authorization gates
// each 4 MiB batch, or the next delivery after one second, including slow reads.
export async function authorizedDownloadStream(
  source: ReadableStream<Uint8Array>,
  authorize: () => Promise<void>,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  try {
    signal.throwIfAborted();
    await authorize();
    signal.throwIfAborted();
  } catch (error) {
    await source.cancel().catch(() => {});
    throw error;
  }
  const reader = source.getReader();
  let stopped = false;
  let checkedAt = performance.now();
  let delivered = 0;
  let pending: Uint8Array | null = null;
  let offset = 0;
  let onAbort: () => void;
  const detach = () => signal.removeEventListener("abort", onAbort);
  const cancel = async () => {
    stopped = true; pending = null; detach();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (stopped) return;
        controller.error(new DOMException("Download aborted.", "AbortError"));
        void cancel();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        if (!pending) {
          const next = await reader.read();
          if (stopped) return;
          if (next.done) {
            stopped = true; detach(); reader.releaseLock(); controller.close(); return;
          }
          pending = next.value; offset = 0;
        }
        if (delivered >= DOWNLOAD_AUTH_BYTES || performance.now() - checkedAt >= DOWNLOAD_AUTH_INTERVAL_MS) {
          await authorize();
          checkedAt = performance.now(); delivered = 0;
        }
        if (stopped) return;
        const length = Math.min(CHUNK_BYTES, pending.byteLength - offset, DOWNLOAD_AUTH_BYTES - delivered);
        const chunk = pending.slice(offset, offset + length);
        offset += length; delivered += length;
        if (offset === pending.byteLength) pending = null;
        controller.enqueue(chunk);
      } catch (error) {
        if (stopped) return;
        await cancel();
        controller.error(error instanceof AppError ? error : new AppError(502, "DOWNLOAD_FAILED", "File download failed."));
      }
    },
    cancel,
  }, { highWaterMark: 0 });
}
