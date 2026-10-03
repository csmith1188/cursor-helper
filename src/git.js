import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

export class UnsafeOperationError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeOperationError";
  }
}

export function assertSafeBranchName(branch, { allowBase = false } = {}) {
  if (!branch || typeof branch !== "string") {
    throw new UnsafeOperationError("Invalid branch name");
  }
  if (branch.includes("..") || branch.startsWith("-") || branch.includes("\\")) {
    throw new UnsafeOperationError(`Refusing unsafe branch name: ${branch}`);
  }
  if (!BRANCH_NAME_RE.test(branch)) {
    throw new UnsafeOperationError(`Refusing unsafe branch name: ${branch}`);
  }

  const isBase = branch === config.baseBranch;
  const isPrefixed = branch.startsWith(config.branchPrefix);
  if (!isPrefixed && !(allowBase && isBase)) {
    throw new UnsafeOperationError(
      `Branch is outside managed scope (${config.branchPrefix}): ${branch}`,
    );
  }

  return branch;
}

export function isManagedBranch(branch) {
  return (
    typeof branch === "string" &&
    BRANCH_NAME_RE.test(branch) &&
    !branch.includes("..") &&
    branch.startsWith(config.branchPrefix)
  );
}

export function parseBranchFromRef(ref) {
  if (typeof ref !== "string") return null;
  if (ref.startsWith("refs/heads/")) {
    return ref.slice("refs/heads/".length);
  }
  // create/delete events often send the short name
  if (!ref.startsWith("refs/")) {
    return ref;
  }
  return null;
}

async function git(args, { allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: config.repoPath,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return {
      stdout: (stdout || "").trim(),
      stderr: (stderr || "").trim(),
    };
  } catch (error) {
    if (allowFailure) {
      return {
        stdout: (error.stdout || "").toString().trim(),
        stderr: (error.stderr || "").toString().trim(),
        code: error.code ?? 1,
        failed: true,
      };
    }
    const detail = (error.stderr || error.message || "").toString().trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

export async function getStatusPorcelain() {
  const { stdout } = await git(["status", "--porcelain"]);
  return stdout;
}

export async function assertCleanWorkingTree(action) {
  const status = await getStatusPorcelain();
  if (status) {
    throw new UnsafeOperationError(
      `Local changes detected; ${action} aborted`,
    );
  }
}

export async function getCurrentBranch() {
  const { stdout } = await git(["branch", "--show-current"]);
  return stdout || null;
}

export async function fetchOrigin() {
  await git(["fetch", "origin", "--prune"]);
}

export async function localBranchExists(branch) {
  assertSafeBranchName(branch, { allowBase: true });
  const result = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    allowFailure: true,
  });
  return !result.failed;
}

export async function remoteBranchExists(branch) {
  assertSafeBranchName(branch, { allowBase: true });
  const { stdout } = await git(["ls-remote", "--heads", "origin", branch]);
  if (!stdout) return false;
  const needle = `refs/heads/${branch}`;
  return stdout.split("\n").some((line) => line.includes(needle));
}

export async function checkoutBranch(branch) {
  assertSafeBranchName(branch, { allowBase: true });
  await assertCleanWorkingTree("branch switch");

  const current = await getCurrentBranch();
  if (current === branch) {
    log.info(`Already on ${branch}`);
    return;
  }

  log.info(`Switching to ${branch}`);

  const localExists = await localBranchExists(branch);
  if (localExists) {
    await git(["checkout", branch]);
    return;
  }

  const remoteExists = await remoteBranchExists(branch);
  if (!remoteExists) {
    throw new Error(`Remote branch origin/${branch} not found`);
  }

  await git(["checkout", "--track", `origin/${branch}`]);
}

export async function pullFfOnly(branch) {
  assertSafeBranchName(branch, { allowBase: true });
  await assertCleanWorkingTree("pull");

  const current = await getCurrentBranch();
  if (current !== branch) {
    throw new Error(`Cannot pull ${branch}: currently on ${current || "(detached)"}`);
  }

  await git(["pull", "--ff-only", "origin", branch]);
}

/**
 * Fast-forward update local base branch without requiring it to be checked out.
 * Uses fetch into the local ref when possible; falls back to checkout + ff-only pull.
 */
export async function updateBaseBranch() {
  const base = config.baseBranch;
  assertSafeBranchName(base, { allowBase: true });
  await assertCleanWorkingTree("base branch update");

  await git(["fetch", "origin", base]);

  const current = await getCurrentBranch();
  if (current === base) {
    await git(["pull", "--ff-only", "origin", base]);
    return;
  }

  const localExists = await localBranchExists(base);
  if (!localExists) {
    await git(["branch", "--track", base, `origin/${base}`]);
    return;
  }

  // Fast-forward local base to origin/base without checkout
  const result = await git(["merge-base", "--is-ancestor", base, `origin/${base}`], {
    allowFailure: true,
  });
  if (result.failed) {
    throw new UnsafeOperationError(
      `Cannot fast-forward ${base} to origin/${base}; refusing non-ff update`,
    );
  }

  await git(["branch", "-f", base, `origin/${base}`]);
}

export async function deleteLocalBranch(branch, { mergedConfirmed = false } = {}) {
  assertSafeBranchName(branch);
  await assertCleanWorkingTree("local branch delete");

  const current = await getCurrentBranch();
  if (current === branch) {
    throw new UnsafeOperationError(
      `Cannot delete checked-out branch ${branch}`,
    );
  }

  const exists = await localBranchExists(branch);
  if (!exists) {
    log.info(`Local branch ${branch} already gone`);
    return false;
  }

  // Prefer -d. Squash-merges often leave Git thinking the branch is unmerged;
  // only then, and only when GitHub confirmed the PR was merged, use -D.
  const soft = await git(["branch", "-d", branch], { allowFailure: true });
  if (!soft.failed) {
    log.info("Deleted obsolete local branch");
    return true;
  }

  if (!mergedConfirmed) {
    throw new UnsafeOperationError(
      `Could not safely delete local branch ${branch}: ${soft.stderr || "not fully merged"}`,
    );
  }

  const hard = await git(["branch", "-D", branch], { allowFailure: true });
  if (hard.failed) {
    throw new UnsafeOperationError(
      `Could not delete local branch ${branch} after merge confirmation: ${hard.stderr || "unknown error"}`,
    );
  }

  log.info("Deleted obsolete local branch (GitHub merge confirmed)");
  return true;
}

export async function deleteRemoteBranch(branch) {
  assertSafeBranchName(branch);
  await assertCleanWorkingTree("remote branch delete");

  const exists = await remoteBranchExists(branch);
  if (!exists) {
    log.info(`Remote branch origin/${branch} already gone`);
    return false;
  }

  await git(["push", "origin", "--delete", branch]);
  log.info(`Deleted remote branch origin/${branch}`);
  return true;
}
