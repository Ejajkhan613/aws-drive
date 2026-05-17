import fs from "node:fs";
import path from "node:path";

import { badRequest, configError } from "./http/errors.js";

export const STORAGE_CLASSES = new Set(["GLACIER_IR", "GLACIER", "DEEP_ARCHIVE"]);
export const RESTORE_TIERS = new Set(["Expedited", "Standard", "Bulk"]);

loadEnvFile();

export function getConfig({ strict = false } = {}) {
  const port = numberFromEnv("PORT", 3000);
  const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || "./data");
  const defaultStorageClass = normalizeStorageClass(
    process.env.S3_DEFAULT_STORAGE_CLASS || "DEEP_ARCHIVE",
  );
  const restoreTier = normalizeRestoreTier(process.env.S3_RESTORE_TIER || "Bulk");

  const config = {
    app: {
      port,
      url: process.env.APP_URL || `http://localhost:${port}`,
      dataDir,
      maxUploadBytes: numberFromEnv("MAX_UPLOAD_BYTES", 0),
      presignedUrlExpiresSeconds: numberFromEnv("PRESIGNED_URL_EXPIRES_SECONDS", 900),
    },
    aws: {
      region: trimOrEmpty(process.env.AWS_REGION),
      accessKeyId: trimOrEmpty(process.env.AWS_ACCESS_KEY_ID),
      secretAccessKey: trimOrEmpty(process.env.AWS_SECRET_ACCESS_KEY),
      sessionToken: trimOrEmpty(process.env.AWS_SESSION_TOKEN),
    },
    s3: {
      bucket: trimOrEmpty(process.env.S3_BUCKET),
      prefix: normalizePrefix(process.env.S3_PREFIX || "drive/"),
      defaultStorageClass,
      restoreDays: numberFromEnv("S3_RESTORE_DAYS", 7),
      restoreTier,
      pollIntervalMs: numberFromEnv("RESTORE_POLL_INTERVAL_MS", 60000),
      serverSideEncryption: trimOrEmpty(process.env.S3_SERVER_SIDE_ENCRYPTION),
      kmsKeyId: trimOrEmpty(process.env.AWS_KMS_KEY_ID),
    },
  };

  const issues = getConfigIssues(config);
  if (strict && issues.length > 0) {
    throw configError("AWS/S3 configuration is incomplete or invalid.", issues);
  }

  return config;
}

export function getPublicConfig() {
  const config = getConfig();
  return {
    app: {
      url: config.app.url,
      dataDir: config.app.dataDir,
      maxUploadBytes: config.app.maxUploadBytes,
      presignedUrlExpiresSeconds: config.app.presignedUrlExpiresSeconds,
    },
    aws: {
      region: config.aws.region,
      hasAccessKeyId: Boolean(config.aws.accessKeyId),
      hasSecretAccessKey: Boolean(config.aws.secretAccessKey),
      hasSessionToken: Boolean(config.aws.sessionToken),
    },
    s3: {
      bucket: config.s3.bucket,
      prefix: config.s3.prefix,
      defaultStorageClass: config.s3.defaultStorageClass,
      restoreDays: config.s3.restoreDays,
      restoreTier: config.s3.restoreTier,
      pollIntervalMs: config.s3.pollIntervalMs,
      serverSideEncryption: config.s3.serverSideEncryption,
      hasKmsKeyId: Boolean(config.s3.kmsKeyId),
    },
    issues: getConfigIssues(config),
  };
}

export function getConfigIssues(config = getConfig()) {
  const issues = [];

  if (!config.aws.region) {
    issues.push({ field: "AWS_REGION", message: "AWS region is required." });
  }

  if (!config.s3.bucket) {
    issues.push({ field: "S3_BUCKET", message: "S3 bucket name is required." });
  }

  if (!STORAGE_CLASSES.has(config.s3.defaultStorageClass)) {
    issues.push({
      field: "S3_DEFAULT_STORAGE_CLASS",
      message: "Use GLACIER_IR, GLACIER, or DEEP_ARCHIVE.",
    });
  }

  if (!RESTORE_TIERS.has(config.s3.restoreTier)) {
    issues.push({
      field: "S3_RESTORE_TIER",
      message: "Use Expedited, Standard, or Bulk.",
    });
  }

  if (!Number.isInteger(config.s3.restoreDays) || config.s3.restoreDays < 1) {
    issues.push({ field: "S3_RESTORE_DAYS", message: "Restore days must be at least 1." });
  }

  if (!Number.isInteger(config.s3.pollIntervalMs) || config.s3.pollIntervalMs < 5000) {
    issues.push({
      field: "RESTORE_POLL_INTERVAL_MS",
      message: "Restore polling interval must be at least 5000 ms.",
    });
  }

  if (!Number.isInteger(config.app.port) || config.app.port < 1 || config.app.port > 65535) {
    issues.push({ field: "PORT", message: "Port must be between 1 and 65535." });
  }

  if (!Number.isInteger(config.app.presignedUrlExpiresSeconds)
    || config.app.presignedUrlExpiresSeconds < 60
    || config.app.presignedUrlExpiresSeconds > 604800) {
    issues.push({
      field: "PRESIGNED_URL_EXPIRES_SECONDS",
      message: "Presigned URL expiry must be between 60 and 604800 seconds.",
    });
  }

  return issues;
}

export function requireStorageClass(value) {
  const storageClass = normalizeStorageClass(value);
  if (!STORAGE_CLASSES.has(storageClass)) {
    throw badRequest("Invalid storage class.", {
      allowed: Array.from(STORAGE_CLASSES),
      received: value,
    });
  }

  return storageClass;
}

export function requireRestoreTier(value) {
  const tier = normalizeRestoreTier(value);
  if (!RESTORE_TIERS.has(tier)) {
    throw badRequest("Invalid restore tier.", {
      allowed: Array.from(RESTORE_TIERS),
      received: value,
    });
  }

  return tier;
}

function normalizeStorageClass(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeRestoreTier(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "expedited") return "Expedited";
  if (normalized === "standard") return "Standard";
  if (normalized === "bulk") return "Bulk";
  return String(value || "").trim();
}

function normalizePrefix(prefix) {
  const cleaned = String(prefix || "")
    .trim()
    .replace(/^\/+/, "");

  if (!cleaned) return "";
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimOrEmpty(value) {
  return String(value || "").trim();
}

function loadEnvFile() {
  const envFile = path.resolve(process.cwd(), process.env.ENV_FILE || ".env");
  if (!fs.existsSync(envFile)) return;

  const content = fs.readFileSync(envFile, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    if (!key || process.env[key] !== undefined) continue;

    process.env[key] = unquoteEnvValue(line.slice(equalsIndex + 1).trim());
  }
}

function unquoteEnvValue(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
}
