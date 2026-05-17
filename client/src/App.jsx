import { useEffect, useMemo, useRef, useState } from "react";

import {
  changeStorageClass,
  checkRestore,
  createFolder,
  deleteFile,
  deleteFolder,
  exportManifest,
  getConfig,
  getDownloadUrl,
  listFiles,
  moveFilesToFolder,
  requestRestore,
  uploadFile,
  validateConfig,
} from "./api.js";
import { createZipFromFiles, getFolderSelectionSummary } from "./zip.js";

const STORAGE_CLASSES = [
  {
    value: "GLACIER_IR",
    label: "Instant Retrieval",
    shortLabel: "Instant",
    caption: "Immediate download",
  },
  {
    value: "GLACIER",
    label: "Flexible Retrieval",
    shortLabel: "Flexible",
    caption: "Restore first",
  },
  {
    value: "DEEP_ARCHIVE",
    label: "Deep Archive",
    shortLabel: "Deep Archive",
    caption: "Lowest storage cost",
  },
];

const RESTORE_TIERS = ["Bulk", "Standard", "Expedited"];

export default function App() {
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const [config, setConfig] = useState(null);
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [pathStack, setPathStack] = useState([]);
  const [selectedStorageClass, setSelectedStorageClass] = useState("DEEP_ARCHIVE");
  const [restoreDays, setRestoreDays] = useState(7);
  const [restoreTier, setRestoreTier] = useState("Bulk");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [selectedFileIds, setSelectedFileIds] = useState(() => new Set());
  const [folderName, setFolderName] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [navMode, setNavMode] = useState("drive");
  const [dragDepth, setDragDepth] = useState(0);
  const [draggedFileIds, setDraggedFileIds] = useState([]);
  const [dropTargetFolderId, setDropTargetFolderId] = useState("");
  const [uploading, setUploading] = useState(null);
  const [busyAction, setBusyAction] = useState("");
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [folderImportDialog, setFolderImportDialog] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const currentFolder = pathStack[pathStack.length - 1] || null;
  const currentParentId = currentFolder?.id || null;
  const hasConfigIssues = Boolean(config?.issues?.length);
  const isDragging = dragDepth > 0;
  const isMovingFiles = draggedFileIds.length > 0;
  const currentLocation = getViewTitle(navMode, currentFolder);
  const selectedFileIdList = useMemo(() => Array.from(selectedFileIds), [selectedFileIds]);

  const selectedSummary = useMemo(() => {
    const totalBytes = selectedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
    return {
      count: selectedFiles.length,
      totalBytes,
      totalLabel: formatBytes(totalBytes),
    };
  }, [selectedFiles]);

  const viewFolders = useMemo(() => {
    if (navMode !== "drive") return [];
    return filterBySearch(folders, searchTerm);
  }, [folders, searchTerm, navMode]);

  const viewFiles = useMemo(() => {
    const searched = filterBySearch(files, searchTerm);
    if (navMode === "recent") return sortByUpdatedAt(searched);
    if (navMode === "restores") {
      return searched.filter((file) => file.storageClass !== "GLACIER_IR" || file.restoreStatus === "restore_requested");
    }
    return searched;
  }, [files, searchTerm, navMode]);

  const storageSummary = useMemo(() => {
    const totalBytes = files.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0);
    return {
      totalBytes,
      totalLabel: formatBytes(totalBytes),
      fileCount: files.length,
      folderCount: folders.length,
    };
  }, [files, folders]);

  const visibleFileIds = useMemo(() => viewFiles.map((file) => file.id), [viewFiles]);
  const allVisibleFilesSelected = visibleFileIds.length > 0 && visibleFileIds.every((fileId) => selectedFileIds.has(fileId));

  useEffect(() => {
    refreshAll();
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timeoutId = window.setTimeout(() => {
      setNotice("");
    }, 3000);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  async function refreshAll() {
    await withUiState(async () => {
      const configPayload = await getConfig();
      setConfig(configPayload);
      setSelectedStorageClass(configPayload?.s3?.defaultStorageClass || "DEEP_ARCHIVE");
      setRestoreDays(configPayload?.s3?.restoreDays || 7);
      setRestoreTier(configPayload?.s3?.restoreTier || "Bulk");
      await refreshFiles(currentParentId);
    });
  }

  async function refreshFiles(parentId = currentParentId) {
    const payload = await listFiles(parentId === null ? "" : parentId);
    setFiles(payload.files || []);
    setFolders(payload.folders || []);
    const nextFileIds = new Set((payload.files || []).map((file) => file.id));
    setSelectedFileIds((current) => new Set(Array.from(current).filter((fileId) => nextFileIds.has(fileId))));
  }

  async function handleValidateConfig() {
    await withUiState(async () => {
      const result = await validateConfig();
      setNotice(result.ok ? "AWS configuration is valid." : "Configuration needs attention.");
      setConfig(await getConfig());
    }, "Validating configuration");
  }

  async function handleCreateFolder(event) {
    event.preventDefault();
    const name = folderName.trim();
    if (!name) return;

    await withUiState(async () => {
      await createFolder({ name, parentId: currentParentId });
      setFolderName("");
      await refreshFiles(currentParentId);
      setNotice("Folder created.");
    }, "Creating folder");
  }

  function handleFileInputChange(event) {
    const nextFiles = Array.from(event.target.files || []);
    setSelectedFiles(nextFiles);
    event.target.value = "";
  }

  function handleFolderInputChange(event) {
    const summary = getFolderSelectionSummary(event.target.files);
    event.target.value = "";

    if (summary.files.length === 0) {
      setError("No files were found in the selected folder.");
      return;
    }

    setFolderImportDialog(summary);
  }

  async function handleUpload(event) {
    event?.preventDefault();
    await startUpload(selectedFiles);
  }

  async function startUpload(filesToUpload) {
    if (uploading) return;
    if (filesToUpload.length === 0) {
      setError("No files selected.");
      return;
    }

    setError("");
    setNotice("");

    for (let index = 0; index < filesToUpload.length; index += 1) {
      const file = filesToUpload[index];
      setUploading({
        name: file.name,
        index: index + 1,
        total: filesToUpload.length,
        progress: 0,
        sizeLabel: formatBytes(file.size),
      });

      try {
        await uploadFile({
          file,
          storageClass: selectedStorageClass,
          parentId: currentParentId,
          onProgress: (progress) => {
            setUploading({
              name: file.name,
              index: index + 1,
              total: filesToUpload.length,
              progress,
              sizeLabel: formatBytes(file.size),
            });
          },
        });
      } catch (uploadError) {
        setError(uploadError.message);
        setUploading(null);
        return;
      }
    }

    setSelectedFiles([]);
    setUploading(null);
    setNotice("Upload complete.");
    await refreshFiles(currentParentId);
  }

  async function uploadFolderAsTree() {
    const summary = folderImportDialog;
    if (!summary) return;
    setFolderImportDialog(null);
    setError("");
    setNotice("");

    try {
      const folderIdsByPath = new Map();
      const sortedFiles = [...summary.files].sort((left, right) => {
        return (left.webkitRelativePath || left.relativePath || left.name).localeCompare(
          right.webkitRelativePath || right.relativePath || right.name,
        );
      });

      for (let index = 0; index < sortedFiles.length; index += 1) {
        const file = sortedFiles[index];
        const relativePath = file.webkitRelativePath || file.relativePath || `${summary.folderName}/${file.name}`;
        const pathParts = relativePath.split(/[\\/]/).filter(Boolean);
        const directoryParts = pathParts.slice(0, -1);
        const parentId = await ensureFolderPath(directoryParts, folderIdsByPath);

        setUploading({
          name: relativePath,
          index: index + 1,
          total: sortedFiles.length,
          progress: 0,
          sizeLabel: formatBytes(file.size),
        });

        await uploadFile({
          file,
          storageClass: selectedStorageClass,
          parentId,
          onProgress: (progress) => {
            setUploading({
              name: relativePath,
              index: index + 1,
              total: sortedFiles.length,
              progress,
              sizeLabel: formatBytes(file.size),
            });
          },
        });
      }

      setUploading(null);
      setNotice("Folder upload complete.");
      await refreshFiles(currentParentId);
    } catch (uploadError) {
      setUploading(null);
      setError(formatError(uploadError));
    }
  }

  async function uploadFolderAsZip() {
    const summary = folderImportDialog;
    if (!summary) return;
    setFolderImportDialog(null);

    await withUiState(async () => {
      const zipFile = await createZipFromFiles(summary.files, summary.folderName);
      await startUpload([zipFile]);
    }, `Preparing ${summary.folderName}.zip`);
  }

  async function ensureFolderPath(directoryParts, folderIdsByPath) {
    let parentId = currentParentId;
    let pathSoFar = "";

    for (const folderNamePart of directoryParts) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${folderNamePart}` : folderNamePart;
      if (folderIdsByPath.has(pathSoFar)) {
        parentId = folderIdsByPath.get(pathSoFar);
        continue;
      }

      const payload = await createFolder({
        name: folderNamePart,
        parentId,
      });
      parentId = payload.folder.id;
      folderIdsByPath.set(pathSoFar, parentId);
    }

    return parentId;
  }

  function handleDragEnter(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragDepth((depth) => depth + 1);
  }

  function handleDragOver(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragDepth((depth) => Math.max(0, depth - 1));
  }

  async function handleDrop(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragDepth(0);

    const { files: droppedFiles, hasDirectory } = await getDroppedFiles(event.dataTransfer);
    if (droppedFiles.length === 0) return;

    if (hasDirectory) {
      setFolderImportDialog(getFolderSelectionSummary(droppedFiles));
      return;
    }

    setSelectedFiles(droppedFiles);
    await startUpload(droppedFiles);
  }

  function toggleFileSelection(fileId) {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  }

  function toggleVisibleFileSelection() {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (allVisibleFilesSelected) {
        for (const fileId of visibleFileIds) next.delete(fileId);
      } else {
        for (const fileId of visibleFileIds) next.add(fileId);
      }
      return next;
    });
  }

  function clearFileSelection() {
    setSelectedFileIds(new Set());
  }

  function handleFileDragStart(event, file) {
    const idsToMove = selectedFileIds.has(file.id) ? selectedFileIdList : [file.id];
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-glacier-file-ids", JSON.stringify(idsToMove));
    event.dataTransfer.setData("text/plain", idsToMove.join(","));
    setSelectedFileIds(new Set(idsToMove));
    setDraggedFileIds(idsToMove);
  }

  function handleFileDragEnd() {
    setDraggedFileIds([]);
    setDropTargetFolderId("");
  }

  function handleFolderDragOver(event, folderId) {
    if (!hasInternalFileMove(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetFolderId(folderId);
  }

  function handleFolderDragLeave(folderId) {
    setDropTargetFolderId((current) => (current === folderId ? "" : current));
  }

  async function handleFolderDrop(event, folder) {
    if (!hasInternalFileMove(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTargetFolderId("");

    const fileIds = parseDraggedFileIds(event);
    if (fileIds.length === 0) return;
    await moveSelectedFiles(folder.id, fileIds);
  }

  function handleBreadcrumbDragOver(event, targetId) {
    if (!hasInternalFileMove(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetFolderId(targetId || "__root");
  }

  async function handleBreadcrumbDrop(event, targetId) {
    if (!hasInternalFileMove(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTargetFolderId("");

    const fileIds = parseDraggedFileIds(event);
    if (fileIds.length === 0) return;
    await moveSelectedFiles(targetId || null, fileIds);
  }

  async function moveSelectedFiles(parentId, fileIds = selectedFileIdList) {
    if (fileIds.length === 0) return;

    await withUiState(async () => {
      await moveFilesToFolder({ fileIds, parentId });
      setSelectedFileIds(new Set());
      setDraggedFileIds([]);
      await refreshFiles(currentParentId);
      setNotice(`${fileIds.length} file${fileIds.length === 1 ? "" : "s"} moved.`);
    }, `Moving ${fileIds.length} file${fileIds.length === 1 ? "" : "s"}`);
  }

  async function handleRestore(file) {
    await withUiState(async () => {
      await requestRestore(file.id, {
        days: restoreDays,
        tier: restoreTier,
      });
      await refreshFiles(currentParentId);
      setNotice("Restore request submitted.");
    }, `Requesting restore for ${file.name}`);
  }

  async function handleCheckRestore(file) {
    await withUiState(async () => {
      await checkRestore(file.id);
      await refreshFiles(currentParentId);
      setNotice("Restore status refreshed.");
    }, `Checking ${file.name}`);
  }

  async function handleDownload(file) {
    await withUiState(async () => {
      const payload = await getDownloadUrl(file.id);
      window.location.assign(payload.url);
      setNotice("Download link created.");
    }, `Preparing download for ${file.name}`);
  }

  async function handleStorageClassChange(file, storageClass) {
    await withUiState(async () => {
      await changeStorageClass(file.id, storageClass);
      await refreshFiles(currentParentId);
      setNotice("Storage class updated.");
    }, `Changing storage class for ${file.name}`);
  }

  function handleDelete(file) {
    setConfirmDialog({
      title: "Delete file?",
      eyebrow: "Permanent delete",
      name: file.name,
      message: "This removes the file from S3 and from the local index. Glacier minimum storage duration charges may still apply.",
      confirmLabel: "Delete file",
      onConfirm: async () => {
        await withUiState(async () => {
          await deleteFile(file.id);
          setSelectedFileIds((current) => {
            const next = new Set(current);
            next.delete(file.id);
            return next;
          });
          await refreshFiles(currentParentId);
          setNotice("File deleted.");
        }, `Deleting ${file.name}`);
      },
    });
  }

  function handleDeleteFolder(folder) {
    setConfirmDialog({
      title: "Delete folder?",
      eyebrow: "Recursive delete",
      name: folder.name,
      message: "This deletes the folder, every subfolder, and every file inside it from S3 and the local index.",
      confirmLabel: "Delete folder",
      onConfirm: async () => {
        await withUiState(async () => {
          const payload = await deleteFolder(folder.id);
          await refreshFiles(currentParentId);
          setNotice(`Deleted ${payload.deleted.folderCount} folder${payload.deleted.folderCount === 1 ? "" : "s"} and ${payload.deleted.fileCount} file${payload.deleted.fileCount === 1 ? "" : "s"}.`);
        }, `Deleting ${folder.name}`);
      },
    });
  }

  function handleDeleteSelectedFiles() {
    const filesToDelete = files.filter((file) => selectedFileIds.has(file.id));
    if (filesToDelete.length === 0) return;

    setConfirmDialog({
      title: "Delete selected files?",
      eyebrow: "Bulk delete",
      name: `${filesToDelete.length} file${filesToDelete.length === 1 ? "" : "s"}`,
      message: "This removes every selected file from S3 and from the local index. Glacier minimum storage duration charges may still apply.",
      confirmLabel: "Delete selected",
      onConfirm: async () => {
        await withUiState(async () => {
          for (const file of filesToDelete) {
            await deleteFile(file.id);
          }
          setSelectedFileIds(new Set());
          await refreshFiles(currentParentId);
          setNotice(`${filesToDelete.length} file${filesToDelete.length === 1 ? "" : "s"} deleted.`);
        }, `Deleting ${filesToDelete.length} file${filesToDelete.length === 1 ? "" : "s"}`);
      },
    });
  }

  async function confirmDelete() {
    const dialog = confirmDialog;
    if (!dialog) return;
    setConfirmDialog(null);
    await dialog.onConfirm();
  }

  async function handleExportManifest() {
    await withUiState(async () => {
      const payload = await exportManifest();
      setNotice(`Manifest exported to ${payload.manifest.s3Key}.`);
    }, "Exporting manifest");
  }

  async function withUiState(action, busyMessage = "") {
    setError("");
    setNotice("");
    setBusyAction(busyMessage);
    try {
      await action();
    } catch (actionError) {
      setError(formatError(actionError));
    } finally {
      setBusyAction("");
    }
  }

  function openFolder(folder) {
    setNavMode("drive");
    setSelectedFileIds(new Set());
    setPathStack((current) => [...current, folder]);
    refreshFiles(folder.id).catch((folderError) => setError(formatError(folderError)));
  }

  function goToBreadcrumb(index) {
    setNavMode("drive");
    setSelectedFileIds(new Set());
    const nextStack = index < 0 ? [] : pathStack.slice(0, index + 1);
    setPathStack(nextStack);
    const parentId = nextStack[nextStack.length - 1]?.id || null;
    refreshFiles(parentId).catch((folderError) => setError(formatError(folderError)));
  }

  return (
    <main className="drive-shell">
      <header className="drive-topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            G
          </div>
          <div>
            <h1>Glacier Drive</h1>
            <span>{config?.s3?.bucket || "Local vault"}</span>
          </div>
        </div>

        <label className="search-box">
          <span aria-hidden="true">Search</span>
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search files and folders"
          />
        </label>

        <div className="topbar-actions">
          <button type="button" className="toolbar-button" onClick={refreshAll}>
            Refresh
          </button>
          <button type="button" className="toolbar-button primary" onClick={handleValidateConfig}>
            Validate
          </button>
        </div>
      </header>

      <div className="drive-layout">
        <aside className="drive-sidebar">
          <section className="upload-panel">
            <label className="new-button" title="Choose files to upload">
              <input ref={fileInputRef} type="file" multiple onChange={handleFileInputChange} />
              <strong>New</strong>
            </label>
            <input
              ref={folderInputRef}
              className="folder-picker-input"
              type="file"
              multiple
              webkitdirectory=""
              directory=""
              onChange={handleFolderInputChange}
            />

            <div className="sidebar-field">
              <label htmlFor="sidebar-storage-class">Storage class</label>
              <select
                id="sidebar-storage-class"
                value={selectedStorageClass}
                onChange={(event) => setSelectedStorageClass(event.target.value)}
              >
                {STORAGE_CLASSES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              className="upload-now-button"
              disabled={Boolean(busyAction || uploading || selectedFiles.length === 0)}
              onClick={handleUpload}
            >
              Upload
            </button>
            <button type="button" className="folder-upload-button" onClick={() => folderInputRef.current?.click()}>
              Upload Folder
            </button>
          </section>

          <nav className="drive-nav" aria-label="Drive sections">
            <button
              type="button"
              className={navMode === "drive" ? "active" : ""}
              onClick={() => goToBreadcrumb(-1)}
            >
              <span aria-hidden="true">D</span>
              <strong>My Drive</strong>
            </button>
            <button
              type="button"
              className={navMode === "recent" ? "active" : ""}
              onClick={() => setNavMode("recent")}
            >
              <span aria-hidden="true">R</span>
              <strong>Recent</strong>
            </button>
            <button
              type="button"
              className={navMode === "restores" ? "active" : ""}
              onClick={() => setNavMode("restores")}
            >
              <span aria-hidden="true">A</span>
              <strong>Archive</strong>
            </button>
          </nav>

          <section className="sidebar-section">
            <div className="sidebar-section-title">
              <h2>Storage</h2>
              <span>{storageSummary.totalLabel}</span>
            </div>
            <div className="storage-meter">
              <span style={{ width: `${storageMeterWidth(storageSummary.totalBytes)}%` }} />
            </div>
            <div className="storage-split">
              <span>{storageSummary.fileCount} files</span>
              <span>{storageSummary.folderCount} folders</span>
            </div>
          </section>

          <section className="sidebar-section compact-controls">
            <div className="sidebar-section-title">
              <h2>Restore</h2>
              <span>{restoreTier}</span>
            </div>
            <div className="two-field-grid">
              <label>
                Days
                <input
                  type="number"
                  min="1"
                  value={restoreDays}
                  onChange={(event) => setRestoreDays(Number(event.target.value))}
                />
              </label>
              <label>
                Tier
                <select value={restoreTier} onChange={(event) => setRestoreTier(event.target.value)}>
                  {RESTORE_TIERS.map((tier) => (
                    <option key={tier} value={tier}>
                      {tier}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <button type="button" className="sidebar-action" onClick={handleExportManifest} disabled={Boolean(busyAction)}>
            Export Manifest
          </button>

          <section className={`sidebar-status ${hasConfigIssues ? "warning" : "ready"}`}>
            <div>
              <strong>{hasConfigIssues ? "Setup required" : "AWS connected"}</strong>
              <span>{configStatusText(config)}</span>
            </div>
            <div className="sidebar-status-metrics">
              <span>{storageSummary.fileCount} files</span>
              <span>{storageSummary.totalLabel}</span>
            </div>
          </section>
        </aside>

        <section
          className={`drive-main ${isDragging ? "drag-active" : ""}`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <section className="workspace-panel">
            <header className="content-header">
              <div className="breadcrumb">
                <button
                  type="button"
                  className={dropTargetFolderId === "__root" ? "drop-target" : ""}
                  onClick={() => goToBreadcrumb(-1)}
                  onDragOver={(event) => handleBreadcrumbDragOver(event, null)}
                  onDragLeave={() => handleFolderDragLeave("__root")}
                  onDrop={(event) => handleBreadcrumbDrop(event, null)}
                >
                  My Drive
                </button>
                {pathStack.map((folder, index) => (
                  <button
                    key={folder.id}
                    type="button"
                    className={dropTargetFolderId === folder.id ? "drop-target" : ""}
                    onClick={() => goToBreadcrumb(index)}
                    onDragOver={(event) => handleBreadcrumbDragOver(event, folder.id)}
                    onDragLeave={() => handleFolderDragLeave(folder.id)}
                    onDrop={(event) => handleBreadcrumbDrop(event, folder.id)}
                  >
                    {folder.name}
                  </button>
                ))}
              </div>

              <form className="folder-create" onSubmit={handleCreateFolder}>
                <input
                  type="text"
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                  placeholder="Folder name"
                />
                <button type="submit" disabled={Boolean(busyAction || !folderName.trim())}>
                  New Folder
                </button>
              </form>
            </header>

            <section className={`drop-zone ${isDragging ? "active" : ""}`}>
              <div className="drop-copy">
                <strong>{selectedSummary.count ? `${selectedSummary.count} selected` : "Drop files"}</strong>
                <span>{selectedSummary.count ? selectedSummary.totalLabel : getStorageOption(selectedStorageClass).caption}</span>
              </div>

              <div className="drop-actions">
                <select
                  value={selectedStorageClass}
                  onChange={(event) => setSelectedStorageClass(event.target.value)}
                  aria-label="Upload storage class"
                >
                  {STORAGE_CLASSES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.shortLabel}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => fileInputRef.current?.click()}>
                  Browse
                </button>
                <button type="button" onClick={() => folderInputRef.current?.click()}>
                  Folder
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={Boolean(busyAction || uploading || selectedFiles.length === 0)}
                  onClick={handleUpload}
                >
                  Upload
                </button>
              </div>

              {selectedFiles.length > 0 && (
                <div className="selected-file-list">
                  {selectedFiles.slice(0, 4).map((file) => (
                    <span key={`${file.name}-${file.size}-${file.lastModified}`}>
                      <strong>{file.name}</strong>
                      <em>{formatBytes(file.size)}</em>
                    </span>
                  ))}
                  {selectedFiles.length > 4 && <span>{selectedFiles.length - 4} more</span>}
                </div>
              )}
            </section>

            <div className="view-title">
              <div>
                <h2>{currentLocation}</h2>
                {selectedFileIdList.length > 0 ? (
                  <span>{selectedFileIdList.length} selected / drag onto a folder to move</span>
                ) : (
                  <span>{searchTerm ? "Search results" : `${viewFolders.length + viewFiles.length} items`}</span>
                )}
              </div>
              <div className="view-chips">
                {selectedFileIdList.length > 0 ? (
                  <>
                    {currentParentId && (
                      <button type="button" onClick={() => moveSelectedFiles(null)}>
                        Move to My Drive
                      </button>
                    )}
                    <button type="button" className="danger-inline" onClick={handleDeleteSelectedFiles}>
                      Delete
                    </button>
                    <button type="button" onClick={clearFileSelection}>
                      Clear
                    </button>
                  </>
                ) : (
                  <>
                    <span>{getStorageOption(selectedStorageClass).shortLabel}</span>
                    <span>{restoreTier}</span>
                  </>
                )}
              </div>
            </div>

            <div className="file-table">
              <div className="table-header">
                <label className="select-cell">
                  <input
                    type="checkbox"
                    checked={allVisibleFilesSelected}
                    onChange={toggleVisibleFileSelection}
                    disabled={visibleFileIds.length === 0}
                    aria-label="Select all visible files"
                  />
                </label>
                <span>Name</span>
                <span>Storage</span>
                <span>Status</span>
                <span>Size</span>
                <span>Actions</span>
              </div>

              <div className="file-list">
                {viewFolders.map((folder) => (
                  <div
                    className={`file-row folder-row ${dropTargetFolderId === folder.id ? "drop-target" : ""}`}
                    key={folder.id}
                    onDragOver={(event) => handleFolderDragOver(event, folder.id)}
                    onDragLeave={() => handleFolderDragLeave(folder.id)}
                    onDrop={(event) => handleFolderDrop(event, folder)}
                  >
                    <span className="select-cell folder-drop-hint">{isMovingFiles ? "Drop" : ""}</span>
                    <button type="button" className="name-cell folder-name" onClick={() => openFolder(folder)}>
                      <span className="file-icon folder-icon" aria-hidden="true" />
                      <span>{folder.name}</span>
                    </button>
                    <span className="muted-cell">Folder</span>
                    <span className="status-pill ready">Ready</span>
                    <span className="muted-cell">-</span>
                    <span className="row-actions">
                      <button type="button" onClick={() => openFolder(folder)}>
                        Open
                      </button>
                      <button type="button" className="danger-button" onClick={() => handleDeleteFolder(folder)}>
                        Delete
                      </button>
                    </span>
                  </div>
                ))}

                {viewFiles.map((file) => (
                  <FileRow
                    key={file.id}
                    file={file}
                    selected={selectedFileIds.has(file.id)}
                    onSelect={() => toggleFileSelection(file.id)}
                    onDragStart={(event) => handleFileDragStart(event, file)}
                    onDragEnd={handleFileDragEnd}
                    onRestore={handleRestore}
                    onCheckRestore={handleCheckRestore}
                    onDownload={handleDownload}
                    onStorageClassChange={handleStorageClassChange}
                    onDelete={handleDelete}
                    busy={Boolean(busyAction)}
                  />
                ))}

                {viewFolders.length === 0 && viewFiles.length === 0 && (
                  <div className="empty-state">
                    <strong>{searchTerm ? "No matches" : "No items"}</strong>
                    <span>{emptyStateText(navMode, searchTerm)}</span>
                  </div>
                )}
              </div>
            </div>
          </section>
        </section>
      </div>

      {confirmDialog && (
        <ConfirmDialog
          dialog={confirmDialog}
          busy={Boolean(busyAction)}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={confirmDelete}
        />
      )}

      {folderImportDialog && (
        <FolderImportDialog
          summary={folderImportDialog}
          busy={Boolean(busyAction || uploading)}
          onCancel={() => setFolderImportDialog(null)}
          onUploadTree={uploadFolderAsTree}
          onUploadZip={uploadFolderAsZip}
        />
      )}

      {(busyAction || error || notice) && (
        <aside className="toast-stack" aria-live="polite">
          {busyAction && <span className="toast-popup busy">{busyAction}</span>}
          {error && <span className="toast-popup error">{error}</span>}
          {notice && <span className="toast-popup notice">{notice}</span>}
        </aside>
      )}

      {uploading && (
        <aside className="upload-dock" aria-live="polite">
          <div>
            <strong>{uploading.name}</strong>
            <span>
              {uploading.index} of {uploading.total} / {uploading.sizeLabel}
            </span>
          </div>
          <progress value={uploading.progress} max="100" />
          <span>{uploading.progress}%</span>
        </aside>
      )}
    </main>
  );
}

function ConfirmDialog({ dialog, busy, onCancel, onConfirm }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <span>{dialog.eyebrow}</span>
        <h2 id="confirm-title">{dialog.title}</h2>
        <strong>{dialog.name}</strong>
        <p>{dialog.message}</p>
        <div className="confirm-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="danger-confirm" onClick={onConfirm} disabled={busy}>
            {dialog.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function FolderImportDialog({ summary, busy, onCancel, onUploadTree, onUploadZip }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="folder-import-modal" role="dialog" aria-modal="true" aria-labelledby="folder-import-title">
        <span>Folder upload</span>
        <h2 id="folder-import-title">{summary.folderName}</h2>
        <p>
          {summary.fileCount} file{summary.fileCount === 1 ? "" : "s"} / {formatBytes(summary.totalBytes)}
        </p>
        <div className="folder-import-options">
          <button type="button" onClick={onUploadTree} disabled={busy}>
            <strong>Keep folder structure</strong>
            <span>Create folders and upload child files as they are.</span>
          </button>
          <button type="button" onClick={onUploadZip} disabled={busy}>
            <strong>Convert to ZIP</strong>
            <span>Package the folder into one archive before upload.</span>
          </button>
        </div>
        <div className="confirm-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

function FileRow({
  file,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
  onRestore,
  onCheckRestore,
  onDownload,
  onStorageClassChange,
  onDelete,
  busy,
}) {
  const canDownload = file.storageClass === "GLACIER_IR" || file.restoreStatus === "restored";
  const needsRestore = file.storageClass !== "GLACIER_IR" && file.restoreStatus !== "restored";

  return (
    <div
      className={`file-row file-item-row ${selected ? "selected" : ""}`}
      draggable={!busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <label className="select-cell" draggable={false}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          onDragStart={(event) => event.preventDefault()}
          aria-label={`Select ${file.name}`}
        />
      </label>
      <div className="name-cell">
        <span className="file-icon file-doc-icon" aria-hidden="true" />
        <div>
          <strong>{file.name}</strong>
          <span>{file.s3Key}</span>
        </div>
      </div>
      <select
        value={file.storageClass}
        onChange={(event) => onStorageClassChange(file, event.target.value)}
        disabled={busy}
        title="Change storage class"
      >
        {STORAGE_CLASSES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.shortLabel}
          </option>
        ))}
      </select>
      <span className={`status-pill ${file.restoreStatus}`}>{formatRestoreStatus(file)}</span>
      <span className="muted-cell">{formatBytes(file.sizeBytes)}</span>
      <div className="row-actions">
        {canDownload && (
          <button type="button" onClick={() => onDownload(file)} disabled={busy}>
            Download
          </button>
        )}
        {needsRestore && (
          <button type="button" onClick={() => onRestore(file)} disabled={busy}>
            Restore
          </button>
        )}
        {file.storageClass !== "GLACIER_IR" && (
          <button type="button" onClick={() => onCheckRestore(file)} disabled={busy}>
            Check
          </button>
        )}
        <button type="button" className="danger-button" onClick={() => onDelete(file)} disabled={busy}>
          Delete
        </button>
      </div>
    </div>
  );
}

function getStorageOption(value) {
  return STORAGE_CLASSES.find((option) => option.value === value) || STORAGE_CLASSES[2];
}

function configStatusText(config) {
  if (!config) return "Checking local backend.";
  if (config.issues?.length) return `${config.issues.length} setting${config.issues.length === 1 ? "" : "s"} missing or invalid.`;
  return `${config.aws.region} / ${config.s3.prefix} / ${config.s3.defaultStorageClass}`;
}

function formatRestoreStatus(file) {
  if (file.storageClass === "GLACIER_IR") return "Instant";
  if (file.restoreStatus === "not_restored") return "Restore needed";
  if (file.restoreStatus === "restore_requested") return "Restoring";
  if (file.restoreStatus === "restored") {
    return file.restoreExpiresAt ? `Restored until ${formatDate(file.restoreExpiresAt)}` : "Restored";
  }
  if (file.restoreStatus === "restore_expired") return "Expired";
  if (file.restoreStatus === "restore_failed") return "Failed";
  return file.restoreStatus || "Unknown";
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatError(error) {
  if (!error?.details) return error?.message || "Something went wrong.";
  if (Array.isArray(error.details)) {
    return `${error.message} ${error.details.map((detail) => `${detail.field}: ${detail.message}`).join(" ")}`;
  }
  return error.message;
}

function filterBySearch(items, searchTerm) {
  const query = searchTerm.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) => {
    const haystack = `${item.name || ""} ${item.s3Key || ""} ${item.storageClass || ""}`.toLowerCase();
    return haystack.includes(query);
  });
}

function storageMeterWidth(bytes) {
  if (!bytes) return 4;
  const oneTb = 1024 ** 4;
  return Math.max(4, Math.min(100, (bytes / oneTb) * 100));
}

function sortByUpdatedAt(items) {
  return [...items].sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

function emptyStateText(navMode, searchTerm) {
  if (searchTerm) return "No file or folder matched this search.";
  if (navMode === "recent") return "Recent files will appear here.";
  if (navMode === "restores") return "Archived files will appear here.";
  return "This folder is empty.";
}

function getViewTitle(navMode, currentFolder) {
  if (navMode === "recent") return "Recent";
  if (navMode === "restores") return "Archive";
  return currentFolder?.name || "My Drive";
}

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

async function getDroppedFiles(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const entries = items
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);

  if (entries.length === 0) {
    return {
      files: Array.from(dataTransfer?.files || []),
      hasDirectory: false,
    };
  }

  const files = [];
  let hasDirectory = false;

  for (const entry of entries) {
    if (entry.isDirectory) hasDirectory = true;
    files.push(...await readDroppedEntry(entry, ""));
  }

  return { files, hasDirectory };
}

async function readDroppedEntry(entry, parentPath) {
  if (entry.isFile) {
    const file = await getFileFromEntry(entry);
    return [withRelativePath(file, `${parentPath}${file.name}`)];
  }

  if (!entry.isDirectory) return [];

  const directoryPath = `${parentPath}${entry.name}/`;
  const reader = entry.createReader();
  const childEntries = await readAllDirectoryEntries(reader);
  const files = [];

  for (const childEntry of childEntries) {
    files.push(...await readDroppedEntry(childEntry, directoryPath));
  }

  return files;
}

function readAllDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const entries = [];

    function readBatch() {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readBatch();
      }, reject);
    }

    readBatch();
  });
}

function getFileFromEntry(entry) {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function withRelativePath(file, relativePath) {
  try {
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: relativePath,
    });
  } catch {
    file.relativePath = relativePath;
  }
  return file;
}

function hasInternalFileMove(event) {
  return Array.from(event.dataTransfer?.types || []).includes("application/x-glacier-file-ids");
}

function parseDraggedFileIds(event) {
  try {
    const rawValue = event.dataTransfer.getData("application/x-glacier-file-ids");
    const parsed = JSON.parse(rawValue || "[]");
    return Array.isArray(parsed) ? parsed.map((fileId) => String(fileId)).filter(Boolean) : [];
  } catch {
    return [];
  }
}
