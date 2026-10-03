import { log } from "./logger.js";
import {
  extractBranchFromCreateDelete,
  extractBranchFromPullRequest,
  extractBranchFromPush,
  handleNewBranch,
  handlePullRequestClosed,
  handlePullRequestReady,
  handlePushToBranch,
  handleRemoteBranchDeleted,
  payloadMatchesConfiguredRepo,
} from "./handlers.js";

/**
 * Route a GitHub event payload to the existing branch-management handlers.
 * Shared by the webhook server and the Actions CLI.
 */
export async function routeEvent(event, payload) {
  if (!payloadMatchesConfiguredRepo(payload)) {
    log.info(
      `Ignoring event for unexpected repository: ${payload?.repository?.full_name || "(none)"}`,
    );
    return;
  }

  switch (event) {
    case "ping": {
      log.info("GitHub ping received");
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
      const action = payload.action;
      const branch = extractBranchFromPullRequest(payload);

      if (action === "opened" || action === "ready_for_review" || action === "reopened") {
        if (action === "opened" && payload.pull_request?.draft) {
          log.info("Ignoring draft pull request open; waiting for ready_for_review");
          return;
        }
        if (!branch) {
          log.warn("Pull request missing head branch name");
          return;
        }
        await handlePullRequestReady(branch);
        return;
      }

      if (action === "closed") {
        if (!branch) {
          log.warn("Closed pull request missing head branch name");
          return;
        }
        await handlePullRequestClosed(branch, {
          merged: Boolean(payload.pull_request?.merged),
        });
        return;
      }

      log.info(`Ignoring pull_request action: ${action}`);
      return;
    }
    default: {
      log.info(`Ignoring unrelated GitHub event: ${event}`);
    }
  }
}
