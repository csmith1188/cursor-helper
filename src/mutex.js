import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

let chain = Promise.resolve();

const LOCK_WAIT_MS = 120_000;
const STALE_LOCK_MS = 10 * 60 * 1000;
const RETRY_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockFilePath() {
  const safe = `${config.owner}--${config.repo}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(os.tmpdir(), `cursor-branch-sync-${safe}.lock`);
}

/**
 * Cross-process exclusive lock so the webhook server and Actions CLI
 * cannot interleave Git ops on the same repository.
 */
async function withFileLock(fn) {
  const file = lockFilePath();
  const started = Date.now();
  let fd;

  while (fd === undefined) {
    try {
      fd = fs.openSync(file, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error("Timed out waiting for branch-sync lock");
      }
      try {
        const st = fs.statSync(file);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(file);
          continue;
        }
      } catch {
        // Lock disappeared between EEXIST and stat; retry acquire.
      }
      await sleep(RETRY_MS);
    }
  }

  try {
    fs.writeSync(fd, String(process.pid));
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
}

/**
 * Serialize async work so overlapping webhook deliveries / CLI runs
 * cannot interleave Git ops.
 */
export function withLock(fn) {
  const run = chain.then(() => withFileLock(fn));
  // Keep the chain alive even if a task fails
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
