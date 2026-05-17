import { Router } from "express";

import { getConfigIssues, getPublicConfig } from "../config.js";
import { validateS3Access } from "../aws/s3.js";
import { asyncHandler } from "../http/async-handler.js";

export function createConfigRouter() {
  const router = Router();

  router.get("/", (req, res) => {
    res.json(getPublicConfig());
  });

  router.post("/validate", asyncHandler(async (req, res) => {
    const issues = getConfigIssues();
    if (issues.length > 0) {
      res.status(400).json({
        ok: false,
        checks: [
          { name: "env", status: "failed", issues },
        ],
      });
      return;
    }

    const s3 = await validateS3Access();
    res.json({
      ok: true,
      checks: [
        { name: "env", status: "passed" },
        { name: "s3_list_prefix", status: "passed", details: s3 },
      ],
    });
  }));

  return router;
}
