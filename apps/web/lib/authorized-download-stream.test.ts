import { createHash } from "node:crypto";
import { markAsUntransferable } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupportAuthorizationContext, runWithSupportOrigin } from "../../../packages/shared/src/support-context";

vi.mock("@corgtex/domain", () => ({ AppError: class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
import { AppError } from "@corgtex/domain";
import { authorizedOwnedDownloadStream, authorizedDownloadStream, DOWNLOAD_AUTH_BYTES, DOWNLOAD_AUTH_INTERVAL_MS, MAX_BOUND_DOWNLOAD_BYTES } from "./authorized-download-stream";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const signal = () => new AbortController().signal;
const denied = () => new AppError(403, "SUPPORT_AUTHORIZATION_REVOKED", "Revoked.");

describe("authorized download stream", () => {
  it("preserves backpressure and cancels the upstream on consumer cancellation", async () => {
    let pulls = 0;
    const cancel = vi.fn(), authorize = vi.fn().mockResolvedValue(undefined);
    const source = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(64 * 1024)); }, cancel }, { highWaterMark: 0 });
    const body = await authorizedDownloadStream(source, authorize, signal());
    await Promise.resolve(); expect(pulls).toBe(0);
    const reader = body.getReader(); await reader.read();
    await Promise.resolve(); expect(pulls).toBe(1);
    await reader.cancel(); expect(cancel).toHaveBeenCalledOnce(); expect(authorize).toHaveBeenCalledOnce();
  });

  it("cancels the untouched body if authorization fails before response creation", async () => {
    const cancel = vi.fn(), pull = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    await expect(authorizedDownloadStream(source, async () => { throw denied(); }, signal())).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    expect(cancel).toHaveBeenCalledOnce(); expect(pull).not.toHaveBeenCalled();
  });

  it("rejects revoke/regrant at the byte boundary using the captured epoch outside the original ALS scope", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const origin = { userId: "support", workspaceId: "workspace", version: 1 };
    let currentVersion = 1;
    const cancel = vi.fn(), check = vi.fn(async () => {
      if (getSupportAuthorizationContext()?.origin?.version !== currentVersion) throw denied();
    });
    const source = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(8 * 1024 * 1024)); }, cancel }, { highWaterMark: 0 });
    const body = await runWithSupportOrigin(origin, () => authorizedDownloadStream(source, () => runWithSupportOrigin(origin, check), signal()));
    const reader = body.getReader(); let bytes = 0;
    while (bytes < DOWNLOAD_AUTH_BYTES) { const next = await reader.read(); expect(next.value!.byteLength).toBeLessThanOrEqual(64 * 1024); bytes += next.value!.byteLength; }
    expect(check).toHaveBeenCalledOnce(); currentVersion = 3;
    await expect(reader.read()).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    expect(check).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce();
  });

  it("rechecks after a slow pending provider read before delivering its bytes", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(), authorize = vi.fn().mockResolvedValue(undefined);
    const source = new ReadableStream<Uint8Array>({ start(c) { upstream = c; }, cancel }, { highWaterMark: 0 });
    const reader = (await authorizedDownloadStream(source, authorize, signal())).getReader();
    const next = reader.read(); now = DOWNLOAD_AUTH_INTERVAL_MS;
    authorize.mockRejectedValueOnce(denied()); upstream.enqueue(new Uint8Array([1]));
    await expect(next).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    expect(cancel).toHaveBeenCalledOnce(); expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("does no idle polling but rechecks before resuming an idle consumer", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const authorize = vi.fn().mockResolvedValue(undefined);
    const source = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array([1])); } }, { highWaterMark: 0 });
    const reader = (await authorizedDownloadStream(source, authorize, signal())).getReader();
    await reader.read(); now = 10000;
    expect(authorize).toHaveBeenCalledOnce();
    await reader.read(); expect(authorize).toHaveBeenCalledTimes(2); await reader.cancel();
  });

  it("immediately cancels a pending upstream read on request abort", async () => {
    const cancel = vi.fn(), controller = new AbortController();
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const reader = (await authorizedDownloadStream(source, async () => {}, controller.signal)).getReader();
    const next = reader.read(); controller.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" }); expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not deliver bytes when cancellation occurs during an authorization query", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let release!: () => void;
    const authorize = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
    const cancel = vi.fn(), abort = new AbortController();
    const source = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array([1])); }, cancel }, { highWaterMark: 0 });
    const reader = (await authorizedDownloadStream(source, authorize, abort.signal)).getReader();
    now = 1001;
    const next = reader.read();
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    abort.abort(); release();
    await expect(next).rejects.toMatchObject({ name: "AbortError" }); expect(cancel).toHaveBeenCalledOnce();
  });

  it("sanitizes provider read errors instead of exposing storage URLs", async () => {
    const source = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("https://storage.invalid/?secret=private")); } }, { highWaterMark: 0 });
    const reader = (await authorizedDownloadStream(source, async () => {}, signal())).getReader();
    await expect(reader.read()).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", message: "File download failed." });
  });

  it("naturally closes and detaches without cancelling a completed body", async () => {
    const cancel = vi.fn(), abort = new AbortController();
    const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); }, cancel });
    const reader = (await authorizedDownloadStream(source, async () => {}, abort.signal)).getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    expect((await reader.read()).done).toBe(true); abort.abort(); expect(cancel).not.toHaveBeenCalled();
  });
});


