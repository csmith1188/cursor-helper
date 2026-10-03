import { config } from "./config.js";
import { log } from "./logger.js";
import { resolveNextBranch } from "./github.js";
import {
  UnsafeOperationError,
  assertCleanWorkingTree,
  checkoutBranch,
  deleteLocalBranch,
  deleteRemoteBranch,
  fetchOrigin,
  getCurrentBranch,
  isManagedBranch,
  parseBranchFromRef,
  pullFfOnly,
  updateBaseBranch,
} from "./git.js";

function warnOrThrow(error, context) {
  if (error instanceof UnsafeOperationError) {
    log.warn(error.message);
    return;
  }
  log.error(`${context}: ${error.message}`);
  throw error;
}

async function switchToAndUpdate(branch) {
  await checkoutBranch(branch);
  try {
    await pullFfOnly(branch);
  } catch (error) {
    if (error instanceof UnsafeOperationError) {
      log.warn(error.message);
      return;
    }
    // Already up to date or remote tracking quirks — surface non-ff as warning
    if (/Not possible to fast-forward|diverged|ff-only/i.test(error.message)) {
      log.warn(`Fast-forward pull failed for ${branch}; leaving local branch unchanged`);
      return;
    }
    throw error;
  }
}

/**
 * Finish-current-first: adopt a managed branch only when idle
 * (on BASE_BRANCH or a non-managed branch). If already testing another
 * managed branch, queue the candidate and leave checkout unchanged.
 */
async function adoptBranchIfIdle(branch, reason) {
  if (!isManagedBranch(branch)) {
    log.info(`Ignoring unmanaged branch: ${branch}`);
    return;
  }

  log.info(`${reason}: ${branch}`);

  try {
    await assertCleanWorkingTree("branch switch");
    await fetchOrigin();

    const current = await getCurrentBranch();
    if (current === branch) {
      log.info(`Already on ${branch}; pulling latest`);
      await pullFfOnly(branch);
      return;
    }

    if (isManagedBranch(current)) {
      log.info(
        `Queued ${branch}; currently testing ${current} (finish current first)`,
      );
      return;
    }

    await switchToAndUpdate(branch);
  } catch (error) {
    warnOrThrow(error, "Failed to check out branch");
  }
}

export async function handleNewBranch(branch) {
  await adoptBranchIfIdle(branch, "New branch detected");
}

export async function handlePullRequestReady(branch) {
  await adoptBranchIfIdle(branch, "PR ready for testing");
}

export async function handlePushToBranch(branch, { created, deleted, forced }) {
  if (deleted) {
    log.info(`Push deleted remote branch ${branch}; relying on delete/merge handlers`);
    return;
  }

  if (!isManagedBranch(branch) && branch !== config.baseBranch) {
    log.info(`Ignoring push to unmanaged branch: ${branch}`);
    return;
  }

  if (created && isManagedBranch(branch)) {
    await handleNewBranch(branch);
    return;
  }

  if (forced) {
    log.warn(`Force-push detected on ${branch}; refusing automatic update`);
    return;
  }

  if (branch === config.baseBranch) {
    const current = await getCurrentBranch();
    if (current !== config.baseBranch) {
      log.info(`Push to ${config.baseBranch} ignored (not checked out)`);
      return;
    }
    log.info("Push received; pulling latest changes");
    try {
      await assertCleanWorkingTree("pull");
      await fetchOrigin();
      await pullFfOnly(config.baseBranch);
    } catch (error) {
      warnOrThrow(error, "Failed to pull base branch");
    }
    return;
  }

  const current = await getCurrentBranch();
  if (current !== branch) {
    log.info(`Push to ${branch} ignored (currently on ${current || "(detached)"})`);
    return;
  }

  log.info("Push received; pulling latest changes");
  try {
    await assertCleanWorkingTree("pull");
    await fetchOrigin();
    await pullFfOnly(branch);
  } catch (error) {
    warnOrThrow(error, "Failed to pull feature branch");
  }
}

async function cleanupClosedBranch(branch, { wasMerged }) {
  if (!isManagedBranch(branch)) {
    log.info(`Ignoring close/cleanup for unmanaged branch: ${branch}`);
    return;
  }

  log.info(wasMerged ? `Branch merged: ${branch}` : `Branch closed: ${branch}`);

  try {
    await assertCleanWorkingTree("close cleanup");
    await fetchOrigin();
    await updateBaseBranch();

    const next = await resolveNextBranch({ excludeBranch: branch });
    await switchToAndUpdate(next);

    // Force-delete local after PR close (squash-merge or unmerged close).
    await deleteLocalBranch(branch, { mergedConfirmed: true });
    await deleteRemoteBranch(branch);
  } catch (error) {
    warnOrThrow(error, "Failed close cleanup");
  }
}

export async function handlePullRequestClosed(branch, { merged }) {
  await cleanupClosedBranch(branch, { wasMerged: Boolean(merged) });
}

/** @deprecated Prefer handlePullRequestClosed */
export async function handlePullRequestMerged(branch) {
  await handlePullRequestClosed(branch, { merged: true });
}

export async function handleRemoteBranchDeleted(branch) {
  if (!isManagedBranch(branch)) {
    log.info(`Ignoring delete of unmanaged branch: ${branch}`);
    return;
  }

  log.info(`Remote branch deleted: ${branch}`);

  try {
    await assertCleanWorkingTree("delete cleanup");
    await fetchOrigin();

    const current = await getCurrentBranch();
    if (current === branch) {
      await updateBaseBranch();
      const next = await resolveNextBranch({ excludeBranch: branch });
      await switchToAndUpdate(next);
    }

    await deleteLocalBranch(branch, { mergedConfirmed: true });
  } catch (error) {
    warnOrThrow(error, "Failed delete cleanup");
  }
}

export function extractBranchFromCreateDelete(payload) {
  if (payload?.ref_type !== "branch") return null;
  return parseBranchFromRef(payload.ref);
}

export function extractBranchFromPush(payload) {
  return parseBranchFromRef(payload?.ref);
}

export function extractBranchFromPullRequest(payload) {
  const head = payload?.pull_request?.head?.ref;
  return typeof head === "string" ? head : null;
}

export function payloadMatchesConfiguredRepo(payload) {
  const fullName = payload?.repository?.full_name;
  return typeof fullName === "string" && fullName === config.fullName;
}
