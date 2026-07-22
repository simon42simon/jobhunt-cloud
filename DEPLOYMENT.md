# Deployment & release process

This app runs in **two modes**: (1) **local-first, single-user** on your machine against your vault, and (2) **hosted on Railway** (RFC v2-008) — a private instance with real data behind auth, and a public demo with fictional seed data. The same image serves all of them, differentiated only by env (Dockerfile header / design §6). Since **cc-staging** (SIM-403, RFC v2-010 S1) the hosted path has a real **dev → staging → production** lane; the local path keeps its lighter git-mapped process below.

## Environments (mapped to reality)

| Classic term | Here |
| --- | --- |
| Local dev | `npm run dev` on your machine - Vite UI on `:5180`, Express file-bridge on `:8787`. One process, owned by the main session; do not run a second. |
| Local "staging" | A git branch (or worktree) where a change is built and `npm run check` is run before it reaches `main`. |
| **Cloud staging** | A Railway `staging` environment running the SAME image with **seeded fictional data only** (never real data — guardian-gated, G9), auth on, scale-to-zero. A `v*` tag auto-deploys here first (`.github/workflows/deploy.yml`). |
| Production (local) | `main` + the latest `vX.Y.Z` tag - the version you run daily on your machine. |
| **Production (cloud)** | The Railway `production` environment. Reached ONLY by promoting the same image tag that passed cloud staging — no rebuild. Gated by the `production` GitHub Environment's required-reviewer (the go-live GO). |

## Cloud release lane (dev → staging → production, same-tag)

The full standing SOP is **`company-os/docs/sop-release-promotion.md`**. In brief:

1. `npm run check` green (unchanged dev gate) → cut a `vX.Y.Z` tag.
2. The tag auto-builds the image once, pushes `ghcr.io/…:vX.Y.Z`, retags the `staging-current` channel alias to it (registry-side, same digest, no rebuild), and redeploys the **staging** Railway service, which is pinned to `:staging-current` (`deploy.yml` → `build-and-stage`, gated on the `DEPLOY_ENABLED` variable + `RAILWAY_STAGING_TOKEN` secret).
3. Guardian `/security-review` of real-data isolation is GREEN in writing; the qa-tester walks the release journeys against the staging URL and fills the QA scorecard.
4. On a clean pass, run the **deploy** workflow's `workflow_dispatch` with the tag to promote → the `production` Environment pauses for the owner's approval (the go-live GO) → the `production-current` alias is retagged to the SAME digest and the production service (pinned to `:production-current`) re-pulls it. No rebuild (`RAILWAY_PRODUCTION_TOKEN` secret).
5. Verify the production surface is healthy.

Railway topology (verified 2026-07-21): project **jobhunt-private**, service **`app`**, environments **`staging`** (`APP_MODE=demo` fictional seed, auth on, serverless/scale-to-zero, `/healthz` healthcheck) and **`production`**. Repo vars: `RAILWAY_SERVICE=app`; per-environment Railway **project tokens** (least privilege) live in the two secrets above. (The public demo is a separate project, **jobhunt-demo**, outside this release lane.)

Rollback = promote a previous tag (every release is an immutable image tag).

### Connecting a service to the image channel (one-time bootstrap, per environment)

The whole lane rests on each Railway service being **pinned to its channel alias tag** — the workflow only moves registry tags and asks Railway to re-pull. A service whose Source is *not* connected to the image (e.g. it was ever `railway up`-loaded from the CLI) turns every deploy into a **silent no-op**: `railway redeploy` succeeds but re-ships the last CLI snapshot (SIM-487 — this is exactly how a staging-verified fix stayed off production while the promote reported SUCCESS; sibling of the SIM-463 gotcha "redeploy cannot create a FIRST deployment").

For **each** environment of the `app` service (owner, in the Railway dashboard):

1. Railway → **jobhunt-private** → `app` service → pick the environment → **Settings → Source → Connect Image**.
2. Image: `ghcr.io/simon42simon/jobhunt-cloud:staging-current` (staging) / `ghcr.io/simon42simon/jobhunt-cloud:production-current` (production).
3. Registry credentials (the GHCR package is private): username `simon42simon`, password = a GitHub PAT with `read:packages`. If that PAT is ever rotated/expired, update it here too — pulls fail otherwise.
4. Railway auto-deploys on connect; confirm the new deployment's metadata shows the image + digest.

Status: **done for both environments** (staging 2026-07-21 build-out; production connected 2026-07-21 ~20:35Z, verified 2026-07-22).

Since SIM-487 the workflow **verifies every deploy** (`.github/scripts/verify-railway-deploy.sh`): after each `railway redeploy` it asserts via the Railway API that a *new* deployment reached SUCCESS whose `image`/`imageDigest` equal the GHCR digest of the tag being shipped, then probes the live `/healthz`. A disconnected source, wrong pin, stale pull, or dead deploy now **fails the workflow run** instead of reporting a phantom success.

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

## WebAuthn passkey second factor (SIM-394; feature-flagged, off by default)

The private cloud instance can require a **passkey (WebAuthn) as a SECOND factor after the passphrase**. The passphrase stays the first factor, unchanged. The whole feature is gated by `JOBHUNT_WEBAUTHN`: **absent or `off` ⇒ byte-identical current behavior** (no `/api/webauthn/*` endpoints exist, login issues the session on the passphrase alone, `GET /api/auth/status` body is unchanged — the same no-op standard as SIM-386, pinned by tests).

### Break-glass (read this FIRST — before enabling anything)

If passkeys ever lock you out (lost authenticator, browser/RP mismatch, broken enrollment):

