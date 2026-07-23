---
type: runbook
title: "Production image wiring — jobhunt-private + jobhunt-demo (SIM-442)"
owner: release-manager
status: jobhunt-private DONE (verified 2026-07-23) · jobhunt-demo BLOCKED (owner decision needed)
review: on any Railway plan/billing change, or when jobhunt-demo gets wired
---

# Production image wiring runbook (SIM-442)

**What this is:** SIM-442 found that the promote-to-production step of the release pipeline
(`deploy.yml` → `promote-production` → `railway redeploy`) could silently no-op, because the
target Railway service wasn't configured to pull from the image channel alias it was being
retagged to (`ghcr.io/simon42simon/jobhunt-cloud:production-current`). This runbook is the
current, verified state of that wiring per instance, exact commands to re-verify or redo it, and
rollback.

## jobhunt-private (`app-production-62c9`) — DONE, verified live 2026-07-23

**This is the real-data app. Its wiring is READ-ONLY from an automated session — any change to
it executes only on the owner/integrator's explicit OK, never unattended.** The check below is
read-only and safe to re-run any time.

Verified via the Railway GraphQL API (`https://backboard.railway.com/graphql/v2`,
`serviceInstance(environmentId, serviceId){ source{image} latestDeployment{...} }`):

- `source.image` = `ghcr.io/simon42simon/jobhunt-cloud:production-current`
- `latestDeployment.meta.imageDigest` = `sha256:57775c43a1f0addebfc309d76a30db9da98b173848b8601e17a412be1c7e8bc9`, **identical** to staging's digest at the same moment — same-tag promote is genuinely landing, not restarting a stale CLI snapshot.
- The `deploy.yml` `promote-production` job has run **5 times successfully** via `workflow_dispatch` since this was wired (v0.39.0, v0.39.1, v0.40.0, v0.41.0, v0.41.1 — 2026-07-22 through 2026-07-23), each followed by a passing `verify-railway-deploy.sh` (new deployment, SUCCESS, matching image+digest, `/healthz` 200).
- Read-only `/healthz` probe (2026-07-23): `200`.

**Conclusion: SIM-442's cause #1 (prod app service not wired to the image tag) was already fixed
for jobhunt-private before this session — most likely as part of the 2026-07-21/22 cc-staging
build-out (DEPLOYMENT.md already claimed "done," this just re-proves it against live state and
5 real promotes). The ticket had simply never been closed against that fact.**

### How to re-verify (read-only, safe anytime)

Dashboard: Railway → **jobhunt-private** → `app` service → **production** environment →
Deployments tab → confirm the latest deployment's source shows the `production-current` image
tag and a digest, then hit `https://app-production-62c9.up.railway.app/healthz`.

API (same check, no dashboard needed): query `serviceInstance` for
`environmentId=2648b855-c6a2-418f-9896-3145852a771f`,
`serviceId=16b3b97d-48b8-4a63-bc80-c2f41788c148` and confirm `source.image` ends in
`:production-current` and `latestDeployment.status` is `SUCCESS`.

### Rollback

Every release is an immutable image tag (`vX.Y.Z`). To roll production back:
`gh workflow run deploy.yml -f promote_tag=vX.Y.Z` (prior tag) — this retags
`production-current` to that tag's digest (no rebuild) and re-deploys. Requires the same
`production` GitHub Environment approval gate as any promote. There is no "undo wiring" step —
the wiring (service source → channel alias) is a one-time, durable Railway setting; rollback
only ever moves *which tag* the alias points at.

## jobhunt-demo (`app-production-d8f5`) — BLOCKED, needs an owner decision

**Still exactly as SIM-442 found it: source is unset (`null`)**, still serving whatever was last
`railway up`-loaded from the CLI on 2026-07-18. This session attempted the fix DO NOW called for
— wire it to `ghcr.io/simon42simon/jobhunt-cloud:production-current` via the Railway API,
`serviceInstanceUpdate(environmentId, serviceId, {source:{image}, registryCredentials:{...}})`
— and it failed cleanly (no partial state written, re-verified): **`"Private registry
credentials can only be set for Pro users. Please upgrade if you'd like to use private registry
credentials."`**

The jobhunt-demo Railway project is on a plan tier that doesn't allow private-registry source
connections (jobhunt-private evidently already had this configured, or is on a different tier —
same workspace, both `team: null`, so this is a per-project/account entitlement, not a
team-membership difference). Two ways to unblock, both owner calls:

1. **Upgrade the Railway plan** covering jobhunt-demo to whatever tier unlocks private registry
   credentials (Pro). Ongoing cost — check current Railway pricing before deciding.
2. **Make the `jobhunt-cloud` GHCR package public.** The image is a compiled container (built
   frontend + backend), not raw source, but it's still a judgment call on what's acceptable to
   expose publicly for a job-search tool — not mine to make unilaterally. If chosen, drop the
   `registryCredentials` block entirely in the `serviceInstanceUpdate` call below (public images
   need no auth) and the Pro-plan gate no longer applies.

Once either is decided, the wiring itself is one API call (or the Settings → Source → Connect
Image dashboard flow, same as jobhunt-private's original bootstrap):

```
mutation($e:String!,$s:String!,$i:ServiceInstanceUpdateInput!){
  serviceInstanceUpdate(environmentId:$e, serviceId:$s, input:$i)
}
# environmentId = b2ce65b5-122a-4ec8-9051-8d9c41b52cba (jobhunt-demo production)
# serviceId     = 08b9c8dd-92fe-4025-b80b-4de4b57f49b8 (app)
# input.source.image = "ghcr.io/simon42simon/jobhunt-cloud:production-current"
# input.registryCredentials = {username:"simon42simon", password:<GHCR PAT with read:packages>}
#   (omit registryCredentials entirely if the package is made public instead)
```

Then a `serviceInstanceRedeploy` (or the dashboard's own auto-deploy-on-connect) and the same
verify pattern used for staging: confirm a new `SUCCESS` deployment, `image`/`imageDigest` match,
`/healthz` 200.

**Rehearsed the surrounding mechanism on the piece that IS writable (staging) instead**, since
demo itself is blocked: triggered a real `serviceInstanceRedeploy` on jobhunt-private staging,
confirmed a NEW deployment id (not the pre-redeploy baseline), `SUCCESS`, correct
image+digest, and `/healthz` 200 — proving the exact SIM-487 failure mode (a redeploy that
silently re-ships a stale snapshot) does NOT reproduce on a correctly-wired service.

## Out-of-fence note

The standing SOP at `company-os/docs/how-to/sop-release-promotion.md` still carries the
first-travel-era caution *"Until SIM-442 lands, treat the promote as not-yet-landing on
production."* That's now stale for jobhunt-private (proven landing, 5/5) though still accurate
for jobhunt-demo. `docs/` in company-os is outside this session's write fence (ops-truth owns
it this Rodeo) — flagging for the integrator to correct the SOP's changelog rather than editing
it here.
