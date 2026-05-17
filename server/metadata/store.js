import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getConfig } from "../config.js";
import { notFound } from "../http/errors.js";

const INDEX_FILE = "index.json";
const EVENTS_FILE = "events.jsonl";
const MANIFEST_DIR = "manifests";

const emptyIndex = () => ({
  version: 1,
  files: [],
  folders: [],
});

let queue = Promise.resolve();

export async function ensureDataStore() {
  const config = getConfig();
  await fs.mkdir(config.app.dataDir, { recursive: true });
  await fs.mkdir(path.join(config.app.dataDir, MANIFEST_DIR), { recursive: true });

  const indexPath = getIndexPath(config);
  try {
    await fs.access(indexPath);
  } catch {
    await writeJsonFile(indexPath, emptyIndex());
  }

  const eventsPath = getEventsPath(config);
  try {
    await fs.access(eventsPath);
  } catch {
    await fs.writeFile(eventsPath, "", "utf8");
  }
}

export async function readIndex() {
  await queue.catch(() => undefined);
  return readIndexUnsafe();
}

export async function listFiles({ includeDeleted = false, parentId = undefined } = {}) {
  const index = await readIndex();
  return index.files.filter((file) => {
    if (!includeDeleted && file.deletedAt) return false;
    if (parentId !== undefined && (file.parentId || null) !== parentId) return false;
    return true;
  });
}

export async function listFolders({ parentId = undefined } = {}) {
  const index = await readIndex();
  return index.folders.filter((folder) => {
    if (folder.deletedAt) return false;
    if (parentId !== undefined && (folder.parentId || null) !== parentId) return false;
    return true;
  });
}

export async function getFile(fileId, { includeDeleted = false } = {}) {
  const index = await readIndex();
  const file = index.files.find((candidate) => candidate.id === fileId);
  if (!file || (!includeDeleted && file.deletedAt)) {
    throw notFound("File was not found.", { fileId });
  }

  return file;
}

export async function getFolder(folderId, { includeDeleted = false } = {}) {
  const index = await readIndex();
  const folder = index.folders.find((candidate) => candidate.id === folderId);
  if (!folder || (!includeDeleted && folder.deletedAt)) {
    throw notFound("Folder was not found.", { folderId });
  }

  return folder;
}

export async function addFile(file) {
  const saved = await withIndex((index) => {
    index.files.push(file);
    return file;
  });

  await appendEvent({ type: "file_uploaded", fileId: saved.id, s3Key: saved.s3Key });
  return saved;
}

export async function updateFile(fileId, updater, event = undefined) {
  const updated = await withIndex((index) => {
    const file = index.files.find((candidate) => candidate.id === fileId);
    if (!file || file.deletedAt) {
      throw notFound("File was not found.", { fileId });
    }

    const patch = updater({ ...file });
    const nextFile = {
      ...file,
      ...(patch || {}),
      updatedAt: new Date().toISOString(),
    };

    const fileIndex = index.files.findIndex((candidate) => candidate.id === fileId);
    index.files[fileIndex] = nextFile;
    return nextFile;
  });

  if (event) {
    await appendEvent({ ...event, fileId });
  }

  return updated;
}

export async function markFileDeleted(fileId) {
  const deleted = await updateFile(
    fileId,
    () => ({ deletedAt: new Date().toISOString() }),
    { type: "file_deleted" },
  );
  return deleted;
}

export async function moveFiles(fileIds, parentId = null) {
  const uniqueFileIds = Array.from(new Set(fileIds));
  const now = new Date().toISOString();

  const movedFiles = await withIndex((index) => {
    if (parentId) {
      const targetFolder = index.folders.find((folder) => folder.id === parentId && !folder.deletedAt);
      if (!targetFolder) {
        throw notFound("Target folder was not found.", { folderId: parentId });
      }
    }

    const missingIds = uniqueFileIds.filter((fileId) => {
      const file = index.files.find((candidate) => candidate.id === fileId);
      return !file || file.deletedAt;
    });

    if (missingIds.length > 0) {
      throw notFound("One or more files were not found.", { fileIds: missingIds });
    }

    const moved = [];
    index.files = index.files.map((file) => {
      if (!uniqueFileIds.includes(file.id)) return file;
      const nextFile = {
        ...file,
        parentId,
        updatedAt: now,
      };
      moved.push(nextFile);
      return nextFile;
    });

    return moved;
  });

  await appendEvent({
    type: "files_moved",
    fileIds: uniqueFileIds,
    parentId,
  });

  return movedFiles;
}

