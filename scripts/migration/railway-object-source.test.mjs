import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ send: vi.fn(), config: null, boundary: null, destroy: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async (original) => {
  const actual = await original();
  return { ...actual, S3Client: class {
    constructor(config) { sdk.config = config; }
    send = sdk.send;
    destroy = sdk.destroy;
    middlewareStack = { add: (boundary) => { sdk.boundary = boundary; } };
  } };
});
import { RailwayObjectSource, RAILWAY_OBJECT_ENDPOINT } from "./railway-object-source.ts";

const binding = { endpoint: RAILWAY_OBJECT_ENDPOINT, bucket: "synthetic-source", identity: "railway-source" };
const options = () => ({ ...binding, verifiedBinding: { ...binding },
  credentials: { accessKeyId: randomBytes(12).toString("hex"), secretAccessKey: randomBytes(24).toString("hex") } });
const head = (overrides = {}) => ({ ETag: '"generation-a"', ContentLength: 3, ContentType: "text/plain", ...overrides });
const item = (overrides = {}) => ({ Key: "document", ETag: '"generation-a"', Size: 3, ...overrides });
const page = (overrides = {}) => ({ Name: binding.bucket, IsTruncated: false, Contents: [item()], ...overrides });
const limits = (overrides = {}) => ({ maxPages: 5, maxObjects: 10, maxTotalBytes: 100, pageSize: 2, ...overrides });
const providerError = (status = 403, name = "AccessDenied") => Object.assign(new Error("provider private details"), {
  name, $metadata: { httpStatusCode: status }, cause: "provider private cause",
});
const collect = async (body) => { const values = []; for await (const chunk of body) values.push(chunk); return Buffer.concat(values); };
const expectRedacted = async (operation, code) => {
  const error = await operation.then(() => null, (error) => error);
  expect(error).toMatchObject({ name: "ObjectTransferError", code, message: `Object transfer failed: ${code}.` });
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toContain("provider private");
};

beforeEach(() => { sdk.send.mockReset(); sdk.destroy.mockReset(); sdk.config = null; sdk.boundary = null; });

