# AWS Glacier Drive

A local-first Google Drive-style archive app for storing files cheaply in Amazon S3 Glacier storage classes.

This project is not a SaaS. Users clone or download the repository, configure their own AWS S3 bucket and IAM credentials in `.env`, and run the app locally. The goal is long-term, low-cost storage for files that do not need frequent access.

## What It Does

- Stores files in your own private S3 bucket.
- Supports Amazon S3 Glacier storage classes:
  - S3 Glacier Instant Retrieval: `GLACIER_IR`
  - S3 Glacier Flexible Retrieval: `GLACIER`
  - S3 Glacier Deep Archive: `DEEP_ARCHIVE`
- Provides a Drive-like web UI with folders, uploads, deletes, restores, and downloads.
- Lets users choose the storage class before upload.
- Lets users move files into folders with drag and drop.
- Supports multi-select file actions.
- Supports folder upload:
  - keep the folder structure, or
  - convert the folder to a ZIP in the browser and upload it as one file.
- Stores app metadata locally in `data/index.json`.
- Records local events in `data/events.jsonl`.
- Can export a manifest locally and to S3.
- Uses minimal infrastructure: no database, Redis, queue, or SaaS dependency.

## Why This Exists

Google Drive-style tools are convenient, but long-term cold storage can become expensive when files are kept for years or decades. S3 Glacier storage classes are designed for archive data, but the AWS Console is not comfortable for normal file browsing.

AWS Glacier Drive gives you a simple local dashboard for your own AWS bucket while keeping the system small and easy to self-host locally.

## Storage Class Guide

| Dashboard option | `.env` value | Best for | Access behavior |
|---|---|---|---|
| Amazon S3 Glacier Instant Retrieval | `GLACIER_IR` | Archive files that may still need fast access | Download without restore |
| Amazon S3 Glacier Flexible Retrieval | `GLACIER` | Infrequently accessed archive files | Restore before download |
| Amazon S3 Glacier Deep Archive | `DEEP_ARCHIVE` | Lowest-cost long-term archive | Restore before download |

For the cheapest long-term storage, use `DEEP_ARCHIVE`. For files that may need quick access, use `GLACIER_IR`.

Always check current AWS pricing for your region before storing large amounts of data. Glacier classes can have restore fees, request fees, and minimum storage duration charges.

## Tech Stack

- Frontend: React + Vite
- Backend: Express.js
- Storage: Amazon S3 with Glacier storage classes
- Local metadata: JSON files in `data/`
- AWS SDK: `@aws-sdk/client-s3`
- No database, Redis, worker service, or external queue

## Project Structure

```txt
.
├── client/
│   └── src/
│       ├── App.jsx          # Main React dashboard
│       ├── api.js           # Frontend API client
│       ├── styles.css       # UI styles
│       └── zip.js           # Browser ZIP creation for folder uploads
├── server/
│   ├── aws/s3.js            # S3 upload, restore, download URL, delete helpers
│   ├── metadata/store.js    # Local JSON metadata store
│   ├── restore/poller.js    # Restore status polling
│   ├── routes/              # Express API routes
│   ├── config.js            # .env loading and validation
│   └── server.js            # Express app entry
├── scripts/dev.js           # Runs backend and Vite dev server together
├── AWS_SETUP.md             # Detailed S3 bucket and IAM setup guide
├── .env.example             # Environment template
├── package.json
└── vite.config.js
```

## Requirements

- Node.js 18 or newer
- npm
- An AWS account
- One private S3 bucket
- One IAM user or IAM credentials with access to only that bucket/prefix

Do not use AWS root access keys.

## Quick Start

Install dependencies:

```bash
npm install
```

Create your local environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` with your AWS and S3 values:

```env
PORT=3000

AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
AWS_SESSION_TOKEN=

S3_BUCKET=your-private-archive-bucket
S3_PREFIX=drive/
S3_DEFAULT_STORAGE_CLASS=DEEP_ARCHIVE

S3_RESTORE_DAYS=7
S3_RESTORE_TIER=Bulk
RESTORE_POLL_INTERVAL_MS=60000

S3_SERVER_SIDE_ENCRYPTION=AES256
AWS_KMS_KEY_ID=

DATA_DIR=./data
APP_URL=http://localhost:3000
PRESIGNED_URL_EXPIRES_SECONDS=900
MAX_UPLOAD_BYTES=0
```

Create the AWS resources by following:

```txt
AWS_SETUP.md
```

Run the app in development:

```bash
npm run dev
```

The development setup runs:

- Express backend on `http://localhost:3000`
- Vite frontend on `http://127.0.0.1:5173`
- Vite proxies `/api` calls to the backend

## Production-Style Local Run

Build the frontend:

```bash
npm run build
```

Start the Express server:

```bash
npm start
```

The Express server serves the built frontend from `dist/` and exposes the API under `/api`.

## Available Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start backend and Vite frontend for local development |
| `npm run build` | Build the React frontend into `dist/` |
| `npm start` | Start the Express server |
| `npm run serve` | Same as `npm start` |

## Environment Variables

