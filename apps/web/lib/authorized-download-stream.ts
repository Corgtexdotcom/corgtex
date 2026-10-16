import { createHash } from "node:crypto";
import { AppError } from "@corgtex/domain";

export const DOWNLOAD_AUTH_BYTES = 4 * 1024 * 1024;
export const DOWNLOAD_AUTH_INTERVAL_MS = 1000;
const CHUNK_BYTES = 64 * 1024;
export const MAX_BOUND_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export type DownloadByteBinding = { sha256: string; sizeBytes: number };

/** Verify a bounded private snapshot before a response or any download bytes exist. */
async function verifiedDownloadSnapshot(source: ReadableStream<Uint8Array>, authorize: () => Promise<void>, signal: AbortSignal,
  binding: DownloadByteBinding): Promise<ReadableStream<Uint8Array>> {
  if (!/^[a-f0-9]{64}$/i.test(binding.sha256) || !Number.isSafeInteger(binding.sizeBytes) || binding.sizeBytes < 0) {
    await source.cancel().catch(() => {});
    throw new AppError(404, "SOURCE_FILE_UNPROVEN", "The file has no verified byte identity.");
  }
  if (binding.sizeBytes > MAX_BOUND_DOWNLOAD_BYTES) {
    await source.cancel().catch(() => {});
    throw new AppError(413, "DOWNLOAD_TOO_LARGE", "The file exceeds the download byte limit.");
  }
  const reader = source.getReader();
  let bytes: Uint8Array | null = new Uint8Array(binding.sizeBytes);
  let size = 0;
  let aborted = false;
  const onAbort = () => { aborted = true; void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    await authorize();
    signal.throwIfAborted();
    const hash = createHash("sha256");
    let emptyReads = 0;
    for (;;) {
      await authorize();
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      await authorize();
      signal.throwIfAborted();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > binding.sizeBytes - size) {
        throw new AppError(404, "SOURCE_FILE_CHANGED", "The stored file version is unavailable.");
      }
      if (next.value.byteLength === 0) {
        if (++emptyReads > 128) throw new AppError(502, "DOWNLOAD_FAILED", "File download failed.");
      } else emptyReads = 0;
      bytes.set(next.value, size);
      hash.update(next.value);
      size += next.value.byteLength;
      if (size === binding.sizeBytes && hash.copy().digest("hex") !== binding.sha256.toLowerCase()) {
        throw new AppError(404, "SOURCE_FILE_CHANGED", "The stored file version is unavailable.");
      }
    }
    if (size !== binding.sizeBytes || hash.digest("hex") !== binding.sha256.toLowerCase()) {
      throw new AppError(404, "SOURCE_FILE_CHANGED", "The stored file version is unavailable.");
    }
    await authorize();
    signal.throwIfAborted();
  } catch (error) {
    bytes?.fill(0); bytes = null;
    await reader.cancel().catch(() => {});
    if (error instanceof AppError || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new AppError(502, "DOWNLOAD_FAILED", "File download failed.");
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let offset = 0;
  const discard = () => { bytes?.fill(0); bytes = null; };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!bytes || offset === bytes.byteLength) { discard(); controller.close(); return; }
      const end = Math.min(bytes.byteLength, offset + CHUNK_BYTES);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    cancel: discard,
  }, { highWaterMark: 0 });
}

// No polling while idle and no DB query per network chunk. Authorization gates
// each 4 MiB batch, or the next delivery after one second, including slow reads.
export async function authorizedDownloadStream(
  source: ReadableStream<Uint8Array>,
  authorize: () => Promise<void>,
  signal: AbortSignal,
  options?: { authorizeEveryDelivery?: boolean; byteBinding?: DownloadByteBinding },
): Promise<ReadableStream<Uint8Array>> {
  try {
    signal.throwIfAborted();
    await authorize();
    signal.throwIfAborted();
  } catch (error) {
    await source.cancel().catch(() => {});
    throw error;
  }
  if (options?.byteBinding) source = await verifiedDownloadSnapshot(source, authorize, signal, options.byteBinding);
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
        if (!options?.authorizeEveryDelivery && (delivered >= DOWNLOAD_AUTH_BYTES || performance.now() - checkedAt >= DOWNLOAD_AUTH_INTERVAL_MS)) {
          await authorize();
          checkedAt = performance.now(); delivered = 0;
        }
        if (stopped) return;
        const length = Math.min(CHUNK_BYTES, pending.byteLength - offset, DOWNLOAD_AUTH_BYTES - delivered);
        const chunk = pending.slice(offset, offset + length);
        if (options?.authorizeEveryDelivery) {
          signal.throwIfAborted();
          await authorize();
          signal.throwIfAborted();
          if (stopped) return;
          checkedAt = performance.now(); delivered = 0;
        }
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
