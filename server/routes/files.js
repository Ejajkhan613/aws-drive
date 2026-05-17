import { randomUUID, createHash } from "node:crypto";
import { Transform } from "node:stream";

import express, { Router } from "express";

import { getConfig, requireRestoreTier, requireStorageClass } from "../config.js";
import {
  buildObjectKey,
  copyObjectToStorageClass,
  createDownloadUrl,
  deleteObject,
  isObjectAlreadyRestored,
  isRestoreAlreadyInProgress,
  requestObjectRestore,
  uploadObjectStream,
} from "../aws/s3.js";
import { asyncHandler } from "../http/async-handler.js";
import { badRequest, conflict, payloadTooLarge } from "../http/errors.js";
import {
  addFile,
  addFolder,
  appendEvent,
  getFile,
  getFolderDeletePlan,
  listFiles,
  listFolders,
  markFileDeleted,
  markFolderTreeDeleted,
  moveFiles,
  updateFile,
} from "../metadata/store.js";
import { refreshRestoreState } from "../restore/poller.js";

export function createFilesRouter() {
  const router = Router();

  router.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/upload") {
      next();
      return;
    }

    express.json({ limit: "1mb" })(req, res, next);
  });

  router.get("/", asyncHandler(async (req, res) => {
    const parentId = req.query.parentId === undefined ? undefined : String(req.query.parentId || "") || null;
    const files = await listFiles({ parentId });
    const folders = await listFolders({ parentId });
    res.json({ files, folders });
  }));

  router.post("/folders", asyncHandler(async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      throw badRequest("Folder name is required.");
    }

    const folder = await addFolder({
      name,
      parentId: req.body?.parentId || null,
    });

    res.status(201).json({ folder });
  }));

  router.post("/upload", asyncHandler(async (req, res) => {
    const config = getConfig({ strict: true });
    const name = decodeHeaderValue(readHeader(req, "x-file-name"));
    if (!name) {
      throw badRequest("Missing x-file-name header.");
    }

    const contentLength = parseContentLength(req);
    if (config.app.maxUploadBytes > 0 && contentLength > config.app.maxUploadBytes) {
      throw payloadTooLarge("Upload exceeds MAX_UPLOAD_BYTES.", {
        maxUploadBytes: config.app.maxUploadBytes,
        contentLength,
      });
    }

    const storageClass = requireStorageClass(
      readHeader(req, "x-storage-class") || config.s3.defaultStorageClass,
    );
    const parentId = readHeader(req, "x-parent-id") || null;
    const contentType = req.headers["content-type"] || "application/octet-stream";
    const id = randomUUID();
    const s3Key = buildObjectKey(id, name, config);
    const checksum = createHash("sha256");

    const hashingStream = new Transform({
      transform(chunk, encoding, callback) {
        checksum.update(chunk);
        callback(null, chunk);
      },
    });

    req.on("aborted", () => {
      hashingStream.destroy(new Error("Upload was aborted by the client."));
    });
    req.on("error", (error) => {
      hashingStream.destroy(error);
    });
    req.pipe(hashingStream);

    const uploadResult = await uploadObjectStream({
      key: s3Key,
      body: hashingStream,
      contentLength,
      contentType,
      storageClass,
      originalName: name,
    });

    const now = new Date().toISOString();
    const file = await addFile({
      id,
      parentId,
      name,
      s3Key,
      sizeBytes: contentLength,
      mimeType: contentType,
      storageClass,
      checksumSha256: checksum.digest("hex"),
      etag: normalizeEtag(uploadResult.ETag),
      restoreStatus: storageClass === "GLACIER_IR" ? "not_required" : "not_restored",
      restoreRequestedAt: null,
      restoreExpiresAt: null,
      lastKnownS3Status: "found",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    res.status(201).json({ file });
  }));

  router.post("/move", asyncHandler(async (req, res) => {
    const fileIds = Array.isArray(req.body?.fileIds)
      ? req.body.fileIds.map((fileId) => String(fileId || "").trim()).filter(Boolean)
      : [];
    const parentId = req.body?.parentId ? String(req.body.parentId).trim() : null;

    if (fileIds.length === 0) {
      throw badRequest("At least one file ID is required.");
    }

    if (fileIds.length > 500) {
      throw badRequest("Move at most 500 files at a time.");
    }

    const movedFiles = await moveFiles(fileIds, parentId);
    res.json({ files: movedFiles });
  }));

  const deleteFolderTree = asyncHandler(async (req, res) => {
    const plan = await getFolderDeletePlan(req.params.folderId);

    for (const file of plan.files) {
      await deleteObject(file.s3Key);
    }

    const deleted = await markFolderTreeDeleted(req.params.folderId);
    res.json({
      folder: plan.folder,
      deleted: {
        folderCount: deleted.folders.length,
        fileCount: deleted.files.length,
        totalBytes: plan.totalBytes,
      },
    });
  });

  router.delete("/folders/:folderId", deleteFolderTree);
  router.delete("/folder/:folderId", deleteFolderTree);

  router.get("/:fileId", asyncHandler(async (req, res) => {
    const file = await getFile(req.params.fileId);
    res.json({ file });
  }));

  router.post("/:fileId/restore", asyncHandler(async (req, res) => {
    const config = getConfig({ strict: true });
    const file = await getFile(req.params.fileId);

    if (file.storageClass === "GLACIER_IR") {
      const updated = await updateFile(file.id, () => ({
        restoreStatus: "not_required",
        restoreExpiresAt: null,
      }));
      res.json({ file: updated, message: "This storage class does not require restore." });
      return;
    }

    const days = parseRestoreDays(req.body?.days, config.s3.restoreDays);
    const tier = requireRestoreTier(req.body?.tier || config.s3.restoreTier);

    try {
      await requestObjectRestore(file.s3Key, { days, tier });
    } catch (error) {
      if (!isRestoreAlreadyInProgress(error) && !isObjectAlreadyRestored(error)) {
        throw error;
      }
    }

    const updated = await updateFile(file.id, () => ({
      restoreStatus: "restore_requested",
      restoreRequestedAt: new Date().toISOString(),
      restoreExpiresAt: null,
      lastKnownS3Status: "found",
    }), {
      type: "restore_requested",
      days,
      tier,
    });

    res.status(202).json({ file: updated });
  }));

  router.post("/:fileId/check-restore", asyncHandler(async (req, res) => {
    const file = await getFile(req.params.fileId);
    const updated = await refreshRestoreState(file);
    res.json({ file: updated });
  }));

  router.get("/:fileId/download", asyncHandler(async (req, res) => {
    let file = await getFile(req.params.fileId);

    if (file.storageClass !== "GLACIER_IR" && file.restoreStatus !== "restored") {
      file = await refreshRestoreState(file);
    }

    if (file.storageClass !== "GLACIER_IR" && file.restoreStatus !== "restored") {
      throw conflict("File must be restored before it can be downloaded.", {
        restoreStatus: file.restoreStatus,
      });
    }

    const url = await createDownloadUrl(file);
    const config = getConfig({ strict: true });
    res.json({
      url,
      expiresIn: config.app.presignedUrlExpiresSeconds,
      restoreExpiresAt: file.restoreExpiresAt,
    });
  }));

  router.post("/:fileId/storage-class", asyncHandler(async (req, res) => {
    let file = await getFile(req.params.fileId);
    const targetStorageClass = requireStorageClass(req.body?.storageClass);

    if (file.storageClass === targetStorageClass) {
      res.json({ file });
      return;
    }

    if (file.storageClass !== "GLACIER_IR" && file.restoreStatus !== "restored") {
      file = await refreshRestoreState(file);
      if (file.restoreStatus !== "restored") {
        throw conflict("Archived files must be restored before changing storage class.", {
          restoreStatus: file.restoreStatus,
        });
      }
    }

    await copyObjectToStorageClass(file.s3Key, targetStorageClass);

    const updated = await updateFile(file.id, () => ({
      storageClass: targetStorageClass,
      restoreStatus: targetStorageClass === "GLACIER_IR" ? "not_required" : "not_restored",
      restoreRequestedAt: null,
      restoreExpiresAt: null,
      lastKnownS3Status: "found",
    }), {
      type: "storage_class_changed",
      from: file.storageClass,
      to: targetStorageClass,
    });

    res.json({ file: updated });
  }));

  router.delete("/:fileId", asyncHandler(async (req, res) => {
    const file = await getFile(req.params.fileId);
    await deleteObject(file.s3Key);
    const deleted = await markFileDeleted(file.id);
    res.json({ file: deleted });
  }));

  return router;
}

function readHeader(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value ? String(value).trim() : "";
}

function decodeHeaderValue(value) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseContentLength(req) {
  const value = Number(req.headers["content-length"]);
  if (!Number.isInteger(value) || value < 0) {
    throw badRequest("Upload requires a valid Content-Length header.");
  }

  return value;
}

function parseRestoreDays(value, fallback) {
  const days = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(days) || days < 1) {
    throw badRequest("Restore days must be a positive integer.");
  }

  return days;
}

function normalizeEtag(etag) {
  return etag ? String(etag).replace(/^"|"$/g, "") : null;
}
