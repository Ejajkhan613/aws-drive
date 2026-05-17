import express from "express";
import fs from "node:fs";
import path from "node:path";

import { getConfig, getPublicConfig } from "./config.js";
import { createConfigRouter } from "./routes/config.js";
import { createFilesRouter } from "./routes/files.js";
import { createManifestsRouter } from "./routes/manifests.js";
import { ensureDataStore } from "./metadata/store.js";
import { startRestorePoller } from "./restore/poller.js";

const app = express();
const config = getConfig();

app.disable("x-powered-by");
app.use(localCors);

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "aws-glacier-drive",
    config: getPublicConfig(),
  });
});

app.use("/api/config", createConfigRouter());
app.use("/api/files", createFilesRouter());
app.use("/api/manifests", createManifestsRouter());

const distDir = path.resolve(process.cwd(), "dist");
const distIndex = path.join(distDir, "index.html");

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.use("/api", (req, res) => {
  res.status(404).json({ error: { message: "API route was not found." } });
});

app.use((req, res, next) => {
  if (req.method === "GET" && fs.existsSync(distIndex)) {
    res.sendFile(distIndex);
    return;
  }

  if (req.method === "GET") {
    res.type("html").send(`
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>AWS Glacier Drive</title>
        </head>
        <body>
          <main>
            <h1>AWS Glacier Drive backend is running</h1>
            <p>Build the React/Vite frontend to serve the dashboard from this server.</p>
            <p>Health endpoint: <a href="/api/health">/api/health</a></p>
          </main>
        </body>
      </html>
    `);
    return;
  }

  next();
});

app.use((error, req, res, next) => {
  const status = error.status || error.$metadata?.httpStatusCode || 500;
  const response = {
    error: {
      message: error.message || "Unexpected server error.",
    },
  };

  if (error.details) {
    response.error.details = error.details;
  }

  if (process.env.NODE_ENV !== "production" && status >= 500) {
    response.error.name = error.name;
  }

  res.status(status).json(response);
});

await ensureDataStore();
startRestorePoller();

app.listen(config.app.port, () => {
  console.log(`AWS Glacier Drive backend listening on http://localhost:${config.app.port}`);
});

function localCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && isLocalOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-File-Name, X-Storage-Class, X-Parent-Id",
    );
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}

function isLocalOrigin(origin) {
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
