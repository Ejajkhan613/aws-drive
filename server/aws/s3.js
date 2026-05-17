import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  RestoreObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { getConfig } from "../config.js";

let cachedClient;
let cachedClientKey;

export function getS3Client(config = getConfig({ strict: true })) {
  const clientKey = JSON.stringify({
    region: config.aws.region,
    accessKeyId: config.aws.accessKeyId,
    hasSecret: Boolean(config.aws.secretAccessKey),
    hasSession: Boolean(config.aws.sessionToken),
  });

  if (cachedClient && cachedClientKey === clientKey) {
    return cachedClient;
  }

  const clientOptions = {
    region: config.aws.region,
  };

  if (config.aws.accessKeyId && config.aws.secretAccessKey) {
    clientOptions.credentials = {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
      sessionToken: config.aws.sessionToken || undefined,
    };
  }

  cachedClient = new S3Client(clientOptions);
  cachedClientKey = clientKey;
  return cachedClient;
}

export function buildObjectKey(fileId, fileName, config = getConfig()) {
  return `${config.s3.prefix}files/${fileId}/${sanitizeKeySegment(fileName)}`;
}

export async function validateS3Access() {
  const config = getConfig({ strict: true });
  const s3 = getS3Client(config);

  await s3.send(new ListObjectsV2Command({
    Bucket: config.s3.bucket,
    Prefix: config.s3.prefix,
    MaxKeys: 1,
  }));

  return {
    bucket: config.s3.bucket,
    prefix: config.s3.prefix,
    region: config.aws.region,
  };
}

export async function uploadObjectStream({
  key,
  body,
  contentLength,
  contentType,
  storageClass,
  originalName,
}) {
  const config = getConfig({ strict: true });
  const s3 = getS3Client(config);

  return s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: body,
    ContentLength: contentLength,
    ContentType: contentType || "application/octet-stream",
    StorageClass: storageClass,
    Metadata: {
      original_name: encodeURIComponent(originalName || ""),
    },
    ...encryptionOptions(config),
  }));
}

export async function headObject(key) {
  const config = getConfig({ strict: true });
  const s3 = getS3Client(config);
  return s3.send(new HeadObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
  }));
}

export async function requestObjectRestore(key, { days, tier }) {
  const config = getConfig({ strict: true });
  const s3 = getS3Client(config);

  return s3.send(new RestoreObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    RestoreRequest: {
      Days: days,
      GlacierJobParameters: {
        Tier: tier,
      },
    },
  }));
}

export async function createDownloadUrl(file) {
  const config = getConfig({ strict: true });
  const s3 = getS3Client(config);

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: file.s3Key,
      ResponseContentDisposition: contentDisposition(file.name),
    }),
    { expiresIn: config.app.presignedUrlExpiresSeconds },
  );
}

export async function deleteObject(key) {
  const config = getConfig({ strict: true });
  const s3 = getS3Client(config);
  return s3.send(new DeleteObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
  }));
}

export async function copyObjectToStorageClass(key, storageClass) {
  const config = getConfig({ strict: true });
  const s3 = getS3Client(config);

  return s3.send(new CopyObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    CopySource: copySource(config.s3.bucket, key),
    MetadataDirective: "COPY",
    TaggingDirective: "COPY",
    StorageClass: storageClass,
    ...encryptionOptions(config),
  }));
}

export async function uploadJsonObject(key, value) {
  const config = getConfig({ strict: true });
  const s3 = getS3Client(config);

  return s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: `${JSON.stringify(value, null, 2)}\n`,
    ContentType: "application/json",
    ...encryptionOptions(config),
  }));
}

export function parseRestoreHeader(restoreHeader) {
  if (!restoreHeader) {
    return {
      restoreStatus: "not_restored",
      restoreExpiresAt: null,
      ongoing: false,
    };
  }

  if (/ongoing-request="true"/i.test(restoreHeader)) {
    return {
      restoreStatus: "restore_requested",
      restoreExpiresAt: null,
      ongoing: true,
    };
  }

  const expiryMatch = restoreHeader.match(/expiry-date="([^"]+)"/i);
  return {
    restoreStatus: "restored",
    restoreExpiresAt: expiryMatch ? new Date(expiryMatch[1]).toISOString() : null,
    ongoing: false,
  };
}

export function isS3NotFoundError(error) {
  return error?.name === "NoSuchKey"
    || error?.name === "NotFound"
    || error?.$metadata?.httpStatusCode === 404;
}

export function isRestoreAlreadyInProgress(error) {
  return error?.name === "RestoreAlreadyInProgress";
}

export function isObjectAlreadyRestored(error) {
  return error?.name === "ObjectAlreadyInActiveTierError";
}

function sanitizeKeySegment(value) {
  const cleaned = String(value || "file")
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .trim();

  return cleaned || "file";
}

function contentDisposition(fileName) {
  const fallback = String(fileName || "download")
    .replace(/["\\\r\n]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName || "download")}`;
}

function copySource(bucket, key) {
  return `${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

function encryptionOptions(config) {
  const options = {};
  if (config.s3.serverSideEncryption) {
    options.ServerSideEncryption = config.s3.serverSideEncryption;
  }
  if (config.s3.kmsKeyId) {
    options.SSEKMSKeyId = config.s3.kmsKeyId;
  }
  return options;
}
