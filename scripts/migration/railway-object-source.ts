import {
  GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, S3Client,
} from "@aws-sdk/client-s3";
import type { ObjectHead, ObjectStore } from "./shared-tenant-objects";
import { ObjectTransferError } from "./shared-tenant-objects";

export const RAILWAY_OBJECT_ENDPOINT = "https://t3.storageapi.dev";

export interface RailwaySourceBinding {
  endpoint: string;
  bucket: string;
  identity: string;
}

export interface RailwayObjectSourceOptions extends RailwaySourceBinding {
  /** Exact binding already verified against the operator's provider inventory. */
  verifiedBinding: RailwaySourceBinding;
  credentials: { accessKeyId: string; secretAccessKey: string };
  region?: string;
}

export interface RailwayInventoryLimits {
  maxPages: number;
  maxObjects: number;
  maxTotalBytes: number;
  pageSize?: number;
}

export interface RailwayInventoryEntry extends ObjectHead {
  key: string;
}

function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new ObjectTransferError(code);
}

function validEtag(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !/[\x00-\x1f\x7f?#]/.test(value) && !value.includes("://");
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 1024
    && !/[\x00-\x1f\x7f?#]/.test(value) && !value.includes("://")
    && !value.split("/").some((part) => part === "." || part === "..");
}

function closeStream(body: { destroy?: () => void } | undefined) {
  // Cleanup must not replace a bounded error with a provider exception.
  try { body?.destroy?.(); } catch { /* The original operation remains authoritative. */ }
}

function missingObject(error: unknown) {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return value?.$metadata?.httpStatusCode === 404 && ["NoSuchKey", "NotFound"].includes(value.name ?? "");
}

function redacted(error: unknown, fallback: string): ObjectTransferError {
  // Whitelist only our own constructed errors, never a provider's name/message/cause.
  if (error instanceof ObjectTransferError) return error;
  const value = error as { $metadata?: { httpStatusCode?: number } } | null;
  return new ObjectTransferError(value?.$metadata?.httpStatusCode === 412 ? "SOURCE_ETAG_CHANGED" : fallback);
}

function headers(value: { ETag?: string; ContentLength?: number; ContentType?: string; Metadata?: Record<string, string> }): ObjectHead {
  requireValue(validEtag(value.ETag) && Number.isSafeInteger(value.ContentLength)
    && value.ContentLength! >= 0, "INVALID_OBJECT_HEADERS");
  requireValue(value.ContentType === undefined || (value.ContentType.length <= 256
    && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;[^\r\n]*)?$/.test(value.ContentType)
    && !value.ContentType.includes("://")), "INVALID_CONTENT_TYPE");
  // Hash metadata is useful for custody; unrelated provider metadata is not copied.
  const sha256 = value.Metadata?.sha256;
  requireValue(sha256 === undefined || /^[a-f0-9]{64}$/.test(sha256), "INVALID_OBJECT_HASH");
  return { etag: value.ETag, bytes: value.ContentLength!, contentType: value.ContentType,
    metadata: sha256 ? { sha256 } : {} };
}

/** Railway buckets are private-only; no ACL API or public-bucket mode is assumed.
 * https://docs.railway.com/storage-buckets
 * Source custody deliberately has no S3 write/delete implementation.
 */
export class RailwayObjectSource implements ObjectStore {
  readonly #identity: string;
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(options: RailwayObjectSourceOptions) {
    requireValue(options.endpoint === RAILWAY_OBJECT_ENDPOINT, "RAILWAY_ENDPOINT_FORBIDDEN");
    requireValue(typeof options.bucket === "string" && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)
      && !options.bucket.includes(".."), "INVALID_SOURCE_BUCKET");
    requireValue(typeof options.identity === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(options.identity), "INVALID_STORE_IDENTITY");
    requireValue(options.verifiedBinding?.endpoint === RAILWAY_OBJECT_ENDPOINT
      && options.verifiedBinding.bucket === options.bucket
      && options.verifiedBinding.identity === options.identity, "SOURCE_BINDING_MISMATCH");
    requireValue(typeof options.credentials?.accessKeyId === "string" && options.credentials.accessKeyId.length > 0
      && typeof options.credentials.secretAccessKey === "string" && options.credentials.secretAccessKey.length > 0,
    "SOURCE_CREDENTIALS_REQUIRED");
    requireValue(options.region === undefined || /^[a-z0-9-]{1,64}$/.test(options.region), "INVALID_SOURCE_REGION");
    this.#identity = options.identity;
    this.#bucket = options.bucket;
    this.#client = new S3Client({
      endpoint: RAILWAY_OBJECT_ENDPOINT, region: options.region ?? "auto",
      credentials: { ...options.credentials }, forcePathStyle: true,
      followRegionRedirects: false, useArnRegion: false, maxAttempts: 1,
    });
    // Inspect the resolved request immediately before transport. Credentials may
    // never be sent to an SDK endpoint override or a bucket-derived hostname.
    this.#client.middlewareStack.add((next) => async (args) => {
      const request = args.request as { protocol?: string; hostname?: string; port?: number; path?: string; method?: string };
      requireValue(request.protocol === "https:" && request.hostname === "t3.storageapi.dev"
        && (request.port === undefined || request.port === 443)
        && (request.path === `/${this.#bucket}` || request.path?.startsWith(`/${this.#bucket}/`))
        && (request.method === "GET" || request.method === "HEAD"), "SOURCE_REQUEST_FORBIDDEN");
      return next(args);
    }, { step: "finalizeRequest", priority: "low", name: "railwaySourceRequestBoundary" });
    Object.freeze(this);
  }

  get identity() { return this.#identity; }

  async assertPrivate(): Promise<void> {
    try {
      // Constructor binds the provider's private-only policy to the exact source;
      // authenticated HeadBucket proves the credentials still access that bucket.
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch (error) {
      throw redacted(error, "SOURCE_BUCKET_PRIVACY_UNPROVEN");
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    requireValue(validKey(key), "INVALID_OBJECT_KEY");
    try {
      return headers(await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key })));
    } catch (error) {
      if (missingObject(error)) return null;
      throw redacted(error, "SOURCE_HEAD_FAILED");
    }
  }

  async read(key: string, ifMatch?: string): Promise<(ObjectHead & { body: AsyncIterable<Uint8Array> }) | null> {
    requireValue(validKey(key), "INVALID_OBJECT_KEY");
    requireValue(ifMatch === undefined || validEtag(ifMatch), "INVALID_OBJECT_ETAG");
    let body: (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    try {
      const expected = ifMatch ?? (await this.head(key))?.etag;
      if (!expected) return null;
      const result = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key, IfMatch: expected }));
      body = result.Body as typeof body;
      const object = headers(result);
      requireValue(object.etag === expected, "SOURCE_ETAG_CHANGED");
      requireValue(body && typeof body[Symbol.asyncIterator] === "function", "INVALID_OBJECT_STREAM");
      const stream = body;
      const iterator = (async function* () {
        let bytes = 0;
        try {
          for await (const chunk of stream) {
            requireValue(chunk instanceof Uint8Array, "INVALID_OBJECT_STREAM");
            requireValue(chunk.byteLength <= object.bytes - bytes, "OBJECT_SIZE_EXCEEDED");
            bytes += chunk.byteLength;
            yield chunk;
          }
          requireValue(bytes === object.bytes, "OBJECT_SIZE_MISMATCH");
        } catch (error) {
          throw redacted(error, "SOURCE_STREAM_FAILED");
        } finally {
          closeStream(stream);
        }
      })();
      return { ...object, body: {
        [Symbol.asyncIterator]() {
          return {
            next: () => iterator.next(),
            async return() {
              // Also closes a download rejected by the caller before first next().
              closeStream(stream);
              return iterator.return();
            },
          };
        },
      } };
    } catch (error) {
      closeStream(body);
      if (missingObject(error)) return null;
      throw redacted(error, "SOURCE_READ_FAILED");
    }
  }

  async createOnly(_key: string, _bytes: Buffer, _metadata: Record<string, string>, _contentType?: string): Promise<boolean> {
    throw new ObjectTransferError("SOURCE_WRITES_FORBIDDEN");
  }

  async removeIfMatch(_key: string, _etag: string): Promise<boolean> {
    throw new ObjectTransferError("SOURCE_WRITES_FORBIDDEN");
  }

  /** Metadata inventory, never content. A writer fence is still required for a
   * final snapshot: listing pages cannot prove absence of concurrent additions.
   */
  async inventory(limits: RailwayInventoryLimits): Promise<RailwayInventoryEntry[]> {
    const { maxPages, maxObjects, maxTotalBytes, pageSize = 1000 } = { ...limits };
    requireValue(Number.isSafeInteger(maxPages) && maxPages > 0 && maxPages <= 10_000
      && Number.isSafeInteger(maxObjects) && maxObjects >= 0 && maxObjects <= 100_000
      && Number.isSafeInteger(maxTotalBytes) && maxTotalBytes >= 0
      && Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 1000, "INVALID_INVENTORY_LIMITS");
    try {
      await this.assertPrivate();
      const entries: RailwayInventoryEntry[] = [];
      const keys = new Set<string>();
      const tokens = new Set<string>();
      let token: string | undefined;
      let total = 0;
      for (let page = 0; page < maxPages; page++) {
        const result = await this.#client.send(new ListObjectsV2Command({ Bucket: this.#bucket,
          MaxKeys: pageSize, ...(token ? { ContinuationToken: token } : {}) }));
        requireValue(result.Name === this.#bucket, "SOURCE_BINDING_MISMATCH");
        requireValue(Array.isArray(result.Contents) || result.Contents === undefined, "INVALID_INVENTORY_PAGE");
        const contents = result.Contents ?? [];
        requireValue(contents.length <= pageSize && contents.length <= maxObjects - entries.length, "INVENTORY_OBJECT_LIMIT");
        for (const item of contents) {
          requireValue(validKey(item.Key) && validEtag(item.ETag) && Number.isSafeInteger(item.Size)
            && item.Size! >= 0, "INVALID_INVENTORY_ENTRY");
          requireValue(!keys.has(item.Key), "DUPLICATE_INVENTORY_KEY");
          requireValue(item.Size! <= maxTotalBytes - total, "INVENTORY_BYTE_LIMIT");
          const object = await this.head(item.Key);
          requireValue(object && object.etag === item.ETag && object.bytes === item.Size, "SOURCE_INVENTORY_CHANGED");
          keys.add(item.Key);
          total += object.bytes;
          entries.push({ key: item.Key, ...object });
        }
        requireValue(typeof result.IsTruncated === "boolean", "INVALID_INVENTORY_PAGE");
        if (!result.IsTruncated) return entries;
        token = result.NextContinuationToken;
        requireValue(typeof token === "string" && token.length > 0 && token.length <= 8192
          && !tokens.has(token), "INVALID_INVENTORY_CURSOR");
        tokens.add(token);
      }
      throw new ObjectTransferError("INVENTORY_PAGE_LIMIT");
    } catch (error) {
      throw redacted(error, "SOURCE_INVENTORY_FAILED");
    }
  }

  destroy(): void {
    try { this.#client.destroy(); } catch { throw new ObjectTransferError("SOURCE_CLOSE_FAILED"); }
  }
}
