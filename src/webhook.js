import crypto from "node:crypto";
import { config } from "./config.js";
import { log } from "./logger.js";
import { createDeliveryCache } from "./dedupe.js";
import { withLock } from "./mutex.js";
import {
  extractBranchFromCreateDelete,
  extractBranchFromPullRequest,
  extractBranchFromPush,
  handleNewBranch,
  handlePullRequestMerged,
  handlePushToBranch,
  handleRemoteBranchDeleted,
  payloadMatchesConfiguredRepo,
} from "./handlers.js";

const deliveryCache = createDeliveryCache();

export function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== "string") {
    return false;
  }
  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const digest = crypto
    .createHmac("sha256", config.webhookSecret)
    .update(rawBody)
    .digest("hex");
  const expected = `sha256=${digest}`;

  const actualBuf = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

async function routeEvent(event, payload) {
  if (!payloadMatchesConfiguredRepo(payload)) {
    log.info(
      `Ignoring event for unexpected repository: ${payload?.repository?.full_name || "(none)"}`,
    );
    return;
  }

  switch (event) {
    case "ping": {
      log.info("GitHub webhook ping received");
      return;
    }
    case "create": {
      const branch = extractBranchFromCreateDelete(payload);
      if (!branch) {
        log.info("Ignoring create event for non-branch ref");
        return;
      }
      await handleNewBranch(branch);
      return;
    }
    case "delete": {
      const branch = extractBranchFromCreateDelete(payload);
      if (!branch) {
        log.info("Ignoring delete event for non-branch ref");
        return;
      }
      await handleRemoteBranchDeleted(branch);
      return;
    }
    case "push": {
      const branch = extractBranchFromPush(payload);
      if (!branch) {
        log.info("Ignoring push event for non-branch ref");
        return;
      }
      await handlePushToBranch(branch, {
        created: Boolean(payload.created),
        deleted: Boolean(payload.deleted),
        forced: Boolean(payload.forced),
      });
      return;
    }
    case "pull_request": {
      if (payload.action !== "closed") {
        log.info(`Ignoring pull_request action: ${payload.action}`);
        return;
      }
      if (!payload.pull_request?.merged) {
        log.info("Ignoring closed pull request that was not merged");
        return;
      }
      const branch = extractBranchFromPullRequest(payload);
      if (!branch) {
        log.warn("Merged pull request missing head branch name");
        return;
      }
      await handlePullRequestMerged(branch);
      return;
    }
    default: {
      log.info(`Ignoring unrelated GitHub event: ${event}`);
    }
  }
}

export function createWebhookHandler() {
  return async function webhookHandler(req, res) {
    const signature = req.get("x-hub-signature-256");
    const deliveryId = req.get("x-github-delivery");
    const event = req.get("x-github-event");

    if (!Buffer.isBuffer(req.body)) {
      res.status(500).send("Raw body unavailable");
      return;
    }

    if (!verifySignature(req.body, signature)) {
      log.warn("Rejected webhook with invalid signature");
      res.status(401).send("Invalid signature");
      return;
    }

    if (deliveryCache.has(deliveryId)) {
      log.info(`Duplicate delivery ignored: ${deliveryId}`);
      res.status(200).send("Duplicate ignored");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      res.status(400).send("Invalid JSON");
      return;
    }

    // Acknowledge quickly; process under the lock afterward.
    deliveryCache.remember(deliveryId);
    res.status(202).send("Accepted");

    withLock(async () => {
      try {
        await routeEvent(event, payload);
      } catch (error) {
        log.error(`Unhandled webhook error: ${error.message}`);
      }
    });
  };
}