| Variable | Required | Default | Description |
|---|---:|---|---|
| `PORT` | No | `3000` | Express server port |
| `AWS_REGION` | Yes | none | AWS region of the S3 bucket |
| `AWS_ACCESS_KEY_ID` | Yes | none | IAM access key ID |
| `AWS_SECRET_ACCESS_KEY` | Yes | none | IAM secret access key |
| `AWS_SESSION_TOKEN` | No | none | Temporary credential session token |
| `S3_BUCKET` | Yes | none | S3 bucket name |
| `S3_PREFIX` | No | `drive/` | Prefix used by this app inside the bucket |
| `S3_DEFAULT_STORAGE_CLASS` | No | `DEEP_ARCHIVE` | Default storage class for uploads |
| `S3_RESTORE_DAYS` | No | `7` | Number of days restored files remain available |
| `S3_RESTORE_TIER` | No | `Bulk` | Restore tier: `Bulk`, `Standard`, or `Expedited` |
| `RESTORE_POLL_INTERVAL_MS` | No | `60000` | Background restore status polling interval |
| `S3_SERVER_SIDE_ENCRYPTION` | No | none | Example: `AES256` or `aws:kms` |
| `AWS_KMS_KEY_ID` | No | none | KMS key ARN or ID when using SSE-KMS |
| `DATA_DIR` | No | `./data` | Local metadata directory |
| `APP_URL` | No | `http://localhost:3000` | App URL used by the server config |
| `PRESIGNED_URL_EXPIRES_SECONDS` | No | `900` | Download link expiry in seconds |
| `MAX_UPLOAD_BYTES` | No | `0` | Upload size limit. `0` means no app-level limit |

## AWS Setup

Read the full guide in [AWS_SETUP.md](AWS_SETUP.md).

At a high level, you need:

1. A private S3 bucket.
2. Block Public Access enabled.
3. Bucket versioning enabled.
4. Default encryption enabled.
5. A dedicated IAM user for this app.
6. A least-privilege IAM policy limited to your bucket and prefix.
7. The IAM access key values added to `.env`.

The app needs these S3 permissions for the configured prefix:

- `s3:ListBucket`
- `s3:PutObject`
- `s3:GetObject`
- `s3:DeleteObject`
- `s3:RestoreObject`

## How Files Are Stored

Uploaded file bytes are stored in S3 under:

```txt
{S3_PREFIX}/files/{file_id}/{sanitized_file_name}
```

Folder structure is stored locally in:

```txt
data/index.json
```

Events are appended to:

```txt
data/events.jsonl
```

Manifests are written locally under:

```txt
data/manifests/
```

and uploaded to:

```txt
{S3_PREFIX}/manifests/
```

Important: because folder metadata is local, you should back up the `data/` directory or export manifests regularly. The S3 bucket stores the file objects, but the local metadata is what gives the dashboard its Drive-like folders and file records.

## Restore And Download Flow

Files in `GLACIER_IR` can be downloaded immediately.

Files in `GLACIER` or `DEEP_ARCHIVE` must be restored before download:

1. Select the file.
2. Request restore.
3. Wait for AWS to complete the restore.
4. Click Check to refresh restore status.
5. Download using the generated presigned URL.

Restored files are temporarily available for the configured `S3_RESTORE_DAYS`. The object remains archived after the temporary restored copy expires.

## Local API

The backend exposes these main API routes:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check and public config |
| `GET` | `/api/config` | Read safe public config |
| `POST` | `/api/config/validate` | Validate `.env` and S3 prefix access |
| `GET` | `/api/files` | List files and folders |
| `POST` | `/api/files/folders` | Create folder |
| `DELETE` | `/api/files/folders/:folderId` | Delete folder tree |
| `POST` | `/api/files/upload` | Upload a file stream to S3 |
| `POST` | `/api/files/move` | Move selected files into a folder |
| `POST` | `/api/files/:fileId/restore` | Request restore |
| `POST` | `/api/files/:fileId/check-restore` | Refresh restore status |
| `GET` | `/api/files/:fileId/download` | Create presigned download URL |
| `POST` | `/api/files/:fileId/storage-class` | Change storage class |
| `DELETE` | `/api/files/:fileId` | Delete file from S3 and local index |
| `POST` | `/api/manifests/export` | Export manifest locally and to S3 |

## Security Notes

- Never commit `.env`.
- Never use root AWS access keys.
- Use a dedicated IAM user for this app.
- Restrict IAM permissions to one bucket and one prefix.
- Keep S3 Block Public Access enabled.
- Use SSE-S3 (`AES256`) unless you specifically need KMS.
- If you use SSE-KMS, keep the KMS key safe. Losing access to the key can make files unrecoverable.
- Rotate credentials if they are exposed.

## Cost Notes

This app is designed for cheap long-term storage, but AWS costs depend on region, object count, request volume, restore tier, and retention duration.

Watch for:

- Storage cost per GB per month.
- Retrieval and restore request costs.
- Minimum storage duration charges for Glacier classes.
- Early delete charges.
- Metadata overhead for many tiny files.
- KMS request costs if using SSE-KMS.

For many tiny files, consider uploading a folder as a ZIP. This can reduce object count and make archives easier to restore as one unit.

## Backups And Durability

S3 is the durable object store for file bytes. This app also depends on local metadata in `data/`.

Recommended habits:

- Back up `data/index.json`.
- Back up `data/events.jsonl`.
- Use Export Manifest after important uploads.
- Keep a copy of `.env` values in a secure password manager.
- Test restore and download with a small file before archiving important data.

## Current Limitations

- The app is intended for local single-user use.
- There is no login system.
- There is no multi-device sync for local metadata.
- Folder hierarchy is app metadata, not native S3 folders.
- Very large uploads depend on your browser, network, and server limits.
- Changing storage class for archived files requires the object to be restored first.

## Development Notes

The project intentionally avoids heavy infrastructure. The backend uses a small JSON metadata store with a write queue to keep local updates simple. The frontend uses browser APIs for upload progress, drag and drop, and folder ZIP creation.

When adding features, prefer:

- small local modules,
- native browser APIs where practical,
- AWS SDK calls in `server/aws/s3.js`,
- API wrappers in `client/src/api.js`,
- metadata changes through `server/metadata/store.js`.