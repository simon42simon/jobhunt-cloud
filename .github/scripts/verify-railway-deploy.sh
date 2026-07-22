#!/usr/bin/env bash
# verify-railway-deploy.sh (SIM-487): a Railway redeploy that ships nothing must
# FAIL the workflow. `railway redeploy` reports success even when the service's
# source is not the image channel alias (it just re-ships the last uploaded
# snapshot) - that silent no-op is how a staging-verified fix stayed off
# production while the promote lane reported SUCCESS. This script closes the
# gap: after a redeploy it polls the Railway GraphQL API for the deployment the
# redeploy actually created and asserts, hard, that
#   (1) a NEW deployment exists (id != the pre-redeploy baseline),
#   (2) it reached SUCCESS (a FAILED/CRASHED deploy fails the run),
#   (3) its meta.image is the expected channel alias (e.g. :production-current),
#   (4) its meta.imageDigest equals the GHCR digest of the promoted tag,
#   (5) best-effort: the service's public /healthz answers 200.
# A CLI-snapshot deployment carries a Dockerfile/RAILPACK build manifest and a
# digest that cannot match the registry tag, so the original failure mode is
# caught by (3)+(4) even if (1) races.
#
# Auth: the workflow's environment-scoped Railway PROJECT token, passed via the
# Project-Access-Token header (project tokens cannot use Authorization: Bearer).
# The token pins project+environment server-side; the service is resolved by
# name within that project.
#
# Usage:
#   RAILWAY_TOKEN=... SERVICE_NAME=app  verify-railway-deploy.sh latest-id
#     -> prints the current latest deployment id (capture BEFORE redeploy)
#   RAILWAY_TOKEN=... SERVICE_NAME=app EXPECTED_IMAGE=ghcr.io/...:production-current \
#   EXPECTED_DIGEST=sha256:... [BASELINE_DEPLOYMENT_ID=...] [TIMEOUT_SECS=420] \
#     verify-railway-deploy.sh verify
set -euo pipefail

: "${RAILWAY_TOKEN:?RAILWAY_TOKEN (project token) is required}"
: "${SERVICE_NAME:?SERVICE_NAME is required}"
CMD="${1:?usage: verify-railway-deploy.sh latest-id|verify}"

API="https://backboard.railway.com/graphql/v2"

gql() { # $1 = JSON body; prints response body, fails on transport error
  curl -sf -X POST "$API" \
    -H "Project-Access-Token: $RAILWAY_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$1"
}

fail() { echo "::error::$*" >&2; exit 1; }

# ---- resolve project/environment (from the token) + service id by name ------
scope=$(gql '{"query":"query{projectToken{projectId environmentId}}"}') ||
  fail "Railway API unreachable or the project token was rejected"
PROJECT_ID=$(jq -re '.data.projectToken.projectId' <<<"$scope" 2>/dev/null) ||
  fail "could not resolve projectId from the project token: $scope"
ENVIRONMENT_ID=$(jq -re '.data.projectToken.environmentId' <<<"$scope")

services=$(gql "$(jq -nc --arg p "$PROJECT_ID" \
  '{query:"query($p:String!){project(id:$p){services{edges{node{id name}}}}}",variables:{p:$p}}')")
SERVICE_ID=$(jq -re --arg n "$SERVICE_NAME" \
  '.data.project.services.edges[].node | select(.name==$n) | .id' <<<"$services") ||
  fail "service '$SERVICE_NAME' not found in project $PROJECT_ID: $services"

latest_deployment() { # prints one JSON node {id,status,staticUrl,createdAt,meta}
  gql "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg s "$SERVICE_ID" \
    '{query:"query($p:String!,$e:String!,$s:String!){deployments(first:1,input:{projectId:$p,environmentId:$e,serviceId:$s}){edges{node{id status staticUrl createdAt meta}}}}",variables:{p:$p,e:$e,s:$s}}')" |
    jq -c '.data.deployments.edges[0].node // empty'
}

if [ "$CMD" = "latest-id" ]; then
  node_json=$(latest_deployment)
  # An empty history is a legal baseline (first-ever deploy): print nothing.
  [ -n "$node_json" ] && jq -r '.id' <<<"$node_json"
  exit 0