const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const strictOptions = (bytes: Uint8Array) => ({ authorizeEveryDelivery: true, byteBinding: { sha256: digest(bytes), sizeBytes: bytes.byteLength } });
describe("strict verified file delivery", () => {
  it("returns no stream until complete bytes, size/hash and current proof are verified", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let provider!: ReadableStreamDefaultController<Uint8Array>;
    let pulls = 0;
    const authorize = vi.fn().mockResolvedValue(undefined);
    const source = new ReadableStream<Uint8Array>({ start(controller) { provider = controller; }, pull() { pulls++; } }, { highWaterMark: 0 });
    let resolved = false;
    const pending = authorizedDownloadStream(source, authorize, signal(), strictOptions(bytes)).then(value => { resolved = true; return value; });
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    provider.enqueue(bytes.slice(0, 2));
    await vi.waitFor(() => expect(pulls).toBe(2));
    expect(resolved).toBe(false);
    provider.enqueue(bytes.slice(2)); provider.close();
    const body = await pending;
    expect(resolved).toBe(true);
    expect((await body.getReader().read()).value).toEqual(bytes);
  });

  it("rejects an exact-length changed file and cancels provider before any return value", async () => {
    const expected = new Uint8Array([1, 2]); const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array([3, 4])); }, cancel }, { highWaterMark: 0 });
    await expect(authorizedDownloadStream(source, async () => {}, signal(), strictOptions(expected))).rejects.toMatchObject({ code: "SOURCE_FILE_CHANGED" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects extra bytes even when the initial matching prefix has the right raw hash", async () => {
    const expected = new Uint8Array([1, 2]); const cancel = vi.fn(); let pulls = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(pulls++ === 0 ? expected : new Uint8Array([3])); }, cancel }, { highWaterMark: 0 });
    await expect(authorizedDownloadStream(source, async () => {}, signal(), strictOptions(expected))).rejects.toMatchObject({ code: "SOURCE_FILE_CHANGED" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels untouched source for missing identity or size beyond the fixed 100 MiB bound", async () => {
    for (const byteBinding of [{ sha256: "unproved", sizeBytes: 1 }, { sha256: "a".repeat(64), sizeBytes: MAX_BOUND_DOWNLOAD_BYTES + 1 }]) {
      const cancel = vi.fn(), pull = vi.fn();
      const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
      await expect(authorizedDownloadStream(source, async () => {}, signal(), { authorizeEveryDelivery: true, byteBinding })).rejects.toBeInstanceOf(AppError);
      expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
    }
    expect(MAX_BOUND_DOWNLOAD_BYTES).toBe(100 * 1024 * 1024);
  });

  it("cancels a pending verification read immediately on request abort", async () => {
    const cancel = vi.fn(), abort = new AbortController(), authorize = vi.fn().mockResolvedValue(undefined);
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const pending = authorizedDownloadStream(source, authorize, abort.signal, strictOptions(new Uint8Array([1])));
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2)); abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" }); expect(cancel).toHaveBeenCalledOnce();
  });

  it("withholds verified bytes if the post-read source proof changes before response creation", async () => {
    const bytes = new Uint8Array([1]); let revoked = false; const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(bytes); revoked = true; }, cancel }, { highWaterMark: 0 });
    await expect(authorizedDownloadStream(source, async () => { if (revoked) throw denied(); }, signal(), strictOptions(bytes))).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rechecks a paused consumer immediately before each bounded verified delivery", async () => {
    const bytes = new Uint8Array(2 * DOWNLOAD_AUTH_BYTES); let revoked = false;
    const authorize = vi.fn(async () => { if (revoked) throw denied(); });
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const reader = (await authorizedDownloadStream(source, authorize, signal(), strictOptions(bytes))).getReader();
    const before = authorize.mock.calls.length;
    expect((await reader.read()).value!.byteLength).toBe(DOWNLOAD_AUTH_BYTES);
    expect(authorize.mock.calls.length - before).toBe(1);
    revoked = true;
    await expect(reader.read()).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
  });

  it("does not enqueue a copied chunk if its delivery permission check is revoked", async () => {
    const bytes = new Uint8Array([1, 2]); const authorize = vi.fn().mockResolvedValue(undefined);
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const reader = (await authorizedDownloadStream(source, authorize, signal(), strictOptions(bytes))).getReader();
    authorize.mockRejectedValueOnce(denied());
    await expect(reader.read()).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
  });

  it("sanitizes provider errors encountered while pre-verifying raw bytes", async () => {
    const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("https://storage.invalid/?credential=private")); } }, { highWaterMark: 0 });
    await expect(authorizedDownloadStream(source, async () => {}, signal(), strictOptions(new Uint8Array([1])))).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", message: "File download failed." });
  });
});