describe("Railway source custody", () => {
  it("rejects writes and deletes without making a provider request", async () => {
    const store = new RailwayObjectSource(options());
    await expect(store.createOnly("document", Buffer.from("abc"), {})).rejects.toMatchObject({ code: "SOURCE_WRITES_FORBIDDEN" });
    await expect(store.removeIfMatch("document", '"generation-a"')).rejects.toMatchObject({ code: "SOURCE_WRITES_FORBIDDEN" });
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it.each(["https://foreign.example", "http://t3.storageapi.dev", "https://t3.storageapi.dev/", "https://t3.storageapi.dev:443", "https://t3.storageapi.dev@foreign.example"])(
    "rejects endpoint %s", (endpoint) => {
      expect(() => new RailwayObjectSource({ ...options(), endpoint })).toThrow("RAILWAY_ENDPOINT_FORBIDDEN");
      expect(sdk.config).toBeNull();
    });

  it("rejects mismatched bucket/identity bindings before authentication", () => {
    for (const change of [{ bucket: "foreign-bucket" }, { identity: "other-source" }, { endpoint: "https://foreign.example" }]) {
      expect(() => new RailwayObjectSource({ ...options(), verifiedBinding: { ...binding, ...change } })).toThrow("SOURCE_BINDING_MISMATCH");
    }
    expect(sdk.config).toBeNull();
  });

  it("copies its binding and credentials and only checks authenticated HeadBucket, never ACL", async () => {
    const input = options();
    const originalAccessKey = input.credentials.accessKeyId;
    const store = new RailwayObjectSource(input);
    input.bucket = input.verifiedBinding.bucket = "foreign-bucket";
    input.credentials.accessKeyId = "changed";
    expect(() => { store.identity = "foreign-source"; }).toThrow();
    expect(() => { Object.defineProperty(store, "identity", { value: "foreign-source" }); }).toThrow();
    sdk.send.mockResolvedValue({});
    await store.assertPrivate();
    expect(store.identity).toBe(binding.identity);
    expect(sdk.config).toMatchObject({ endpoint: RAILWAY_OBJECT_ENDPOINT, forcePathStyle: true,
      followRegionRedirects: false, useArnRegion: false, maxAttempts: 1, credentials: { accessKeyId: originalAccessKey } });
    expect(sdk.send.mock.calls[0][0].constructor.name).toBe("HeadBucketCommand");
    expect(sdk.send.mock.calls[0][0].input).toEqual({ Bucket: binding.bucket });
  });

  it("rejects foreign resolved requests and all transport mutations", async () => {
    new RailwayObjectSource(options());
    const next = vi.fn().mockResolvedValue({});
    const request = { protocol: "https:", hostname: "t3.storageapi.dev", path: `/${binding.bucket}/document`, method: "GET" };
    for (const change of [{ hostname: "foreign.example" }, { path: "/foreign-bucket/document" }, { method: "PUT" },
      { protocol: "http:" }, { port: 80 }, { method: "DELETE" }]) {
      await expect(sdk.boundary(next)({ request: { ...request, ...change } })).rejects.toMatchObject({ code: "SOURCE_REQUEST_FORBIDDEN" });
    }
    expect(next).not.toHaveBeenCalled();
    await sdk.boundary(next)({ request });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("redacts authentication failures and redirects without retrying a different endpoint", async () => {
    const store = new RailwayObjectSource(options());
    sdk.send.mockRejectedValue(providerError(301, "PermanentRedirect"));
    await expectRedacted(store.assertPrivate(), "SOURCE_BUCKET_PRIVACY_UNPROVEN");
    sdk.send.mockRejectedValue(providerError());
    await expect(store.head("document")).rejects.toThrow("Object transfer failed: SOURCE_HEAD_FAILED.");
  });

  it("HEADs once and GETs with exact IfMatch, exposing only hash metadata", async () => {
    const store = new RailwayObjectSource(options());
    const sha256 = "a".repeat(64);
    sdk.send.mockResolvedValueOnce(head()).mockResolvedValueOnce(head({ Body: Readable.from([Buffer.from("abc")]),
      Metadata: { sha256, unrelated: "private metadata" } }));
    const object = await store.read("document");
    expect(sdk.send.mock.calls.map(([command]) => command.constructor.name)).toEqual(["HeadObjectCommand", "GetObjectCommand"]);
    expect(sdk.send.mock.calls[1][0].input).toEqual({ Bucket: binding.bucket, Key: "document", IfMatch: '"generation-a"' });
    expect(object.metadata).toEqual({ sha256 });
    expect(await collect(object.body)).toEqual(Buffer.from("abc"));
  });

  it("uses the caller's exact ETag without an unbound GET", async () => {
    const store = new RailwayObjectSource(options());
    sdk.send.mockResolvedValue(head({ Body: Readable.from([Buffer.from("abc")]) }));
    await collect((await store.read("document", '"generation-a"')).body);
    expect(sdk.send).toHaveBeenCalledTimes(1);
    expect(sdk.send.mock.calls[0][0].input.IfMatch).toBe('"generation-a"');
    await expect(store.read("document", "")).rejects.toMatchObject({ code: "INVALID_OBJECT_ETAG" });
  });

  it("rejects bucket traversal keys before any provider request", async () => {
    const store = new RailwayObjectSource(options());
    await expect(store.read("../foreign-bucket/document")).rejects.toMatchObject({ code: "INVALID_OBJECT_KEY" });
    await expect(store.head("document/./other")).rejects.toMatchObject({ code: "INVALID_OBJECT_KEY" });
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it("closes an unread response when its consumer rejects the headers", async () => {
    const store = new RailwayObjectSource(options());
    const body = Readable.from([Buffer.from("abc")]);
    sdk.send.mockResolvedValueOnce(head({ Body: body }));
    const object = await store.read("document", '"generation-a"');
    await object.body[Symbol.asyncIterator]().return();
    expect(body.destroyed).toBe(true);
  });

  it("rejects ETag drift both as a provider 412 and a mismatched response", async () => {
    const store = new RailwayObjectSource(options());
    sdk.send.mockRejectedValueOnce(providerError(412, "PreconditionFailed"));
    await expectRedacted(store.read("document", '"generation-a"'), "SOURCE_ETAG_CHANGED");
    const body = Readable.from([Buffer.from("abc")]);
    sdk.send.mockResolvedValueOnce(head({ ETag: '"generation-b"', Body: body }));
    await expect(store.read("document", '"generation-a"')).rejects.toMatchObject({ code: "SOURCE_ETAG_CHANGED" });
    expect(body.destroyed).toBe(true);
  });

  it("redacts stream errors and checks streamed size", async () => {
    const store = new RailwayObjectSource(options());
    for (const [body, code] of [
      [(async function* () { throw providerError(); })(), "SOURCE_STREAM_FAILED"],
      [Readable.from([Buffer.from("abcd")]), "OBJECT_SIZE_EXCEEDED"],
      [Readable.from([Buffer.from("ab")]), "OBJECT_SIZE_MISMATCH"],
    ]) {
      sdk.send.mockResolvedValueOnce(head({ Body: body }));
      await expectRedacted(collect((await store.read("document", '"generation-a"')).body), code);
    }
  });

  it("returns null only for object absence, not missing buckets or authentication errors", async () => {
    const store = new RailwayObjectSource(options());
    sdk.send.mockRejectedValueOnce(providerError(404, "NotFound"));
    expect(await store.read("document")).toBeNull();
    expect(sdk.send).toHaveBeenCalledTimes(1);
    sdk.send.mockRejectedValueOnce(providerError(404, "NoSuchBucket"));
    await expect(store.head("document")).rejects.toMatchObject({ code: "SOURCE_HEAD_FAILED" });
  });

  it("inventories bounded pages with exact bucket, ETag, size and HEAD hash metadata", async () => {
    const store = new RailwayObjectSource(options());
    sdk.send.mockResolvedValueOnce({}).mockResolvedValueOnce(page({ IsTruncated: true, NextContinuationToken: "second-page" }))
      .mockResolvedValueOnce(head()).mockResolvedValueOnce(page({ Contents: [item({ Key: "other" })] }))
      .mockResolvedValueOnce(head({ Metadata: { sha256: "b".repeat(64) } }));
    const inventory = await store.inventory(limits());
    expect(inventory.map((entry) => entry.key)).toEqual(["document", "other"]);
    expect(inventory[1].metadata).toEqual({ sha256: "b".repeat(64) });
    expect(sdk.send.mock.calls[3][0].input).toEqual({ Bucket: binding.bucket, MaxKeys: 2, ContinuationToken: "second-page" });
    expect(sdk.send.mock.calls.some(([command]) => command.constructor.name === "GetObjectCommand")).toBe(false);
  });

  it.each([
    [limits({ maxPages: 1 }), page({ IsTruncated: true, NextContinuationToken: "next" }), "INVENTORY_PAGE_LIMIT"],
    [limits({ maxObjects: 0 }), page(), "INVENTORY_OBJECT_LIMIT"],
    [limits({ maxTotalBytes: 2 }), page(), "INVENTORY_BYTE_LIMIT"],
    [limits(), page({ Name: "foreign-bucket" }), "SOURCE_BINDING_MISMATCH"],
    [limits(), page({ IsTruncated: true, NextContinuationToken: undefined }), "INVALID_INVENTORY_CURSOR"],
  ])("fails closed on incomplete or foreign inventory %#", async (bounds, listing, code) => {
    const store = new RailwayObjectSource(options());
    sdk.send.mockResolvedValueOnce({}).mockResolvedValueOnce(listing).mockResolvedValue(head());
    await expect(store.inventory(bounds)).rejects.toMatchObject({ code });
    expect(sdk.send.mock.calls.filter(([command]) => command.constructor.name === "ListObjectsV2Command")).toHaveLength(1);
  });

  it("rejects repeated continuation cursors and duplicates", async () => {
    const store = new RailwayObjectSource(options());
    sdk.send.mockResolvedValueOnce({}).mockResolvedValue(page({ Contents: [], IsTruncated: true, NextContinuationToken: "same" }));
    await expect(store.inventory(limits())).rejects.toMatchObject({ code: "INVALID_INVENTORY_CURSOR" });
    sdk.send.mockReset().mockResolvedValueOnce({}).mockResolvedValueOnce(page({ Contents: [item(), item()] })).mockResolvedValue(head());
    await expect(store.inventory(limits())).rejects.toMatchObject({ code: "DUPLICATE_INVENTORY_KEY" });
  });

  it("rejects object drift between LIST and HEAD", async () => {
    const store = new RailwayObjectSource(options());
    sdk.send.mockResolvedValueOnce({}).mockResolvedValueOnce(page()).mockResolvedValueOnce(head({ ETag: '"generation-b"' }));
    await expect(store.inventory(limits())).rejects.toMatchObject({ code: "SOURCE_INVENTORY_CHANGED" });
  });
});
