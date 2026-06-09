import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";
import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";

export interface StorageProvider {
  put(
    key: string,
    data: Buffer,
    opts?: { contentType?: string }
  ): Promise<{ key: string; size: number }>;
  get(key: string): Promise<{ data: Buffer; contentType?: string } | null>;
  getSignedUrl(key: string, expiresInSec?: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface StorageRuntimeConfig {
  bucket: string;
  endpoint?: string;
  region: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  forcePathStyle: boolean;
  configured: boolean;
  missing: string[];
}

export type StorageProviderName = "s3" | "azure_blob";
export type AzureBlobStorageAuthMode = "managed_identity" | "connection_string";

export interface AzureBlobStorageRuntimeConfig {
  accountName?: string;
  containerName: string;
  endpoint?: string;
  authMode: AzureBlobStorageAuthMode;
  connectionString?: string;
  accountKey?: string;
  managedIdentityClientId?: string;
  configured: boolean;
  missing: string[];
}

function firstEnv(env: NodeJS.ProcessEnv, keys: string[]) {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function storageProviderName(env: NodeJS.ProcessEnv = process.env): StorageProviderName {
  const provider = firstEnv(env, ["STORAGE_PROVIDER"]) ?? "s3";
  if (provider === "s3" || provider === "azure_blob") {
    return provider;
  }
  throw new Error(`Unsupported STORAGE_PROVIDER "${provider}".`);
}

function azureBlobStorageAuthMode(env: NodeJS.ProcessEnv): AzureBlobStorageAuthMode {
  const mode = firstEnv(env, ["AZURE_STORAGE_AUTH_MODE"]) ?? "managed_identity";
  if (mode === "managed_identity" || mode === "connection_string") {
    return mode;
  }
  throw new Error(`Unsupported AZURE_STORAGE_AUTH_MODE "${mode}".`);
}

function parseConnectionString(connectionString: string | undefined) {
  const values = new Map<string, string>();
  for (const part of connectionString?.split(";") ?? []) {
    const match = part.match(/^([^=]+)=(.*)$/);
    if (match) values.set(match[1].toLowerCase(), match[2]);
  }
  return {
    accountName: values.get("accountname"),
    accountKey: values.get("accountkey"),
    blobEndpoint: values.get("blobendpoint"),
  };
}

export function resolveStorageRuntimeConfig(env: NodeJS.ProcessEnv = process.env): StorageRuntimeConfig {
  const bucket = firstEnv(env, [
    "R2_BUCKET_NAME",
    "S3_BUCKET_NAME",
    "AWS_S3_BUCKET_NAME",
    "RAILWAY_BUCKET_NAME",
    "BUCKET",
  ]) ?? "corgtex-local";
  const accountId = firstEnv(env, ["R2_ACCOUNT_ID"]);
  const accessKeyId = firstEnv(env, [
    "R2_ACCESS_KEY_ID",
    "S3_ACCESS_KEY_ID",
    "S3_ACCESS_KEY",
    "RAILWAY_BUCKET_ACCESS_KEY_ID",
    "ACCESS_KEY_ID",
  ]);
  const secretAccessKey = firstEnv(env, [
    "R2_SECRET_ACCESS_KEY",
    "S3_SECRET_ACCESS_KEY",
    "S3_SECRET_KEY",
    "RAILWAY_BUCKET_SECRET_ACCESS_KEY",
    "SECRET_ACCESS_KEY",
  ]);
  const explicitEndpoint = firstEnv(env, [
    "S3_ENDPOINT",
    "RAILWAY_BUCKET_ENDPOINT",
    "ENDPOINT",
  ]);
  const endpoint = explicitEndpoint || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  const region = firstEnv(env, [
    "S3_REGION",
    "AWS_REGION",
    "RAILWAY_BUCKET_REGION",
    "REGION",
  ]) ?? "auto";
  const usesAwsDefaultEndpoint = !endpoint && !accountId && Boolean(firstEnv(env, [
    "S3_BUCKET_NAME",
    "AWS_S3_BUCKET_NAME",
  ]));
  const missing = [];

  if (!bucket) missing.push("bucket");
  if (!endpoint && !usesAwsDefaultEndpoint) missing.push("endpoint");
  if (usesAwsDefaultEndpoint && region === "auto") missing.push("region");
  if (!accessKeyId) missing.push("accessKeyId");
  if (!secretAccessKey) missing.push("secretAccessKey");

  return {
    bucket,
    endpoint,
    region,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    forcePathStyle: !!env.S3_FORCE_PATH_STYLE,
    configured: missing.length === 0,
    missing,
  };
}

export function resolveStorageProviderName(env: NodeJS.ProcessEnv = process.env): StorageProviderName {
  return storageProviderName(env);
}

export function resolveAzureBlobStorageRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AzureBlobStorageRuntimeConfig {
  const authMode = azureBlobStorageAuthMode(env);
  const connectionString = firstEnv(env, ["AZURE_STORAGE_CONNECTION_STRING"]);
  const parsedConnectionString = parseConnectionString(connectionString);
  const accountName = firstEnv(env, ["AZURE_STORAGE_ACCOUNT_NAME"]) ?? parsedConnectionString.accountName;
  const accountKey = parsedConnectionString.accountKey;
  const containerName = firstEnv(env, ["AZURE_STORAGE_CONTAINER_NAME"]) ?? "";
  const endpoint = firstEnv(env, ["AZURE_STORAGE_BLOB_ENDPOINT"])
    ?? parsedConnectionString.blobEndpoint
    ?? (accountName ? `https://${accountName}.blob.core.windows.net` : undefined);
  const managedIdentityClientId = firstEnv(env, ["AZURE_STORAGE_CLIENT_ID", "AZURE_CLIENT_ID"]);
  const missing = [];

  if (!containerName) missing.push("containerName");
  if (authMode === "managed_identity") {
    if (!accountName) missing.push("accountName");
    if (!endpoint) missing.push("endpoint");
  } else {
    if (!connectionString) missing.push("connectionString");
    if (!accountName) missing.push("connectionStringAccountName");
    if (!accountKey) missing.push("connectionStringAccountKey");
  }

  return {
    accountName,
    containerName,
    endpoint,
    authMode,
    connectionString,
    accountKey,
    managedIdentityClientId,
    configured: missing.length === 0,
    missing,
  };
}

function ensureConfigured(configured: boolean, missing: string[], operation: string) {
  if (!configured) {
    throw new Error(`StorageProvider: cannot ${operation}; storage is not configured (${missing.join(", ")} missing).`);
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream | null | undefined) {
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  private configured: boolean;
  private missing: string[];

  constructor(config = resolveStorageRuntimeConfig()) {
    this.bucket = config.bucket;
    this.configured = config.configured;
    this.missing = config.missing;

    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: config.credentials,
      forcePathStyle: config.forcePathStyle, // Useful for MinIO
    });
  }

  private ensureConfigured(operation: string) {
    ensureConfigured(this.configured, this.missing, operation);
  }

  async put(key: string, data: Buffer, opts?: { contentType?: string }) {
    this.ensureConfigured("upload");

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: opts?.contentType,
      })
    );
    return { key, size: data.byteLength };
  }

  async get(key: string) {
    this.ensureConfigured("read");

    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );

      const arrayBuffer = await result.Body?.transformToByteArray();
      if (!arrayBuffer) return null;

      return {
        data: Buffer.from(arrayBuffer),
        contentType: result.ContentType,
      };
    } catch {
      return null;
    }
  }

  async getSignedUrl(key: string, expiresInSec = 3600) {
    this.ensureConfigured("sign URL");

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getS3SignedUrl(this.client, command, { expiresIn: expiresInSec });
  }

  async delete(key: string) {
    this.ensureConfigured("delete");

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }
}