fi

[ "$CMD" = "verify" ] || fail "unknown command '$CMD' (expected latest-id|verify)"
: "${EXPECTED_IMAGE:?EXPECTED_IMAGE is required for verify}"
: "${EXPECTED_DIGEST:?EXPECTED_DIGEST is required for verify}"
BASELINE_DEPLOYMENT_ID="${BASELINE_DEPLOYMENT_ID:-}"
TIMEOUT_SECS="${TIMEOUT_SECS:-420}"

echo "verify: service '$SERVICE_NAME' ($SERVICE_ID) env $ENVIRONMENT_ID"
echo "verify: expecting image $EXPECTED_IMAGE @ $EXPECTED_DIGEST"
[ -n "$BASELINE_DEPLOYMENT_ID" ] && echo "verify: pre-redeploy baseline deployment $BASELINE_DEPLOYMENT_ID"

deadline=$(( $(date +%s) + TIMEOUT_SECS ))
node_json=""
while :; do
  node_json=$(latest_deployment)
  id=$(jq -r '.id // empty' <<<"$node_json")
  status=$(jq -r '.status // empty' <<<"$node_json")
  if [ -n "$id" ] && [ "$id" != "$BASELINE_DEPLOYMENT_ID" ]; then
    case "$status" in
      SUCCESS) break ;;
      FAILED|CRASHED|REMOVED|SKIPPED)
        fail "deployment $id ended $status - the redeploy did not go live" ;;
      *) echo "waiting: deployment $id is $status ..." ;;
    esac
  else
    echo "waiting: no new deployment yet (latest: ${id:-none} = baseline) ..."
  fi
  [ "$(date +%s)" -lt "$deadline" ] || fail "timed out after ${TIMEOUT_SECS}s waiting for a NEW SUCCESS deployment (latest: ${id:-none}, status: ${status:-n/a}). If no new deployment ever appeared, the redeploy was a silent no-op."
  sleep 10
done

image=$(jq -r '.meta.image // empty' <<<"$node_json")
digest=$(jq -r '.meta.imageDigest // empty' <<<"$node_json")
echo "deployment $id: SUCCESS, image='${image:-<none>}', digest='${digest:-<none>}'"

# (3) image source: a CLI-snapshot deploy has no meta.image at all - the exact
# SIM-487 failure mode ("service has no source connected"). Name it in the error.
[ -n "$image" ] ||
  fail "deployment $id has NO image in its metadata - the service is not connected to the image registry (Settings -> Source -> Connect Image). This redeploy re-shipped a CLI snapshot: the promote was a NO-OP."
[ "$image" = "$EXPECTED_IMAGE" ] ||
  fail "deployment $id pulled '$image', expected '$EXPECTED_IMAGE' - the service is pinned to the wrong image/tag"

# (4) digest: the deployed bytes are the promoted tag's bytes.
[ -n "$digest" ] || fail "deployment $id has no imageDigest in its metadata - cannot prove what was deployed"
[ "$digest" = "$EXPECTED_DIGEST" ] ||
  fail "deployed digest $digest != promoted tag digest $EXPECTED_DIGEST - the channel alias did not move or the platform pulled a stale image"

# (5) surface probe, best-effort but loud: scale-to-zero wake can take a few tries.
static_url=$(jq -r '.staticUrl // empty' <<<"$node_json")
if [ -n "$static_url" ]; then
  ok=""
  for i in $(seq 1 9); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$static_url/healthz" || true)
    if [ "$code" = "200" ]; then ok=1; echo "healthz probe: 200 on https://$static_url/healthz"; break; fi
    echo "healthz probe attempt $i: got '${code:-error}', retrying ..."
    sleep 10
  done
  [ -n "$ok" ] || fail "deployed service never answered 200 on https://$static_url/healthz"
else
  echo "::warning::deployment has no staticUrl - skipping the /healthz probe"
fi

echo "VERIFIED: deployment $id serves $EXPECTED_IMAGE @ $EXPECTED_DIGEST and answers /healthz."
