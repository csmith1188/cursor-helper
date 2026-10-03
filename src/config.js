import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig() {
  const repoPath = path.resolve(required("REPO_PATH"));
  const owner = required("GITHUB_OWNER");
  const repo = required("GITHUB_REPO");
  const webhookSecret = required("GITHUB_WEBHOOK_SECRET");
  const githubToken = required("GITHUB_TOKEN");

  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  let branchPrefix = (process.env.BRANCH_PREFIX || "cursor/").trim();
  if (!branchPrefix.endsWith("/")) {
    branchPrefix = `${branchPrefix}/`;
  }

  const baseBranch = (process.env.BASE_BRANCH || "main").trim();
  const logPrefix = (process.env.LOG_PREFIX || "branch-sync").trim() || "branch-sync";

  if (!fs.existsSync(repoPath)) {
    throw new Error(`REPO_PATH does not exist: ${repoPath}`);
  }

  const gitDir = path.join(repoPath, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error(`REPO_PATH is not a Git repository: ${repoPath}`);
  }

  return {
    repoPath,
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    webhookSecret,
    githubToken,
    port,
    branchPrefix,
    baseBranch,
    logPrefix,
  };
}

export const config = loadConfig();
