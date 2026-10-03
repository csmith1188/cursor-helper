import express from "express";
import { config } from "./config.js";
import { log } from "./logger.js";
import { createWebhookHandler } from "./webhook.js";

const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    repo: config.fullName,
    repoPath: config.repoPath,
    branchPrefix: config.branchPrefix,
    baseBranch: config.baseBranch,
  });
});

app.post(
  "/webhook",
  express.raw({ type: "application/json", limit: "2mb" }),
  createWebhookHandler(),
);

app.use((err, _req, res, _next) => {
  log.error(`HTTP error: ${err.message}`);
  res.status(500).send("Internal error");
});

app.listen(config.port, () => {
  log.info(`Listening on port ${config.port}`);
  log.info(`Managing ${config.fullName} at ${config.repoPath}`);
  log.info(
    `Branch prefix=${config.branchPrefix} base=${config.baseBranch}`,
  );
});
