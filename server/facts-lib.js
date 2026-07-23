// SIM-544 (JP-1) architecture correction, 2026-07-23 - pure helpers for the
// facts store (server/store.js, server/pg-store.js, migrations/0006_facts.cjs).
//
// The "facts trio" this app's draft/finalize stages generate from
// (docs/agent-pipeline.md): resume, professional-experience, cover-letter. Not
// laptop-local anymore - the owner decided (2026-07-23) jobhunt-cloud's own
// passphrase-protected Postgres is the correct home: this data is the owner's
// own semi-public professional content (the substance of a resume/LinkedIn
// profile), and the general file-bridge data-sovereignty framing
// (docs/data-schema.md) does not fit it. This module owns the shape/hash math
// only; no socket, no DB.

import { sha256Hex, canonicalJson } from "./sync-lib.js";

export const FACTS_KINDS = ["resume", "professional_experience", "cover_letter"];

// Mirrors track-pack-lib.js's TRACK_PACK_MAX_BLOCKS_BYTES headroom under the
// global 100kb JSON body cap (server/index.js `express.json({ limit: "100kb" })`).
export const FACTS_MAX_DOC_BYTES = 80_000;

export function isFactsKind(kind) {
  return typeof kind === "string" && FACTS_KINDS.includes(kind);
}

// Validate a PUT body for one facts kind. Strict-but-forgiving like
// track-pack-lib.js's validateTrackPackPayload: an unknown kind or oversized/
// malformed body is refused outright. Returns { ok, reason?, doc }.
export function validateFactsDoc(kind, body) {
  if (!isFactsKind(kind)) return { ok: false, reason: "unknown facts kind" };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "body must be an object" };
  }
  const json = canonicalJson(body);
  if (Buffer.byteLength(json, "utf8") > FACTS_MAX_DOC_BYTES) {
    return { ok: false, reason: `doc too large (> ${FACTS_MAX_DOC_BYTES} bytes)` };
  }
  return { ok: true, doc: body };
}

// The content hash a track pack keys off (track-pack-lib.js's cache key =
// hash of the facts files + track id). Computed HERE, server-side, from
// whatever facts are CURRENTLY stored - the server owns facts directly now,
// so this is never trusted from a caller the way it briefly was when facts
// lived on the laptop. `factsByKind` is { resume, professional_experience,
// cover_letter } (each the stored `doc`, or null/absent if that kind was
// never set - an incomplete facts set is still hashable; it just produces a
// different hash than once every kind is filled in, which is correct: a
// track pack built against incomplete facts must never satisfy a lookup made
// once the facts are complete).
const FACTS_HASH_DELIMITER = "|jp1-facts|";
export function computeFactsHash(factsByKind) {
  const parts = FACTS_KINDS.map((k) => canonicalJson((factsByKind && factsByKind[k]) || null));
  return sha256Hex(parts.join(FACTS_HASH_DELIMITER));
}