1. **Flip the flag off**: in Railway → the jobhunt-private service → Variables, set `JOBHUNT_WEBAUTHN=off` (or delete the variable) and redeploy/restart. That single env flip restores **passphrase-only login exactly as before** — no data migration, no code change, no credential cleanup needed. The stored passkey rows are inert while the flag is off.
2. **Log in with the passphrase** as usual.
3. **Re-enroll**: fix or replace the authenticators (delete stale ones in the passkey manager, add new ones), then set `JOBHUNT_WEBAUTHN=on` again once ≥ 2 passkeys are registered.

**If ALL passkeys are lost** (every device gone): the same procedure applies — the passphrase is the recovery credential by design. `JOBHUNT_WEBAUTHN=off` → passphrase login → delete every stale credential in the passkey manager → enroll ≥ 2 new passkeys (ideally on independent devices, e.g. laptop platform authenticator + phone) → flip the flag back on. If the passphrase itself is ALSO lost, that is the pre-existing recovery path (re-provision `JOBHUNT_AUTH_HASH` via `ops/auth-setup.mjs`), unchanged by this feature.

Because the flag is only an env read at request time, there is no state in which the app can lock the owner out irrecoverably: env access to the deployment IS the break-glass key.

### Anti-lockout: the ≥ 2-authenticator rule (enrollment mode)

Enforcement **refuses to arm itself until at least 2 passkeys are registered**. Precisely:

- `JOBHUNT_WEBAUTHN=on` with **fewer than 2** stored credentials = **enrollment mode**: login remains passphrase-only (the session is issued on the passphrase exactly as with the flag off), `/api/webauthn/*` endpoints are live so passkeys can be added, and the UI nags after login to finish enrollment. You can never enable your way into a lockout with 0 or 1 credentials.
- `JOBHUNT_WEBAUTHN=on` with **≥ 2** stored credentials = **enforced**: a correct passphrase no longer issues a session; it issues a short-lived (5-min) httpOnly *pending* cookie (signed with a key derived from — but distinct from — the session secret, so it can never pass the session gate), and only a verified passkey assertion converts it into the real session cookie.
- Deleting credentials past the floor is refused server-side: with the flag on, the **last remaining credential cannot be deleted** (HTTP 409); deleting down from 2 to 1 is allowed and simply drops the instance back into enrollment mode (passphrase-only login again — never a lockout).
- Sessions issued before the flag flip stay valid until their normal expiry (7 days); flipping the flag does not revoke them.

### Enrollment runbook (Simon, at a browser)

1. Deploy with `JOBHUNT_WEBAUTHN=on` + `JOBHUNT_WEBAUTHN_RPID` + `JOBHUNT_WEBAUTHN_ORIGIN` set (see the table below). With 0 credentials this is enrollment mode — nothing is enforced yet.
2. Open the private instance, log in with the passphrase. A banner nags that passkey enrollment is incomplete.
3. Open the **Passkeys** panel (button bottom-right / the banner's "Manage passkeys"), choose **Add passkey**, give it a label (e.g. "laptop-touchid"), and complete the browser prompt.
4. Repeat on a **second, independent authenticator** (e.g. the phone, or a hardware key) — labels keep them tellable-apart.
5. When the list shows **2 registered passkeys**, enforcement arms automatically on the next login: passphrase → passkey prompt → in.
6. Verify break-glass once while calm: set `JOBHUNT_WEBAUTHN=off`, confirm passphrase-only login works, set it back to `on`.

### Env vars

| Env var | Purpose |
| --- | --- |
| `JOBHUNT_WEBAUTHN` | `on` enables the second factor (subject to the ≥ 2-credential rule); absent/`off` ⇒ byte-identical current behavior; any other value fails the boot loudly (strict parse, same posture as `APP_MODE`). |
| `JOBHUNT_WEBAUTHN_RPID` | The WebAuthn Relying Party ID = the private instance's domain, no scheme (e.g. `jobhunt.example.up.railway.app`). Required when the flag is on; never hardcoded. |
| `JOBHUNT_WEBAUTHN_ORIGIN` | The exact expected origin (e.g. `https://jobhunt.example.up.railway.app`). Required when the flag is on. |
| `JOBHUNT_WEBAUTHN_RPNAME` | Optional display name shown by the browser prompt (default "Jobhunt Command Center"). |
| `JOBHUNT_WEBAUTHN_CHALLENGE_TTL_MS` | Ceremony challenge lifetime (default 120000). Test/tuning knob. |

`JOBHUNT_WEBAUTHN=on` additionally **requires auth to be enabled** (a second factor without a first is a misconfig; the boot fails loudly, mirroring `JOBHUNT_AUTH=required` without a hash). The demo (auth off) can therefore never turn it on.

### What is stored / recorded

- Credential records (both store backends, via the store seam; Postgres table `webauthn_credentials`, migration `0004`): credential id, COSE public key, signature counter, transports, label, created date. **No biometric data, no private key material — those never leave the authenticator.**
- Ceremony challenges are held **in memory only** (server-held TTL map, single-use). This is a deliberate, documented departure from the stateless-session design; it assumes the single-instance deployment (see the code comment in `server/webauthn.js`).
- Failed second-factor attempts feed the SIM-386 failed-login monitor (`surface:"webauthn"`, whitelisted fields, bounded durable writes, threshold notification) — never any credential material. Counter regressions (a cloned-authenticator signal) are rejected and recorded the same way.
- The passkey login/verify endpoints are rate-limited with the same limiter/knobs as the passphrase login.

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
