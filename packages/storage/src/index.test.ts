import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  s3ClientMock,
  azureIdentityMock,
  blobMocks,
} = vi.hoisted(() => ({
  s3ClientMock: vi.fn(),
  azureIdentityMock: {
    DefaultAzureCredential: vi.fn(function MockDefaultAzureCredential(options: unknown) {
      return { kind: "default-azure-credential", options };
    }),
  },
  blobMocks: {
    blockBlobClient: {
      uploadData: vi.fn(),
    },
    blobClient: {
      url: "https://acct.blob.core.windows.net/files/path/test.txt",
      download: vi.fn(),
      deleteIfExists: vi.fn(),
    },
    containerClient: {
      getBlockBlobClient: vi.fn(),
      getBlobClient: vi.fn(),
    },
    serviceClient: {
      getContainerClient: vi.fn(),
      getUserDelegationKey: vi.fn(),
    },
    BlobServiceClientConstructor: vi.fn(),
    BlobServiceClientFromConnectionString: vi.fn(),
    StorageSharedKeyCredential: vi.fn(function MockStorageSharedKeyCredential(accountName: string, accountKey: string) {
      return { accountName, accountKey };
    }),
    BlobSASPermissionsParse: vi.fn(),
    generateBlobSASQueryParameters: vi.fn(),
  },
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

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: azureIdentityMock.DefaultAzureCredential,
}));

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: class MockBlobServiceClient {
    static fromConnectionString(connectionString: string) {
      blobMocks.BlobServiceClientFromConnectionString(connectionString);
      return blobMocks.serviceClient;
    }

    constructor(endpoint: string, credential: unknown) {
      blobMocks.BlobServiceClientConstructor(endpoint, credential);
      return blobMocks.serviceClient;
    }
  },
  StorageSharedKeyCredential: blobMocks.StorageSharedKeyCredential,
  BlobSASPermissions: {
    parse: blobMocks.BlobSASPermissionsParse,
  },
  generateBlobSASQueryParameters: blobMocks.generateBlobSASQueryParameters,
}));

function clearStorageEnv() {
  for (const key of [
    "STORAGE_PROVIDER",
    "R2_ACCOUNT_ID",
    "R2_BUCKET_NAME",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "S3_BUCKET_NAME",
    "AWS_S3_BUCKET_NAME",
    "S3_ACCESS_KEY_ID",
    "S3_ACCESS_KEY",
    "S3_SECRET_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_ENDPOINT",
    "S3_REGION",
    "AWS_REGION",
    "S3_FORCE_PATH_STYLE",
    "BUCKET",
    "ACCESS_KEY_ID",
    "SECRET_ACCESS_KEY",
    "AZURE_STORAGE_ACCOUNT_NAME",
    "AZURE_STORAGE_CONTAINER_NAME",
    "AZURE_STORAGE_AUTH_MODE",
    "AZURE_STORAGE_CONNECTION_STRING",
    "AZURE_STORAGE_BLOB_ENDPOINT",
    "AZURE_STORAGE_CLIENT_ID",
    "AZURE_CLIENT_ID",
  ]) {
    delete process.env[key];
  }
}

