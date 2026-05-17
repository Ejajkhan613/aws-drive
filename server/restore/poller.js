import { getConfig } from "../config.js";
import { appendEvent, listFiles, updateFile } from "../metadata/store.js";
import { headObject, isS3NotFoundError, parseRestoreHeader } from "../aws/s3.js";

let pollTimer;
let isPolling = false;

export function startRestorePoller() {
  const config = getConfig();
  const intervalMs = config.s3.pollIntervalMs;

  pollRestoreRequests().catch((error) => {
    console.warn("Initial restore poll failed:", error.message);
  });

  pollTimer = setInterval(() => {
    pollRestoreRequests().catch((error) => {
      console.warn("Restore poll failed:", error.message);
    });
  }, intervalMs);

  pollTimer.unref?.();
}

export function stopRestorePoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

export async function pollRestoreRequests() {
  if (isPolling) return;
  isPolling = true;

  try {
    const files = await listFiles();
    const pending = files.filter((file) => file.restoreStatus === "restore_requested");

    for (const file of pending) {
      try {
        await refreshRestoreState(file);
      } catch (error) {
        await appendEvent({
          type: "restore_poll_failed",
          fileId: file.id,
          message: error.message,
        });
      }
    }
  } finally {
    isPolling = false;
  }
}

export async function refreshRestoreState(file) {
  if (file.storageClass === "GLACIER_IR") {
    return updateFile(file.id, () => ({
      restoreStatus: "not_required",
      restoreExpiresAt: null,
      lastKnownS3Status: "found",
    }));
  }

  try {
    const head = await headObject(file.s3Key);
    const parsed = parseRestoreHeader(head.Restore);
    const updated = await updateFile(file.id, () => ({
      restoreStatus: parsed.restoreStatus,
      restoreExpiresAt: parsed.restoreExpiresAt,
      lastKnownS3Status: "found",
    }));

    if (updated.restoreStatus === "restored") {
      await appendEvent({
        type: "restore_completed",
        fileId: file.id,
        restoreExpiresAt: updated.restoreExpiresAt,
      });
    }

    return updated;
  } catch (error) {
    if (isS3NotFoundError(error)) {
      return updateFile(file.id, () => ({
        restoreStatus: "restore_failed",
        lastKnownS3Status: "missing",
      }), {
        type: "restore_failed",
        message: "S3 object was not found.",
      });
    }

    throw error;
  }
}
