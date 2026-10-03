# Cursor Branch Sync

Small Node.js tool that keeps a **local Git clone** synchronized with feature branches managed remotely (for example by Cursor Mobile / Cloud Agents).

One install manages **one** repository. Point it at any clone by editing `.env`.

## Modes

| `SYNC_MODE` | How events arrive | Inbound ports / tunnel |
| --- | --- | --- |
| `runner` (recommended) | GitHub Actions on a **self-hosted Windows runner** invokes `npm run sync` | None |
| `webhook` | GitHub webhook → local HTTP server | Needs a public HTTPS URL (tunnel) |
| `both` | Runner and webhook together | Same as webhook if you use that path |

GitHub Actions (or the webhook) only **detects and forwards** events. This Node app still decides what to do and performs all Git operations with the same safety checks.

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

## Windows setup (self-hosted runner)

No inbound ports, webhook server, polling, or public IP.

### 1. Prerequisites

- [Node.js 18+](https://nodejs.org/) (LTS recommended)
- [Git for Windows](https://git-scm.com/download/win)
- A local clone of the GitHub repository you want to keep in sync
- Permission to add a self-hosted runner on that GitHub repository (or org)

### 2. Install this tool

```bat
git clone https://github.com/<you>/cursor-helper.git C:\Users\you\cursor-helper
cd C:\Users\you\cursor-helper
npm install
copy .env.example .env
notepad .env
```

Set at least:

| Variable | Purpose |
| --- | --- |
| `REPO_PATH` | Absolute path to your local clone (e.g. `C:\Users\you\projects\my-repo`) |
| `GITHUB_OWNER` | GitHub user or org that owns the repo |
| `GITHUB_REPO` | Repository name |
| `SYNC_MODE` | `runner` |
| `BRANCH_PREFIX` | Only manage branches with this prefix (default `cursor/`) |
| `BASE_BRANCH` | Branch to return to when nothing else is open (default `main`) |

`GITHUB_TOKEN` in `.env` is optional for runner mode when jobs run inside GitHub Actions (the workflow token is used). Keep a PAT in `.env` if you want to run `npm run sync` manually outside Actions.

You can leave `GITHUB_WEBHOOK_SECRET` and `PORT` unset when `SYNC_MODE=runner`.

### 3. Install and register the GitHub self-hosted runner (Windows)

In the **managed repository** on GitHub:

1. **Settings → Actions → Runners → New self-hosted runner**
2. Choose **Windows** and follow the download/config commands GitHub shows (they include a unique token).

Typical flow in PowerShell (paths/version will match GitHub’s UI):

```powershell
mkdir C:\actions-runner; cd C:\actions-runner
# Download and extract the runner package from the GitHub instructions, then:
.\config.cmd --url https://github.com/<owner>/<repo> --token <token-from-github-ui>
```

Accept the defaults unless you need a custom runner name or labels. The runner registers with the `self-hosted` and `Windows` labels used by the workflow template.

### 4. Run the runner as a Windows service

Still in the runner folder (PowerShell **as Administrator**):

```powershell
.\svc.cmd install
.\svc.cmd start
```

Check status:

```powershell
.\svc.cmd status
```

The service should show as running. It starts with Windows after install.

To stop/uninstall later: `.\svc.cmd stop` then `.\svc.cmd uninstall`.

### 5. Add the GitHub Actions workflow

Copy the template into the **managed** repository (the one whose branches Cursor publishes):

```bat
copy templates\github-actions\cursor-branch-sync.yml <path-to-managed-repo>\.github\workflows\cursor-branch-sync.yml
```

Edit the workflow’s `working-directory` so it points at this install, for example:

```yaml
working-directory: C:\Users\you\cursor-helper
```

Commit and push that workflow on `main` (or your default branch) so GitHub can run it.

The workflow listens for create / delete / push / merged pull_request events, then runs:

```bat
node src\cli.js
```

which reads `GITHUB_EVENT_NAME` and `GITHUB_EVENT_PATH` and reuses the same branch-management logic as the webhook path.

### 6. Verify

1. Confirm the runner is **Idle** under **Settings → Actions → Runners**.
2. Create and push `cursor/test-sync` (or start a Cursor agent that publishes a branch).
3. Open the Actions tab: **Cursor Branch Sync** should run on the self-hosted runner.
4. Locally, `REPO_PATH` should check out that branch (working tree must be clean).

---

## Optional: webhook mode

Use this if you prefer GitHub to POST events to a local HTTP server instead of (or in addition to) Actions.

### Configure

In `.env` set `SYNC_MODE=webhook` (or `both`) and:

| Variable | Purpose |
| --- | --- |
| `GITHUB_WEBHOOK_SECRET` | Long random string (same value in the GitHub webhook) |
| `GITHUB_TOKEN` | PAT used to list open pull requests |
| `PORT` | Local listen port (default `3000`) |

```bat
npm start
```

### Expose the endpoint

GitHub must reach `http://localhost:PORT/webhook` over HTTPS. Use a tunnel such as Cloudflare Tunnel or ngrok:

```bat
ngrok http 3000
```

### Create the GitHub webhook

In the managed repository:

1. **Settings → Webhooks → Add webhook**
2. **Payload URL:** `https://<your-tunnel-host>/webhook`
3. **Content type:** `application/json`
4. **Secret:** same as `GITHUB_WEBHOOK_SECRET`
5. **Events:** Branch or tag creation, Branch or tag deletion, Pushes, Pull requests

### Optional autostart (webhook server)

**PM2**

```bat
npm install -g pm2
pm2 start src/index.js --name cursor-branch-sync
pm2 save
pm2 startup
```

**Task Scheduler:** run `node.exe` with `src\index.js` at logon, start-in set to this project folder.

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

Manual CLI (same as Actions, useful for debugging):

```bat
npm run sync -- --event push --payload path\to\event.json
```

---

## Notes

- Events for any repository other than `GITHUB_OWNER/GITHUB_REPO` are ignored.
- Duplicate GitHub webhook deliveries (`X-GitHub-Delivery`) are ignored.
- Runner and webhook share a file lock so they will not interleave Git ops if `SYNC_MODE=both`.
- Force-pushes are refused (cannot fast-forward safely).
- Deleting a merged branch from `origin` uses the Git credentials already configured for that local clone (SSH key or credential manager). Listing open PRs uses `GITHUB_TOKEN` (PAT or the Actions token).
- To sync a second repository, use a second install/`.env` and a second runner (or webhook) scoped to that repository.
