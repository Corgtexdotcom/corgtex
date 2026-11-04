import { afterEach, beforeEach, expect, it, vi } from "vitest";
const tokens = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class { getToken = tokens.get; } }));
import { syncAzureKnowledgeSource, type AzureKnowledgeChunkInput } from "./azure-search";

const originalEnv = { ...process.env };
const revoked = Object.assign(new Error("Original source or claim changed"), { code: "SOURCE_CHANGED" });
function input(count = 1) {
  const chunks: AzureKnowledgeChunkInput[] = Array.from({ length: count }, (_, chunkIndex) => ({
    id: `new-${chunkIndex}`, workspaceId: "synthetic-workspace", sourceType: "DOCUMENT", sourceId: "source",
    sourceTitle: "Synthetic private source", content: "Synthetic private chunk", accessDomain: "WORKSPACE",
    chunkIndex, embedding: [1, 0], metadata: {}, sensitivity: "CONFIDENTIAL",
  }));
  return { workspaceId: "synthetic-workspace", sourceType: "DOCUMENT" as const, sourceId: "source", chunks };
}
function response(value: unknown[] = []) { return new Response(JSON.stringify({ value }), { status: 200 }); }
function controls(check: () => void = () => {}) {
  const controller = new AbortController();
  const authorizeAttempt = vi.fn(async ({ signal }: Readonly<{ signal: AbortSignal }>) => {
    signal.throwIfAborted(); check();
  });
  return { controller, value: { signal: controller.signal, authorizeAttempt }, authorizeAttempt };
}
beforeEach(() => {
  process.env = { ...originalEnv, AZURE_SEARCH_ENDPOINT: "https://synthetic.invalid", AZURE_SEARCH_INDEX_NAME: "synthetic-index",
    AZURE_SEARCH_AUTH_MODE: "managed_identity", AZURE_SEARCH_VECTOR_DIMENSIONS: "2" };
  tokens.get.mockReset().mockResolvedValue({ token: "synthetic-token", expiresOnTimestamp: Date.now() + 10000 });
  vi.stubGlobal("fetch", vi.fn(async () => response()));
});
afterEach(() => { process.env = originalEnv; vi.unstubAllGlobals(); });

it("denies the first HTTP send after authority changes during managed credentials", async () => {
  let readable = true;
  tokens.get.mockImplementation(async () => { readable = false; return { token: "synthetic-token" }; });
  const c = controls(() => { if (!readable) throw revoked; });
  await expect(syncAzureKnowledgeSource(input(), c.value)).rejects.toBe(revoked);
  expect(c.authorizeAttempt).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([1, 2, 4, 5])("stops the next data-plane send after response %i withdraws original authority", async withdrawAfter => {
  let readable = true, sends = 0;
  const c = controls(() => { if (!readable) throw revoked; });
  vi.mocked(fetch).mockImplementation(async () => {
    sends++;
    const values = sends === 2 ? [{ id: "old-document" }] : [];
    if (sends === withdrawAfter) readable = false;
    return response(values);
  });
  await expect(syncAzureKnowledgeSource(input(1001), c.value)).rejects.toBe(revoked);
  expect(fetch).toHaveBeenCalledTimes(withdrawAfter);
  expect(c.authorizeAttempt).toHaveBeenCalledTimes(withdrawAfter + 1);
  expect(c.authorizeAttempt.mock.calls.at(-1)![0].signal.aborted).toBe(true);
});

it("keeps a denied guard latched if an outer retry restores the callback", async () => {
  let readable = false;
  const c = controls(() => { if (!readable) throw revoked; });
  await expect(syncAzureKnowledgeSource(input(), c.value)).rejects.toBe(revoked);
  readable = true;
  await expect(syncAzureKnowledgeSource(input(), c.value)).rejects.toBe(revoked);
  expect(fetch).not.toHaveBeenCalled();
  expect(c.authorizeAttempt).toHaveBeenCalledTimes(1);
});

it("rechecks an outer transport retry without turning ordinary failures into permanent denial", async () => {
  let readable = true;
  const c = controls(() => { if (!readable) throw revoked; });
  vi.mocked(fetch).mockImplementationOnce(async () => { readable = false; throw new Error("Synthetic network failure"); });
  await expect(syncAzureKnowledgeSource(input(), c.value)).rejects.toThrow("Synthetic network failure");
  await expect(syncAzureKnowledgeSource(input(), c.value)).rejects.toBe(revoked);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(c.authorizeAttempt).toHaveBeenCalledTimes(2);
});

it("honors caller cancellation during credentials even if credential code ignores cancellation", async () => {
  const c = controls();
  tokens.get.mockImplementation(async () => { c.controller.abort(revoked); return { token: "synthetic-token" }; });
  await expect(syncAzureKnowledgeSource(input(), c.value)).rejects.toBe(revoked);
  expect(fetch).not.toHaveBeenCalled();
});

it("cannot return success if an HTTP adapter swallows cancellation", async () => {
  const c = controls();
  vi.mocked(fetch).mockImplementationOnce(async () => { c.controller.abort(revoked); return response(); });
  await expect(syncAzureKnowledgeSource(input(), c.value)).rejects.toBe(revoked);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([0, 1001])("authorizes the complete delete and %i-document upload pipeline", async count => {
  let sends = 0;
  const c = controls();
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    sends++;
    expect(init?.signal).toBe(c.authorizeAttempt.mock.calls.at(-1)![0].signal);
    expect(init?.signal?.aborted).toBe(false);
    return response(sends === 2 ? [{ id: "old-document" }] : []);
  });
  await expect(syncAzureKnowledgeSource(input(count), c.value)).resolves.toEqual({ skipped: false, deleted: 1, uploaded: count });
  expect(fetch).toHaveBeenCalledTimes(count ? 6 : 4);
  expect(c.authorizeAttempt).toHaveBeenCalledTimes(count ? 6 : 4);
  expect(tokens.get).toHaveBeenCalledTimes(count ? 6 : 4);
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[2][1]?.body)).value).toEqual([{ "@search.action": "delete", id: "old-document" }]);
  if (count) expect(JSON.parse(String(vi.mocked(fetch).mock.calls[5][1]?.body)).value).toHaveLength(1);
});

it("preserves a legitimate retry after a transient HTTP failure", async () => {
  const c = controls();
  vi.mocked(fetch).mockRejectedValueOnce(new Error("Transient transport failure"));
  await expect(syncAzureKnowledgeSource(input(0), c.value)).rejects.toThrow("Transient transport failure");
  await expect(syncAzureKnowledgeSource(input(0), c.value)).resolves.toEqual({ skipped: false, deleted: 0, uploaded: 0 });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(c.authorizeAttempt).toHaveBeenCalledTimes(3);
});

it("keeps cancellation fatal while response JSON is awaiting", async () => {
  const c = controls();
  const reply = response();
  vi.spyOn(reply, "json").mockImplementation(async () => { c.controller.abort(revoked); return { value: [] }; });
  vi.mocked(fetch).mockResolvedValueOnce(reply);
  await expect(syncAzureKnowledgeSource(input(), c.value)).rejects.toBe(revoked);
  expect(fetch).toHaveBeenCalledTimes(1);
});
