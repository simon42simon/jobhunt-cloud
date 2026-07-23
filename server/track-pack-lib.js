// SIM-544 (JP-1) - pure, importable helpers for the track-pack reuse machinery
// (docs/agent-pipeline.md "module split"). No socket, no DB, no fs - mirrors the
// runner-lib.js / sync-lib.js posture so the cache-key/hash math is unit-tested
// directly and shared by both store backends without drift.
//
// A "track pack" is the facts-stable generation blocks (CV skeleton, achievement
// pool, cover-letter openings/closings/hero phrases - docs/agent-pipeline.md
// "Facts-stable blocks") for ONE (track, facts-version), cached content-addressed
// so every later job on that track reuses it instead of re-deriving it.
//
// Architecture correction (2026-07-23): facts (server/facts-lib.js) now live in
// jobhunt-cloud's own Postgres, not on the laptop, so `factsHash` is something
// THIS SERVER computes itself (facts-lib.js computeFactsHash) from what it
// already stores - never a value a caller supplies. `track` still arrives from
// the route (a URL param, owner/agent-chosen), which is why buildTrackPackCacheKey
// keeps validating it against the enum allowlist; `factsHash` is trusted because
// the caller of these functions is server/index.js itself, not the network.

import { sha256Hex, canonicalJson } from "./sync-lib.js";

// Bounds mirror runner-lib.js's SOURCE_RUN_* discipline (MF-4 posture): every
// cached blob is size- and shape-capped so a malformed/oversized pack can never
// wedge the store or blow the global 100kb JSON body limit (server/index.js
// `app.use(express.json({ limit: "100kb" }))`) - kept comfortably under it.
export const TRACK_PACK_MAX_BLOCKS_BYTES = 80_000;
export const TRACK_PACK_HASH_RE = /^[0-9a-f]{16,64}$/; // a hex content hash

// Cache key = hash of the facts + track id (docs/agent-pipeline.md, module
// split section) - human-legible (the track is visible at a glance) and
// content-addressed (factsHash alone determines reuse-vs-recompute; a facts
// edit that changes the hash naturally invalidates exactly the affected
// track's packs - no explicit delete needed). `tracks` is the caller's enum
// allowlist (index.js's JOB_ENUM_FIELDS.track) so this pure module never
// needs the app's enum table.
export function buildTrackPackCacheKey({ track, factsHash }, tracks) {
  if (!track || (Array.isArray(tracks) && !tracks.includes(track))) {
    return { ok: false, reason: "unknown track" };
  }
  if (typeof factsHash !== "string" || !TRACK_PACK_HASH_RE.test(factsHash)) {
    return { ok: false, reason: "factsHash must be a hex content hash" };
  }
  return { ok: true, cacheKey: `${track}:${factsHash}` };
}

// Style-digest (SIM-544's title says "style-digest threading"; UNDOCUMENTED
// beyond the ticket title as of this implementation - docs/agent-pipeline.md
// never uses the word "style" anywhere, and no prior art exists in either
// jobhunt-cloud or company-os). Interpreted here as: a fingerprint of the
// VOICE/tone choices baked into a track pack's blocks (opening phrasing, hero
// phrases, summary base - the WRITING choices, not the underlying facts),
// threaded alongside the content hash so a later draft run can confirm "same
// established voice" without re-deriving it, and so a future voice-only edit
// (re-phrase the SAME facts) could invalidate a pack even though factsHash is
// unchanged. THIS IS AN INFERENCE, not a confirmed spec - flag it for the
// ticket author before a real caller depends on the distinction; the field
// stays a plain opaque string end to end (this module never interprets its
// contents, only stores/threads it), so a corrected definition costs nothing
// to swap in later.
export function computeStyleDigest(styleInputs) {
  const arr = Array.isArray(styleInputs) ? styleInputs : [styleInputs];
  return sha256Hex(canonicalJson(arr.map((p) => String(p == null ? "" : p))));
}

// Validate a track-pack PUT body ({ styleDigest?, blocks }) against a SERVER-
// DERIVED track + factsHash (never body-supplied - see the file header).
// Strict-but-forgiving like validateSourceRunResult (runner-lib.js): a
// malformed/oversized body is refused outright - a cache write is not a place
// to silently coerce. Returns { ok, reason?, pack }.
export function validateTrackPackPayload(track, factsHash, body, tracks) {
  const keyCheck = buildTrackPackCacheKey({ track, factsHash }, tracks);
  if (!keyCheck.ok) return keyCheck;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "body must be an object" };
  }
  const styleDigest = typeof body.styleDigest === "string" ? body.styleDigest.trim().slice(0, 128) : "";
  if (!body.blocks || typeof body.blocks !== "object" || Array.isArray(body.blocks)) {
    return { ok: false, reason: "blocks must be an object" };
  }
  const blocksJson = canonicalJson(body.blocks);
  if (Buffer.byteLength(blocksJson, "utf8") > TRACK_PACK_MAX_BLOCKS_BYTES) {
    return { ok: false, reason: `blocks too large (> ${TRACK_PACK_MAX_BLOCKS_BYTES} bytes)` };
  }
  return {
    ok: true,
    pack: {
      cacheKey: keyCheck.cacheKey,
      track,
      factsHash,
      styleDigest,
      blocks: body.blocks,
    },
  };
}
