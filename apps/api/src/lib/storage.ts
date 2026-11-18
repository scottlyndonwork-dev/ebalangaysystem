import { randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../env.js';

/** private = documents (signed URLs only); public = images behind the CDN. */
export type BucketKind = 'private' | 'public';

export interface PresignedUpload {
  key: string;
  url: string;
  method: 'PUT';
  /** The client must send exactly these headers; they are part of the signature. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObject {
  size: number;
  contentType: string | null;
}

export interface Storage {
  /** Signed PUT for one object; Content-Type and Content-Length are bound into the signature. */
  presignUpload(input: {
    bucket: BucketKind;
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds?: number;
  }): Promise<PresignedUpload>;
  /** Short-lived signed GET for a private object. */
  presignDownload(
    key: string,
    expiresInSeconds?: number,
  ): Promise<{ url: string; expiresAt: Date }>;
  /** Null when the object doesn't exist (e.g. the client never finished uploading). */
  head(bucket: BucketKind, key: string): Promise<StoredObject | null>;
  put(bucket: BucketKind, key: string, body: Buffer, contentType: string): Promise<void>;
  publicUrl(key: string): string;
}

const UPLOAD_TTL = 600;
const DOWNLOAD_TTL = 300;

/** `merchants/{id}/documents/{uuid}.pdf` — never derived from the client's file name. */
export function objectKey(prefix: string, extension: string): string {
  return `${prefix}/${randomUUID()}.${extension}`;
}

export function createStorage(env: Env): Storage {
  return env.STORAGE_DRIVER === 'r2'
    ? new R2Storage(env)
    : new MemoryStorage(env.R2_PUBLIC_BASE_URL);
}

class R2Storage implements Storage {
  private readonly s3: S3Client;
  private readonly buckets: Record<BucketKind, string>;

  constructor(private readonly env: Env) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
      },
    });
    this.buckets = { private: env.R2_PRIVATE_BUCKET, public: env.R2_PUBLIC_BUCKET };
  }

  async presignUpload({
    bucket,
    key,
    contentType,
    contentLength,
    expiresInSeconds = UPLOAD_TTL,
  }: Parameters<Storage['presignUpload']>[0]): Promise<PresignedUpload> {
    const cmd = new PutObjectCommand({
      Bucket: this.buckets[bucket],
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    });
    const url = await getSignedUrl(this.s3, cmd, {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      key,
      url,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(contentLength) },
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  async presignDownload(key: string, expiresInSeconds = DOWNLOAD_TTL) {
    const cmd = new GetObjectCommand({ Bucket: this.buckets.private, Key: key });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: expiresInSeconds });
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }

  async head(bucket: BucketKind, key: string): Promise<StoredObject | null> {
    try {
      const res = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.buckets[bucket], Key: key }),
      );
      return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async put(bucket: BucketKind, key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.buckets[bucket],
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  publicUrl(key: string): string {
    return `${this.env.R2_PUBLIC_BASE_URL}/${key}`;
  }
}

/** Dev/tests: objects live in memory; "uploads" go through `put` instead of the signed URL. */
export class MemoryStorage implements Storage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  constructor(private readonly publicBase = 'https://cdn.test') {}

  async presignUpload({
    bucket,
    key,
    contentType,
    contentLength,
    expiresInSeconds = UPLOAD_TTL,
  }: Parameters<Storage['presignUpload']>[0]): Promise<PresignedUpload> {
    return {
      key,
      url: `memory://${bucket}/${key}`,
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(contentLength) },
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  async presignDownload(key: string, expiresInSeconds = DOWNLOAD_TTL) {
    return {
      url: `memory://private/${key}`,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  async head(bucket: BucketKind, key: string): Promise<StoredObject | null> {
    const o = this.objects.get(`${bucket}/${key}`);
    return o ? { size: o.body.length, contentType: o.contentType } : null;
  }

  async put(bucket: BucketKind, key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(`${bucket}/${key}`, { body, contentType });
  }

  publicUrl(key: string): string {
    return `${this.publicBase}/${key}`;
  }
}
