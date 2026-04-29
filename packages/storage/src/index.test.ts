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
    delete process.env.S3_BUCKET_NAME;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_REGION;
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
});
