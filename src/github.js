import { config } from "./config.js";
import { log } from "./logger.js";
import { isManagedBranch } from "./git.js";

/**
 * Return the head branch of the most recently updated open PR whose head
 * matches BRANCH_PREFIX, or null if none.
 */
export async function getMostRecentlyActiveManagedBranch({ excludeBranch } = {}) {
  const url = new URL(
    `https://api.github.com/repos/${config.owner}/${config.repo}/pulls`,
  );
  url.searchParams.set("state", "open");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "100");

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.githubToken}`,
      "User-Agent": "cursor-branch-sync",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API error ${response.status} listing open PRs: ${body.slice(0, 200)}`,
    );
  }

  const pulls = await response.json();
  if (!Array.isArray(pulls)) {
    throw new Error("Unexpected GitHub API response when listing open PRs");
  }

  for (const pr of pulls) {
    const headRef = pr?.head?.ref;
    if (!isManagedBranch(headRef)) continue;
    if (excludeBranch && headRef === excludeBranch) continue;
    // Prefer PRs targeting the configured base branch
    if (pr?.base?.ref && pr.base.ref !== config.baseBranch) continue;
    return headRef;
  }

  return null;
}

export async function resolveNextBranch({ excludeBranch } = {}) {
  try {
    const next = await getMostRecentlyActiveManagedBranch({ excludeBranch });
    if (next) {
      log.info(`Next open feature branch: ${next}`);
      return next;
    }
  } catch (error) {
    log.warn(
      `Could not list open PRs (${error.message}); falling back to ${config.baseBranch}`,
    );
  }

  return config.baseBranch;
}
