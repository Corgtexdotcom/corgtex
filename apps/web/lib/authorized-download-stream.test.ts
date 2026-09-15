import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupportAuthorizationContext, runWithSupportOrigin } from "../../../packages/shared/src/support-context";

vi.mock("@corgtex/domain", () => ({ AppError: class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
import { AppError } from "@corgtex/domain";
import { authorizedDownloadStream, DOWNLOAD_AUTH_BYTES, DOWNLOAD_AUTH_INTERVAL_MS } from "./authorized-download-stream";

afterEach(() => vi.restoreAllMocks());
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
