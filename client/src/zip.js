const textEncoder = new TextEncoder();
const crcTable = createCrcTable();

export async function createZipFromFiles(files, zipName) {
  const normalizedFiles = files
    .map((file) => ({
      file,
      path: normalizeZipPath(file.webkitRelativePath || file.relativePath || file.name),
    }))
    .filter((entry) => entry.path && !entry.path.endsWith("/"));

  if (normalizedFiles.length === 0) {
    throw new Error("No files were found in the selected folder.");
  }

  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (const entry of normalizedFiles) {
    const data = new Uint8Array(await entry.file.arrayBuffer());
    const nameBytes = textEncoder.encode(entry.path);
    const crc = crc32(data);
    const { dosTime, dosDate } = getDosDateTime(entry.file.lastModified || Date.now());

    assertZip32Size(data.byteLength, entry.path);
    assertZip32Size(offset, entry.path);

    const localHeader = createLocalFileHeader({
      nameBytes,
      crc,
      size: data.byteLength,
      dosTime,
      dosDate,
    });

    chunks.push(localHeader, data);

    centralDirectory.push({
      nameBytes,
      crc,
      size: data.byteLength,
      dosTime,
      dosDate,
      offset,
    });

    offset += localHeader.byteLength + data.byteLength;
  }

  const centralDirectoryStart = offset;

  for (const entry of centralDirectory) {
    const header = createCentralDirectoryHeader(entry);
    chunks.push(header);
    offset += header.byteLength;
  }

  const centralDirectorySize = offset - centralDirectoryStart;
  const endRecord = createEndOfCentralDirectoryRecord({
    recordCount: centralDirectory.length,
    centralDirectorySize,
    centralDirectoryStart,
  });
  chunks.push(endRecord);

  return new File(chunks, ensureZipName(zipName), { type: "application/zip" });
}

export function getFolderSelectionSummary(files) {
  const fileList = Array.from(files || []);
  const firstPath = fileList[0]?.webkitRelativePath || fileList[0]?.relativePath || "";
  const folderName = firstPath.split(/[\\/]/).filter(Boolean)[0] || "folder";
  const totalBytes = fileList.reduce((sum, file) => sum + Number(file.size || 0), 0);

  return {
    files: fileList,
    folderName,
    fileCount: fileList.length,
    totalBytes,
  };
}

function createLocalFileHeader({ nameBytes, crc, size, dosTime, dosDate }) {
  const header = new ArrayBuffer(30 + nameBytes.byteLength);
  const view = new DataView(header);
  let position = 0;

  position = writeUint32(view, position, 0x04034b50);
  position = writeUint16(view, position, 20);
  position = writeUint16(view, position, 0x0800);
  position = writeUint16(view, position, 0);
  position = writeUint16(view, position, dosTime);
  position = writeUint16(view, position, dosDate);
  position = writeUint32(view, position, crc);
  position = writeUint32(view, position, size);
  position = writeUint32(view, position, size);
  position = writeUint16(view, position, nameBytes.byteLength);
  position = writeUint16(view, position, 0);
  new Uint8Array(header, position).set(nameBytes);

  return new Uint8Array(header);
}

function createCentralDirectoryHeader({ nameBytes, crc, size, dosTime, dosDate, offset }) {
  const header = new ArrayBuffer(46 + nameBytes.byteLength);
  const view = new DataView(header);
  let position = 0;

  position = writeUint32(view, position, 0x02014b50);
  position = writeUint16(view, position, 20);
  position = writeUint16(view, position, 20);
  position = writeUint16(view, position, 0x0800);
  position = writeUint16(view, position, 0);
  position = writeUint16(view, position, dosTime);
  position = writeUint16(view, position, dosDate);
  position = writeUint32(view, position, crc);
  position = writeUint32(view, position, size);
  position = writeUint32(view, position, size);
  position = writeUint16(view, position, nameBytes.byteLength);
  position = writeUint16(view, position, 0);
  position = writeUint16(view, position, 0);
  position = writeUint16(view, position, 0);
  position = writeUint16(view, position, 0);
  position = writeUint32(view, position, 0);
  position = writeUint32(view, position, offset);
  new Uint8Array(header, position).set(nameBytes);

  return new Uint8Array(header);
}

function createEndOfCentralDirectoryRecord({ recordCount, centralDirectorySize, centralDirectoryStart }) {
  assertZip32Size(recordCount, "file count");
  assertZip32Size(centralDirectorySize, "central directory");
  assertZip32Size(centralDirectoryStart, "central directory offset");

  const header = new ArrayBuffer(22);
  const view = new DataView(header);
  let position = 0;

  position = writeUint32(view, position, 0x06054b50);
  position = writeUint16(view, position, 0);
  position = writeUint16(view, position, 0);
  position = writeUint16(view, position, recordCount);
  position = writeUint16(view, position, recordCount);
  position = writeUint32(view, position, centralDirectorySize);
  position = writeUint32(view, position, centralDirectoryStart);
  writeUint16(view, position, 0);

  return new Uint8Array(header);
}

function writeUint16(view, position, value) {
  view.setUint16(position, value, true);
  return position + 2;
}

function writeUint32(view, position, value) {
  view.setUint32(position, value >>> 0, true);
  return position + 4;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ data[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function getDosDateTime(timestamp) {
  const date = new Date(timestamp);
  const year = Math.max(1980, date.getFullYear());

  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function normalizeZipPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function ensureZipName(name) {
  const safeName = String(name || "archive").trim() || "archive";
  return safeName.toLowerCase().endsWith(".zip") ? safeName : `${safeName}.zip`;
}

function assertZip32Size(value, label) {
  if (value > 0xffffffff) {
    throw new Error(`Folder is too large for the built-in ZIP writer near ${label}.`);
  }
}
