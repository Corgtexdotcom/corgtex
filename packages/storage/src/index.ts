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

export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = process.env.R2_BUCKET_NAME || process.env.S3_BUCKET_NAME || "corgtex-local";

    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY;
    const endpoint = process.env.S3_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
    const region = process.env.S3_REGION || "auto";

    if (!endpoint && process.env.NODE_ENV === "production") {
      console.warn("StorageProvider: Missing S3/R2 endpoint. Uploads will fail.");
    }

    this.client = new S3Client({
      region,
      endpoint,
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
      forcePathStyle: !!process.env.S3_FORCE_PATH_STYLE, // Useful for MinIO
    });
  }

  async put(key: string, data: Buffer, opts?: { contentType?: string }) {
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
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getS3SignedUrl(this.client, command, { expiresIn: expiresInSec });
  }

  async delete(key: string) {
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