export async function getFolderDeletePlan(folderId) {
  const index = await readIndex();
  const folder = index.folders.find((candidate) => candidate.id === folderId && !candidate.deletedAt);
  if (!folder) {
    throw notFound("Folder was not found.", { folderId });
  }

  const folderIds = collectDescendantFolderIds(index.folders, folderId);
  const folderIdSet = new Set(folderIds);
  const folders = index.folders.filter((candidate) => folderIdSet.has(candidate.id) && !candidate.deletedAt);
  const files = index.files.filter((file) => folderIdSet.has(file.parentId || null) && !file.deletedAt);

  return {
    folder,
    folderIds,
    folders,
    files,
    fileCount: files.length,
    folderCount: folders.length,
    totalBytes: files.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0),
  };
}

export async function markFolderTreeDeleted(folderId) {
  const now = new Date().toISOString();

  const deleted = await withIndex((index) => {
    const folder = index.folders.find((candidate) => candidate.id === folderId && !candidate.deletedAt);
    if (!folder) {
      throw notFound("Folder was not found.", { folderId });
    }

    const folderIds = collectDescendantFolderIds(index.folders, folderId);
    const folderIdSet = new Set(folderIds);
    const deletedFolders = [];
    const deletedFiles = [];

    index.folders = index.folders.map((candidate) => {
      if (!folderIdSet.has(candidate.id) || candidate.deletedAt) return candidate;
      const nextFolder = {
        ...candidate,
        updatedAt: now,
        deletedAt: now,
      };
      deletedFolders.push(nextFolder);
      return nextFolder;
    });

    index.files = index.files.map((file) => {
      if (!folderIdSet.has(file.parentId || null) || file.deletedAt) return file;
      const nextFile = {
        ...file,
        updatedAt: now,
        deletedAt: now,
      };
      deletedFiles.push(nextFile);
      return nextFile;
    });

    return {
      folders: deletedFolders,
      files: deletedFiles,
    };
  });

  await appendEvent({
    type: "folder_tree_deleted",
    folderId,
    folderIds: deleted.folders.map((folder) => folder.id),
    fileIds: deleted.files.map((file) => file.id),
  });

  return deleted;
}

export async function addFolder({ name, parentId = null }) {
  const now = new Date().toISOString();
  const folder = {
    id: randomUUID(),
    parentId,
    name,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const saved = await withIndex((index) => {
    index.folders.push(folder);
    return folder;
  });

  await appendEvent({ type: "folder_created", folderId: saved.id });
  return saved;
}

export async function appendEvent(event) {
  await ensureDataStore();
  const entry = {
    ...event,
    createdAt: event.createdAt || new Date().toISOString(),
  };
  await fs.appendFile(getEventsPath(getConfig()), `${JSON.stringify(entry)}\n`, "utf8");
}

export async function writeLocalManifest(fileName, manifest) {
  await ensureDataStore();
  const config = getConfig();
  const manifestPath = path.join(config.app.dataDir, MANIFEST_DIR, fileName);
  await writeJsonFile(manifestPath, manifest);
  return manifestPath;
}

async function withIndex(mutator) {
  const run = queue.then(async () => {
    await ensureDataStore();
    const index = await readIndexUnsafe();
    const result = await mutator(index);
    await writeIndexUnsafe(index);
    return result;
  });

  queue = run.catch(() => undefined);
  return run;
}

async function readIndexUnsafe() {
  await ensureDataStore();
  const content = await fs.readFile(getIndexPath(getConfig()), "utf8");
  return normalizeIndex(JSON.parse(content));
}

async function writeIndexUnsafe(index) {
  await writeJsonFile(getIndexPath(getConfig()), normalizeIndex(index));
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

function normalizeIndex(index) {
  return {
    version: 1,
    files: Array.isArray(index?.files) ? index.files : [],
    folders: Array.isArray(index?.folders) ? index.folders : [],
  };
}

function collectDescendantFolderIds(folders, rootFolderId) {
  const activeFolders = folders.filter((folder) => !folder.deletedAt);
  const folderIds = [rootFolderId];
  const queue = [rootFolderId];

  while (queue.length > 0) {
    const currentFolderId = queue.shift();
    const children = activeFolders.filter((folder) => (folder.parentId || null) === currentFolderId);
    for (const child of children) {
      folderIds.push(child.id);
      queue.push(child.id);
    }
  }

  return folderIds;
}

function getIndexPath(config) {
  return path.join(config.app.dataDir, INDEX_FILE);
}

function getEventsPath(config) {
  return path.join(config.app.dataDir, EVENTS_FILE);
}
