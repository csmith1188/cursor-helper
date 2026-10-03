import crypto from "node:crypto";
import { config } from "./config.js";
import { log } from "./logger.js";
import { createDeliveryCache } from "./dedupe.js";
import { withLock } from "./mutex.js";
import { routeEvent } from "./events.js";

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
