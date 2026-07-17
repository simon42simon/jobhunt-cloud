# Deployment & release process

This app is **local-first and single-user**: it runs on your machine and reads/writes your local vault. There is no cloud "production server," so the classic staging/production split maps to git, not to hosted environments. What follows is the right-sized process.

## Environments (mapped to reality)

| Classic term | Here |
| --- | --- |
| Local dev | `npm run dev` on your machine - Vite UI on `:5180`, Express file-bridge on `:8787`. One process, owned by the main session; do not run a second. |
| Staging | A git branch (or worktree) where a change is built and `npm run check` is run before it reaches `main`. |
| Production | `main` + the latest `vX.Y.Z` tag - the version you run daily. |

## The gate

`npm run check` (typecheck + Vitest) is the single release gate. A red gate blocks a version bump or a merge. CI runs the same gate on every push/PR via `.github/workflows/check.yml`.

## Branch model

- `main` is production (what you run).
- Do changes on a feature branch, get `npm run check` green, then merge to `main`.
- Agents that mutate files in parallel should use isolated worktrees to avoid clobbering.

## Cutting a release

1. `npm run check` green.
2. Bump `package.json` version (semantic-ish, pre-1.0).
3. Add a `docs/changelog.md` entry (Keep a Changelog, newest first, timestamped ET).
4. Reconcile `docs/roadmap.yaml` + the tasks board.
5. Commit, then `git tag -a vX.Y.Z -m "vX.Y.Z"` and push the tag.
6. Verify the headline path live before relying on it.

## Rollback

`git checkout <previous tag>` (or revert the offending commit). Every release is a tag, so any version is restorable.

## Running it

```
npm install      # first time
npm run dev      # starts Vite (:5180) + Express (:8787)
```

The `Jobs/` path is set in `config.json` (`jobsDir`) — since SIM-67 the data zone `ssc-brain\data\jobhunt\Jobs`, not the vault. The app never sends your data off-machine.

## App-level auth (feature-flagged; off by default)

Local dev needs no auth — the loopback bind (`serverHost` default `127.0.0.1`) and the no-CORS posture keep the API on-box. Auth is a **feature flag that stays OFF until you provision a passphrase**, for the LAN/tailnet opt-in or a cloud host (SIM-85 / ADR-024).

**Provision a passphrase:**

```
node ops/auth-setup.mjs        # prompts (hidden); writes an Argon2id hash to
                               # <dataDir>/auth.json (0600, OUTSIDE the git tree)
```

Once `auth.json` exists the server enables auth on next start: every `/api/*` route 401s without a valid session cookie. `POST /api/auth/login {passphrase}` (rate-limited) sets an `httpOnly` `sameSite=lax` session cookie; `POST /api/auth/logout` clears it; `GET /api/auth/status` reports posture.

**Security headers are always on (G10, RC-4), independent of auth.** `helmet` with the Vite-tuned CSP, `X-Frame-Options: DENY` + `frame-ancestors 'none'` (anti-clickjacking), `nosniff` and `referrer-policy` are emitted on **every** deployment surface - local loopback, private cloud, and the public demo (which runs with auth off but is internet-facing). Cross-origin isolation (COOP/CORP) stays off so the on-box fleet's cross-origin reads are unaffected. HSTS is added only under TLS (`JOBHUNT_TLS=1` or `JOBHUNT_TRUST_PROXY`).

**Enabling auth in the cloud (12-factor, no local file):**

| Env var | Purpose |
| --- | --- |
| `JOBHUNT_AUTH=required` | Turn auth on and **fail-fast at boot** if no hash is configured. |
| `JOBHUNT_AUTH_HASH=$argon2id$...` | The passphrase hash (from `ops/auth-setup.mjs`). |
| `JOBHUNT_AUTH_SECRET=<hex>` | Optional session-signing secret; if omitted a stable one is derived from the hash. |
| `JOBHUNT_HOST` / `serverHost` | Bind address (default loopback; set for the exposed host). |
| `JOBHUNT_TRUST_PROXY=1` | Behind a TLS terminator, so `secure` cookies + the rate-limit IP key + HSTS are correct. |
| `JOBHUNT_TLS=1` | Assert TLS in front (adds HSTS) without granting proxy trust; either this or `JOBHUNT_TRUST_PROXY` turns HSTS on. |
| `JOBHUNT_CORS_ORIGINS=https://a,https://b` | Optional cross-origin allowlist; empty ⇒ no CORS headers (default). |
| `JOBHUNT_AUTH=off` | Force auth off even if a hash is present (escape hatch). |

