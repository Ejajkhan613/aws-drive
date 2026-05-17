import path from "node:path";

import { Router } from "express";

import { getConfig } from "../config.js";
import { uploadJsonObject } from "../aws/s3.js";
import { asyncHandler } from "../http/async-handler.js";
import { appendEvent, listFiles, listFolders, writeLocalManifest } from "../metadata/store.js";

export function createManifestsRouter() {
  const router = Router();

  router.post("/export", asyncHandler(async (req, res) => {
    const config = getConfig({ strict: true });
    const now = new Date();
    const fileName = `archive-manifest-${formatDateForFile(now)}.json`;
    const s3Key = `${config.s3.prefix}manifests/${fileName}`;

    const manifest = {
      version: 1,
      generatedAt: now.toISOString(),
      bucket: config.s3.bucket,
      prefix: config.s3.prefix,
      files: await listFiles(),
      folders: await listFolders(),
    };

    const localPath = await writeLocalManifest(fileName, manifest);
    await uploadJsonObject(s3Key, manifest);
    await appendEvent({
      type: "manifest_exported",
      s3Key,
      localPath,
    });

    res.status(201).json({
      manifest: {
        fileName,
        localPath: path.resolve(localPath),
        s3Key,
        fileCount: manifest.files.length,
        folderCount: manifest.folders.length,
        generatedAt: manifest.generatedAt,
      },
    });
  }));

  return router;
}

function formatDateForFile(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}