it("bounds ALL proof calls for a verified 100 MiB file arriving in 64 KiB provider chunks", async () => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  const bytes = new Uint8Array(MAX_BOUND_DOWNLOAD_BYTES).fill(7);
  let offset = 0;
  const source = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.byteLength) { controller.close(); return; }
    const end = Math.min(bytes.byteLength, offset + 64 * 1024);
    controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } }, { highWaterMark: 0 });
  const authorize = vi.fn().mockResolvedValue(undefined);
  const reader = (await authorizedDownloadStream(source, authorize, signal(), strictOptions(bytes))).getReader();
  expect(authorize).toHaveBeenCalledTimes(28);
  let delivered = 0, deliveries = 0;
  for (;;) {
    const before = authorize.mock.calls.length;
    const next = await reader.read();
    if (next.done) break;
    expect(next.value.byteLength).toBe(DOWNLOAD_AUTH_BYTES);
    expect(authorize.mock.calls.length - before).toBe(1);
    expect(next.value[0]).toBe(7); expect(next.value.at(-1)).toBe(7);
    delivered += next.value.byteLength; deliveries++;
  }
  expect(delivered).toBe(MAX_BOUND_DOWNLOAD_BYTES);
  expect(deliveries).toBe(25);
  expect(authorize).toHaveBeenCalledTimes(53);
});

