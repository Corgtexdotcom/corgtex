import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";

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

function firstEnv(env: NodeJS.ProcessEnv, keys: string[]) {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
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
    if (!this.configured) {
      throw new Error(`StorageProvider: cannot ${operation}; storage is not configured (${this.missing.join(", ")} missing).`);
    }
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

// Simple export of the loaded provider. Can be swapped for local disk in the future based on ENV.
export const defaultStorage = new S3StorageProvider();