describe("storage providers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    clearStorageEnv();
    blobMocks.containerClient.getBlockBlobClient.mockReturnValue(blobMocks.blockBlobClient);
    blobMocks.containerClient.getBlobClient.mockReturnValue(blobMocks.blobClient);
    blobMocks.serviceClient.getContainerClient.mockReturnValue(blobMocks.containerClient);
    blobMocks.serviceClient.getUserDelegationKey.mockResolvedValue({ signedObjectId: "delegation-key" });
    blobMocks.BlobSASPermissionsParse.mockReturnValue({ permissions: "r" });
    blobMocks.generateBlobSASQueryParameters.mockReturnValue({ toString: () => "sig=mock" });
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

  it("selects S3 by default and Azure Blob only when explicitly configured", async () => {
    const { createDefaultStorageProvider, resolveStorageProviderName, S3StorageProvider, AzureBlobStorageProvider } = await import("./index");

    expect(resolveStorageProviderName()).toBe("s3");
    expect(createDefaultStorageProvider()).toBeInstanceOf(S3StorageProvider);

    clearStorageEnv();
    process.env.STORAGE_PROVIDER = "azure_blob";
    process.env.AZURE_STORAGE_ACCOUNT_NAME = "acct";
    process.env.AZURE_STORAGE_CONTAINER_NAME = "files";

    expect(resolveStorageProviderName()).toBe("azure_blob");
    expect(createDefaultStorageProvider()).toBeInstanceOf(AzureBlobStorageProvider);
  });

  it("resolves managed identity Azure Blob configuration by default", async () => {
    const { resolveAzureBlobStorageRuntimeConfig } = await import("./index");
    const config = resolveAzureBlobStorageRuntimeConfig({
      AZURE_STORAGE_ACCOUNT_NAME: "acct",
      AZURE_STORAGE_CONTAINER_NAME: "files",
      AZURE_CLIENT_ID: "shared-client-id",
    } as unknown as NodeJS.ProcessEnv);

    expect(config).toMatchObject({
      accountName: "acct",
      containerName: "files",
      endpoint: "https://acct.blob.core.windows.net",
      authMode: "managed_identity",
      managedIdentityClientId: "shared-client-id",
      configured: true,
      missing: [],
    });
  });

  it("requires explicit Azure Blob connection string fields in bootstrap mode", async () => {
    const { resolveAzureBlobStorageRuntimeConfig } = await import("./index");
    const config = resolveAzureBlobStorageRuntimeConfig({
      AZURE_STORAGE_AUTH_MODE: "connection_string",
      AZURE_STORAGE_CONTAINER_NAME: "files",
    } as unknown as NodeJS.ProcessEnv);

    expect(config.configured).toBe(false);
    expect(config.missing).toEqual([
      "connectionString",
      "connectionStringAccountName",
      "connectionStringAccountKey",
    ]);
  });

  it("uploads, reads, signs, and deletes Azure Blob objects with managed identity", async () => {
    const { AzureBlobStorageProvider } = await import("./index");
    const storage = new AzureBlobStorageProvider({
      accountName: "acct",
      containerName: "files",
      endpoint: "https://acct.blob.core.windows.net",
      authMode: "managed_identity",
      managedIdentityClientId: "client-id",
      configured: true,
      missing: [],
    });

    await storage.put("path/test.txt", Buffer.from("hello"), { contentType: "text/plain" });

    expect(azureIdentityMock.DefaultAzureCredential).toHaveBeenCalledWith({
      managedIdentityClientId: "client-id",
    });
    expect(blobMocks.BlobServiceClientConstructor).toHaveBeenCalledWith(
      "https://acct.blob.core.windows.net",
      expect.objectContaining({ kind: "default-azure-credential" }),
    );
    expect(blobMocks.serviceClient.getContainerClient).toHaveBeenCalledWith("files");
    expect(blobMocks.containerClient.getBlockBlobClient).toHaveBeenCalledWith("path/test.txt");
    expect(blobMocks.blockBlobClient.uploadData).toHaveBeenCalledWith(Buffer.from("hello"), {
      blobHTTPHeaders: {
        blobContentType: "text/plain",
      },
    });

    blobMocks.blobClient.download.mockResolvedValueOnce({
      readableStreamBody: Readable.from([Buffer.from("hello")]),
      contentType: "text/plain",
    });

    await expect(storage.get("path/test.txt")).resolves.toEqual({
      data: Buffer.from("hello"),
      contentType: "text/plain",
    });

    await expect(storage.getSignedUrl("path/test.txt", 60)).resolves.toBe(
      "https://acct.blob.core.windows.net/files/path/test.txt?sig=mock",
    );
    expect(blobMocks.serviceClient.getUserDelegationKey).toHaveBeenCalledTimes(1);
    expect(blobMocks.generateBlobSASQueryParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        containerName: "files",
        blobName: "path/test.txt",
        permissions: { permissions: "r" },
      }),
      { signedObjectId: "delegation-key" },
      "acct",
    );

    await storage.delete("path/test.txt");
    expect(blobMocks.containerClient.getBlobClient).toHaveBeenCalledWith("path/test.txt");
    expect(blobMocks.blobClient.deleteIfExists).toHaveBeenCalledTimes(1);
  });

  it("uses connection string auth for Azure Blob bootstrap signed URLs", async () => {
    const { AzureBlobStorageProvider, resolveAzureBlobStorageRuntimeConfig } = await import("./index");
    const accountKeyField = ["Account", "Key"].join("");
    const accountKey = "fixture-key";
    const connectionString = `DefaultEndpointsProtocol=https;AccountName=acct;${accountKeyField}=${accountKey};EndpointSuffix=core.windows.net`;
    const config = resolveAzureBlobStorageRuntimeConfig({
      AZURE_STORAGE_AUTH_MODE: "connection_string",
      AZURE_STORAGE_CONTAINER_NAME: "files",
      AZURE_STORAGE_CONNECTION_STRING: connectionString,
    } as unknown as NodeJS.ProcessEnv);

    expect(config).toMatchObject({
      accountName: "acct",
      accountKey,
      authMode: "connection_string",
      configured: true,
    });

    const storage = new AzureBlobStorageProvider(config);

    expect(blobMocks.BlobServiceClientFromConnectionString).toHaveBeenCalledWith(
      connectionString,
    );
    expect(blobMocks.StorageSharedKeyCredential).toHaveBeenCalledWith("acct", accountKey);

    await expect(storage.getSignedUrl("path/test.txt", 60)).resolves.toBe(
      "https://acct.blob.core.windows.net/files/path/test.txt?sig=mock",
    );
    expect(blobMocks.serviceClient.getUserDelegationKey).not.toHaveBeenCalled();
    expect(blobMocks.generateBlobSASQueryParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        containerName: "files",
        blobName: "path/test.txt",
      }),
      { accountName: "acct", accountKey },
    );
  });
});