The passphrase is never written in plaintext and never logged; only its Argon2id hash + a random signing secret are stored.

**Failed-login visibility (SIM-386).** When auth is on, every failed login attempt — bad passphrase *and* rate-limited 429s — is recorded three ways: (1) a structured line on stdout (the always-on platform log stream, e.g. `railway logs`), (2) a durable `kind:"auth"` line in the activity log via the storage seam (FileStore and PgStore alike), and (3) when failures cross a threshold (default **3 per 15-min window**, tunable via `JOBHUNT_AUTH_ALERT_THRESHOLD` / `JOBHUNT_AUTH_RATELIMIT_WINDOW_MS`) a single **"N failed login attempts"** notification in the in-app bell — one per window, never per failure. What is recorded: timestamp, source IP (proxy-aware via the `JOBHUNT_TRUST_PROXY` opt-in — `req.ip` is the forwarded client, never a raw spoofable header), user-agent, reason (`bad_passphrase` | `rate_limited`), and a rolling count. What is **never** recorded: the attempted passphrase or any credential material — events are built from an explicit field whitelist, never from the request body. **Durable writes are bounded** (guardian condition, SIM-386 review): at most 20 failure lines + 1 threshold line per window ever reach the activity log, no matter how many requests arrive — beyond the cap the in-memory counter keeps counting exactly (the bell shows the true count via a live overlay) and stdout falls back to a sampled heartbeat (every 10th failure), so a flood can never grow the never-deletes store. The same bounded pipeline covers the sync surface's failed token auths (`surface:"sync"`, SIM-393). Recent events are readable authenticated at `GET /api/auth/failed-logins` (including `live`, the true current-window count). With auth off none of this exists (no endpoint, no lines, no notifications).

## Cloud image + Postgres (RC-3 / SIM-87, ADR-025)

One Docker image serves three deployments, differentiated purely by env (12-factor):

| Deployment | Store | Key env |
| --- | --- | --- |
| Laptop | FileStore (files canonical) | none of the below (default) |
| Private cloud | PgStore | `STORE_BACKEND=pg`, `DATABASE_URL`, `JOBHUNT_AUTH=required` + `JOBHUNT_AUTH_HASH`, `RUNNER_TOKEN_HASH`, optional `APIFY_TOKEN` |
| Public demo | PgStore (fictional) | `STORE_BACKEND=pg`, `DATABASE_URL`, `APP_MODE=demo`, `DEMO_DB_ASSERT`, `DEMO_RESET_INTERVAL_MS` and/or `DEMO_RESET_SECRET` |

- **`APP_MODE`** parses strictly (`real`|`demo`; unset ⇒ `real`) and the process refuses to boot otherwise. In `demo` the boot gate asserts the DB is positively marked (`DEMO_DB_ASSERT` must appear in `DATABASE_URL`) and that no `RUNNER_TOKEN`/`RUNNER_TOKEN_HASH`/`APIFY_TOKEN` is present — the demo refuses to start if it can see anything real.
- **Hybrid runner**: the laptop runs `node ops/agent-runner.mjs`, which polls the cloud outbound-only over HTTPS (pinned host, no http/TLS-bypass). Set `RUNNER_TOKEN` + `RUNNER_CLOUD_URL` in `~/.ssc-secrets` (JSON, outside any synced path). The cloud holds only `RUNNER_TOKEN_HASH = sha256(token)`. Enqueue is `POST /api/agent-jobs` (owner-gated, quota-limited); the runner endpoints are `/api/runner/*`.
- **Migrations** run in-platform as the release step: the container `CMD` is `npm run start:prod` = `node ops/migrate.mjs` (node-pg-migrate `up`, no-op without `DATABASE_URL`) then the server. `PgStore` refuses to serve an unmigrated database.
- **Container**: multi-stage `Dockerfile` (non-root, no Python in the final image), `/healthz` liveness probe, `PORT` (platform-injected) honoured. Build context must include `ssc-ui/` (the `file:../ssc-ui` workspace dep; vendored in the clean-repo extraction).
- **Deploy on tag**: `.github/workflows/deploy.yml` builds + pushes the image on a `v*` tag and (staged) redeploys to Railway. It is gated on the `DEPLOY_ENABLED` repo variable + the `RAILWAY_TOKEN` secret, so it stays a no-op until actual deploy time.