it("withholds a verification buffer when a slow read crosses the time authorization boundary", async () => {
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const bytes = new Uint8Array(2 * DOWNLOAD_AUTH_BYTES);
  let provider!: ReadableStreamDefaultController<Uint8Array>;
  let revoked = false;
  const authorize = vi.fn(async () => { if (revoked) throw denied(); });
  const cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>({ start(controller) { provider = controller; }, cancel }, { highWaterMark: 0 });
  const pending = authorizedDownloadStream(source, authorize, signal(), strictOptions(bytes));
  await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
  now = DOWNLOAD_AUTH_INTERVAL_MS; revoked = true;
  provider.enqueue(bytes.subarray(0, 64 * 1024));
  await expect(pending).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
  expect(cancel).toHaveBeenCalledOnce();
});


describe("owned storage snapshot delivery", () => {
  it.each([50, 64])("transfers a %i MiB asset without full-file allocations and copies only bounded deliveries", async (mib) => {
    const sizeBytes = mib * 1024 * 1024;
    const source = Buffer.concat([Buffer.alloc(sizeBytes, 73)]); // same owned-buffer assembly as storage.get()
    const binding = strictOptions(source).byteBinding;
    const alias = new Uint8Array(source.buffer);
    const allocations: number[] = [];
    const deliveries: number[] = [];
    const originalSlice = Uint8Array.prototype.slice;
    vi.spyOn(Uint8Array.prototype, "slice").mockImplementation(function (this: Uint8Array, start, end) {
      const result = originalSlice.call(this, start, end);
      deliveries.push(result.byteLength);
      return result;
    });
    vi.stubGlobal("Uint8Array", new Proxy(Uint8Array, {
      construct(target, args) {
        const result = Reflect.construct(target, args) as Uint8Array;
        if (typeof args[0] === "number" || ArrayBuffer.isView(args[0])) allocations.push(result.byteLength);
        return result;
      },
    }));
    const authorize = vi.fn(async () => {
      // Even the first callback cannot alter the consumed backing store.
      expect(alias.byteLength).toBe(0);
      alias[0] = 0;
    });
    const pending = authorizedOwnedDownloadStream(source, authorize, signal(), binding);
    expect(source.byteLength).toBe(0);
    expect(alias.byteLength).toBe(0);
    const reader = (await pending).getReader();
    const receivedHash = createHash("sha256");
    let received = 0;
    for (;;) {
      const before = authorize.mock.calls.length;
      const next = await reader.read();
      if (next.done) break;
      expect(authorize.mock.calls.length).toBe(before + 1);
      expect(next.value.byteLength).toBeLessThanOrEqual(DOWNLOAD_AUTH_BYTES);
      expect(next.value.buffer.byteLength).toBe(next.value.byteLength);
      receivedHash.update(next.value);
      received += next.value.byteLength;
      // A consumer's entire chunk backing store cannot reach future bytes.
      new Uint8Array(next.value.buffer).fill(0);
    }
    expect(received).toBe(sizeBytes);
    expect(receivedHash.digest("hex")).toBe(binding.sha256);
    expect(allocations).toEqual([]);
    expect(deliveries.reduce((sum, length) => sum + length, 0)).toBe(sizeBytes);
    expect(Math.max(...deliveries)).toBe(DOWNLOAD_AUTH_BYTES);
    expect(authorize).toHaveBeenCalledTimes(Math.ceil(mib / 4) + 1);
  });

  it.each(["pooled", "untransferable", "shared"])("takes exactly one defensive copy for %s bytes before callbacks can mutate aliases", async (kind) => {
    const source = kind === "pooled" ? Buffer.from([1, 2, 3, 4])
      : kind === "shared" ? new Uint8Array(new SharedArrayBuffer(4)).fill(7) : new Uint8Array(4).fill(9);
    if (kind === "untransferable") markAsUntransferable(source.buffer);
    const expected = [...source];
    const binding = strictOptions(source).byteBinding;
    const allocations: number[] = [];
    vi.stubGlobal("Uint8Array", new Proxy(Uint8Array, {
      construct(target, args) {
        const result = Reflect.construct(target, args) as Uint8Array;
        if (typeof args[0] === "number" || ArrayBuffer.isView(args[0])) allocations.push(result.byteLength);
        return result;
      },
    }));
    const authorize = vi.fn(async () => { source.fill(0); });
    const reader = (await authorizedOwnedDownloadStream(source, authorize, signal(), binding)).getReader();
    expect([...(await reader.read()).value!]).toEqual(expected);
    expect(allocations).toEqual([4]);
    expect(authorize).toHaveBeenCalledTimes(2);
    await reader.cancel();
  });

  it("keeps a retained provider alias isolated in the unchanged strict untrusted stream path", async () => {
    const sourceBytes = new Uint8Array(DOWNLOAD_AUTH_BYTES + 1).fill(19);
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(sourceBytes); controller.close(); } });
    const authorize = vi.fn().mockResolvedValue(undefined);
    const reader = (await authorizedDownloadStream(source, authorize, signal(), strictOptions(sourceBytes))).getReader();
    authorize.mockImplementation(async () => { sourceBytes.fill(0); });
    const first = (await reader.read()).value!;
    expect(first[0]).toBe(19);
    new Uint8Array(first.buffer).fill(0);
    expect([...(await reader.read()).value!]).toEqual([19]);
    await reader.cancel();
  });

  it("rejects wrong hash, size, identity and oversized bindings before returning a body", async () => {
    for (const [binding, code] of [
      [{ sha256: "a".repeat(64), sizeBytes: 4 }, "SOURCE_FILE_CHANGED"],
      [{ sha256: "a".repeat(64), sizeBytes: 3 }, "SOURCE_FILE_CHANGED"],
      [{ sha256: "missing", sizeBytes: 4 }, "SOURCE_FILE_UNPROVEN"],
      [{ sha256: "a".repeat(64), sizeBytes: MAX_BOUND_DOWNLOAD_BYTES + 1 }, "DOWNLOAD_TOO_LARGE"],
    ] as const) {
      const authorize = vi.fn();
      await expect(authorizedOwnedDownloadStream(new Uint8Array(4), authorize, signal(), binding)).rejects.toMatchObject({ code });
      expect(authorize).not.toHaveBeenCalled();
    }
  });

  it("withholds a response on revocation and abort during initial authorization", async () => {
    for (const abortDuringProof of [false, true]) {
      const abort = new AbortController();
      const bytes = new Uint8Array([1, 2]);
      const binding = strictOptions(bytes).byteBinding;
      const authorize = async () => { if (abortDuringProof) abort.abort(); else throw denied(); };
      await expect(authorizedOwnedDownloadStream(bytes, authorize, abort.signal, binding)).rejects.toMatchObject(
        abortDuringProof ? { name: "AbortError" } : { code: "SUPPORT_AUTHORIZATION_REVOKED" });
    }
  });

  it("withholds a copied delivery when the request aborts during its permission check", async () => {
    const bytes = new Uint8Array(DOWNLOAD_AUTH_BYTES + 1).fill(1);
    const binding = strictOptions(bytes).byteBinding;
    const abort = new AbortController();
    const authorize = vi.fn().mockResolvedValue(undefined);
    const reader = (await authorizedOwnedDownloadStream(bytes, authorize, abort.signal, binding)).getReader();
    authorize.mockImplementationOnce(async () => { abort.abort(); });
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels an idle owned snapshot without more authorization or delivery", async () => {
    const bytes = new Uint8Array(DOWNLOAD_AUTH_BYTES + 1).fill(1);
    const authorize = vi.fn().mockResolvedValue(undefined);
    const reader = (await authorizedOwnedDownloadStream(bytes, authorize, signal(), strictOptions(bytes).byteBinding)).getReader();
    await reader.cancel();
    expect((await reader.read()).done).toBe(true);
    expect(authorize).toHaveBeenCalledOnce();
  });
});
