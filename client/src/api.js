const jsonHeaders = {
  "Content-Type": "application/json",
};

export async function getHealth() {
  return request("/api/health");
}

export async function getConfig() {
  return request("/api/config");
}

export async function validateConfig() {
  const response = await fetch("/api/config/validate", { method: "POST" });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 400 && payload?.checks) {
    return payload;
  }
  if (!response.ok) {
    throw toApiError(payload, response.status);
  }
  return payload;
}

export async function listFiles(parentId = undefined) {
  const query = parentId === undefined ? "" : `?parentId=${encodeURIComponent(parentId || "")}`;
  return request(`/api/files${query}`);
}

export async function createFolder({ name, parentId }) {
  return request("/api/files/folders", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name, parentId }),
  });
}

export function uploadFile({ file, storageClass, parentId, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files/upload");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-Storage-Class", storageClass);
    if (parentId) {
      xhr.setRequestHeader("X-Parent-Id", parentId);
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };

    xhr.onload = () => {
      const payload = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      reject(toApiError(payload, xhr.status));
    };

    xhr.onerror = () => {
      reject(new Error("Upload failed before the server responded."));
    };

    xhr.send(file);
  });
}

export async function requestRestore(fileId, { days, tier }) {
  return request(`/api/files/${fileId}/restore`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ days, tier }),
  });
}

export async function checkRestore(fileId) {
  return request(`/api/files/${fileId}/check-restore`, { method: "POST" });
}

export async function getDownloadUrl(fileId) {
  return request(`/api/files/${fileId}/download`);
}

export async function changeStorageClass(fileId, storageClass) {
  return request(`/api/files/${fileId}/storage-class`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ storageClass }),
  });
}

export async function moveFilesToFolder({ fileIds, parentId }) {
  return request("/api/files/move", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ fileIds, parentId }),
  });
}

export async function deleteFile(fileId) {
  return request(`/api/files/${fileId}`, { method: "DELETE" });
}

export async function deleteFolder(folderId) {
  try {
    return await request(`/api/files/folders/${folderId}`, { method: "DELETE" });
  } catch (error) {
    if (error.status === 404 && /API route was not found/i.test(error.message)) {
      error.message = "Folder delete API was not found. Restart the local backend so it loads the latest routes.";
    }
    throw error;
  }
}

export async function exportManifest() {
  return request("/api/manifests/export", { method: "POST" });
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw toApiError(payload, response.status);
  }
  return payload;
}

function toApiError(payload, status) {
  const message = payload?.error?.message || payload?.message || `Request failed with status ${status}.`;
  const error = new Error(message);
  error.status = status;
  error.details = payload?.error?.details;
  return error;
}

function parseJson(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
