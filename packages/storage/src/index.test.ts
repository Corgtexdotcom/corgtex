import { beforeEach, describe, expect, it, vi } from "vitest";

const { s3ClientMock } = vi.hoisted(() => ({
  s3ClientMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: s3ClientMock,
  PutObjectCommand: class PutObjectCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetObjectCommand: class GetObjectCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  },
  DeleteObjectCommand: class DeleteObjectCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(),
}));

describe("S3StorageProvider", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_BUCKET_NAME;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.S3_BUCKET_NAME;
    delete process.env.AWS_S3_BUCKET_NAME;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_REGION;
    delete process.env.AWS_REGION;
    delete process.env.S3_FORCE_PATH_STYLE;
    delete process.env.BUCKET;
    delete process.env.ACCESS_KEY_ID;
    delete process.env.SECRET_ACCESS_KEY;
    process.env.RAILWAY_BUCKET_NAME = "railway-bucket";
    process.env.RAILWAY_BUCKET_ACCESS_KEY_ID = "railway-access";
    process.env.RAILWAY_BUCKET_SECRET_ACCESS_KEY = "railway-secret";
    process.env.RAILWAY_BUCKET_ENDPOINT = "https://bucket.railway.internal";
    process.env.RAILWAY_BUCKET_REGION = "auto";
  });

  it("accepts Railway Bucket environment variables through the S3-compatible provider", async () => {
    const { S3StorageProvider } = await import("./index");
    new S3StorageProvider();

    expect(s3ClientMock).toHaveBeenCalledWith(expect.objectContaining({
      region: "auto",
      endpoint: "https://bucket.railway.internal",
      credentials: {
        accessKeyId: "railway-access",
        secretAccessKey: "railway-secret",
      },
    }));
  });

  it("derives the Cloudflare R2 endpoint from the account id", async () => {
    delete process.env.RAILWAY_BUCKET_NAME;
    delete process.env.RAILWAY_BUCKET_ACCESS_KEY_ID;
    delete process.env.RAILWAY_BUCKET_SECRET_ACCESS_KEY;
    delete process.env.RAILWAY_BUCKET_ENDPOINT;
    process.env.R2_ACCOUNT_ID = "acct_123";
    process.env.R2_BUCKET_NAME = "r2-bucket";
    process.env.R2_ACCESS_KEY_ID = "r2-access";
    process.env.R2_SECRET_ACCESS_KEY = "r2-secret";

    const { S3StorageProvider } = await import("./index");
    new S3StorageProvider();

    expect(s3ClientMock).toHaveBeenCalledWith(expect.objectContaining({
      region: "auto",
      endpoint: "https://acct_123.r2.cloudflarestorage.com",
      credentials: {
        accessKeyId: "r2-access",
        secretAccessKey: "r2-secret",
      },
    }));
  });

  it("reports bucket-only placeholder config as missing storage runtime fields", async () => {
    const { resolveStorageRuntimeConfig } = await import("./index");
    const config = resolveStorageRuntimeConfig({
      R2_BUCKET_NAME: "corgtex",
    } as unknown as NodeJS.ProcessEnv);

    expect(config.configured).toBe(false);
    expect(config.missing).toEqual(["endpoint", "accessKeyId", "secretAccessKey"]);
  });

  it("throws a clear error when an upload is attempted without a complete storage config", async () => {
    const { S3StorageProvider } = await import("./index");
    const storage = new S3StorageProvider({
      bucket: "corgtex",
      region: "auto",
      forcePathStyle: false,
      configured: false,
      missing: ["endpoint", "accessKeyId", "secretAccessKey"],
    });

    await expect(storage.put("test.txt", Buffer.from("test"))).rejects.toThrow(
      "StorageProvider: cannot upload; storage is not configured",
    );
  });
});