export class AzureBlobStorageProvider implements StorageProvider {
  private serviceClient: BlobServiceClient;
  private containerName: string;
  private accountName?: string;
  private configured: boolean;
  private missing: string[];
  private sharedKeyCredential?: StorageSharedKeyCredential;

  constructor(config = resolveAzureBlobStorageRuntimeConfig()) {
    this.containerName = config.containerName;
    this.accountName = config.accountName;
    this.configured = config.configured;
    this.missing = config.missing;

    if (config.authMode === "connection_string" && config.connectionString) {
      this.serviceClient = BlobServiceClient.fromConnectionString(config.connectionString);
      if (config.accountName && config.accountKey) {
        this.sharedKeyCredential = new StorageSharedKeyCredential(config.accountName, config.accountKey);
      }
      return;
    }

    const credential = new DefaultAzureCredential({
      managedIdentityClientId: config.managedIdentityClientId,
    });
    const endpoint = config.endpoint ?? "https://missing-account.blob.core.windows.net";
    this.serviceClient = new BlobServiceClient(endpoint, credential);
  }

  private ensureConfigured(operation: string) {
    ensureConfigured(this.configured, this.missing, operation);
  }

  private containerClient() {
    return this.serviceClient.getContainerClient(this.containerName);
  }

  async put(key: string, data: Buffer, opts?: { contentType?: string }) {
    this.ensureConfigured("upload");

    const blob = this.containerClient().getBlockBlobClient(key);
    await blob.uploadData(data, {
      blobHTTPHeaders: {
        blobContentType: opts?.contentType,
      },
    });
    return { key, size: data.byteLength };
  }

  async get(key: string) {
    this.ensureConfigured("read");

    try {
      const result = await this.containerClient().getBlobClient(key).download();
      const data = await streamToBuffer(result.readableStreamBody);
      if (!data) return null;

      return {
        data,
        contentType: result.contentType,
      };
    } catch {
      return null;
    }
  }

  async getSignedUrl(key: string, expiresInSec = 3600) {
    this.ensureConfigured("sign URL");

    const startsOn = new Date(Date.now() - 5 * 60 * 1000);
    const expiresOn = new Date(Date.now() + expiresInSec * 1000);
    const sasOptions = {
      containerName: this.containerName,
      blobName: key,
      permissions: BlobSASPermissions.parse("r"),
      startsOn,
      expiresOn,
    };
    const sas = this.sharedKeyCredential
      ? generateBlobSASQueryParameters(sasOptions, this.sharedKeyCredential)
      : generateBlobSASQueryParameters(
        sasOptions,
        await this.serviceClient.getUserDelegationKey(startsOn, expiresOn),
        this.accountName ?? "",
      );

    return `${this.containerClient().getBlobClient(key).url}?${sas.toString()}`;
  }

  async delete(key: string) {
    this.ensureConfigured("delete");

    await this.containerClient().getBlobClient(key).deleteIfExists();
  }
}

export function createDefaultStorageProvider(env: NodeJS.ProcessEnv = process.env): StorageProvider {
  return resolveStorageProviderName(env) === "azure_blob"
    ? new AzureBlobStorageProvider(resolveAzureBlobStorageRuntimeConfig(env))
    : new S3StorageProvider(resolveStorageRuntimeConfig(env));
}

export const defaultStorage = createDefaultStorageProvider();
