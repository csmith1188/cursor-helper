# Cursor Branch Sync

Small Node.js service that keeps a **local Git clone** synchronized with feature branches managed remotely (for example by Cursor Mobile / Cloud Agents) using **GitHub webhooks**.

One running process manages **one** repository. Point it at any clone by editing `.env` before launch.

## What it does

| Remote event | Local behavior |
| --- | --- |
| New feature branch published | Fetch, create/track the branch, check it out |
| Push to the branch you already have checked out | Fast-forward pull only |
| Push to some other feature branch | Ignored (no surprise checkouts) |
| Feature PR squash-merged | Update base branch, delete obsolete local branch, delete remote branch if it still exists, switch to the newest still-open prefixed PR (or base) |
| Remote feature branch deleted | Clean up the local branch; switch away first if needed |

**Safety:** the tool never runs `reset --hard`, force-checkout, stash, or force-push. If the working tree has uncommitted or untracked changes, it logs a warning and refuses the operation. Pulls use `--ff-only`.

---

## Windows setup

### 1. Prerequisites

- [Node.js 18+](https://nodejs.org/) (LTS recommended)
- [Git for Windows](https://git-scm.com/download/win)
- A local clone of the GitHub repository you want to keep in sync

### 2. Install dependencies

Open PowerShell or Command Prompt in this project folder:

```bat
npm install
```

### 3. Configure `.env`

```bat
copy .env.example .env
notepad .env
```

Set at least:

| Variable | Purpose |
| --- | --- |
| `REPO_PATH` | Absolute path to your local clone (e.g. `C:\Users\you\projects\my-repo`) |
| `GITHUB_OWNER` | GitHub user or org that owns the repo |
| `GITHUB_REPO` | Repository name |
| `GITHUB_WEBHOOK_SECRET` | Long random string (you will paste the same value into GitHub) |
| `GITHUB_TOKEN` | PAT used to list open pull requests |
| `PORT` | Local listen port (default `3000`) |
| `BRANCH_PREFIX` | Only manage branches with this prefix (default `cursor/`) |
| `BASE_BRANCH` | Branch to return to when nothing else is open (default `main`) |
| `LOG_PREFIX` | Optional log label (default `branch-sync`) |

Create a GitHub token with permission to read pull requests on that repository (classic `repo` / `public_repo`, or a fine-grained token with **Pull requests: Read**).

### 4. Expose the webhook endpoint to GitHub

GitHub must reach `http://localhost:PORT/webhook` over HTTPS. The simplest secure approach on a personal machine is a tunnel:

**Recommended: Cloudflare Tunnel** (free, stable HTTPS URL) or **ngrok**.

Example with ngrok after the app is running:

```bat
ngrok http 3000
```

Copy the HTTPS forwarding URL (e.g. `https://abc123.ngrok-free.app`).

Do not open the port on your router without TLS. Signature verification (next step) protects the endpoint even when the URL is public.

### 5. Create the GitHub webhook

In the **target repository** on GitHub:

1. **Settings → Webhooks → Add webhook**
2. **Payload URL:** `https://<your-tunnel-host>/webhook`
3. **Content type:** `application/json`
4. **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
5. **Which events:** choose **Let me select individual events** and enable:
   - **Branch or tag creation**
   - **Branch or tag deletion**
   - **Pushes**
   - **Pull requests**
6. Save. GitHub will send a `ping`; the app logs it when running.

### 6. Start the application

```bat
npm start
```

You should see logs similar to:

```text
[branch-sync] Listening on port 3000
[branch-sync] Managing you/my-repo at C:\Users\you\projects\my-repo
```

Health check: open `http://localhost:3000/health` in a browser.

### 7. (Optional) Start automatically on Windows

**PM2**

```bat
npm install -g pm2
pm2 start src/index.js --name cursor-branch-sync
pm2 save
pm2 startup
```

Follow the command `pm2 startup` prints so PM2 resumes after reboot.

**Task Scheduler**

1. Create a task that runs at logon.
2. Program: path to `node.exe`
3. Arguments: path to `src\index.js`
4. Start in: this project folder (so `.env` is found)

---

## How to test

Use a throwaway feature branch on the configured repository (keep a clean working tree in `REPO_PATH`).

1. **Branch creation** — Create and push `cursor/test-sync` (or open a Cursor agent that publishes a branch).  
   Expect: `New branch detected` → local checkout switches to that branch.

2. **Push while checked out** — Push another commit to the same branch.  
   Expect: `Push received; pulling latest changes` and a fast-forward update.  
   Pushing to a *different* feature branch while you stay on the first one should **not** switch checkouts.

3. **Squash-merge** — Open a PR, squash-merge into `main` (or your `BASE_BRANCH`).  
   Expect: `Branch merged` → base updated → obsolete local branch removed → remote deleted only if it still exists → switch to another open `cursor/…` PR if one remains, otherwise `main`.

4. **Safety** — Make a local edit without committing, then trigger a branch switch.  
   Expect: `WARNING: Local changes detected; … aborted` and no checkout change.

---

## Notes

- Events for any repository other than `GITHUB_OWNER/GITHUB_REPO` are ignored.
- Duplicate GitHub deliveries (`X-GitHub-Delivery`) are ignored.
- Force-pushes are refused (cannot fast-forward safely).
- Deleting a merged branch from `origin` uses the Git credentials already configured for that local clone (SSH key or credential manager). The `GITHUB_TOKEN` is used for the REST API (open PR lookup), not for `git push`.
- To sync a second repository, run a second process with its own `.env` and webhook/tunnel.
