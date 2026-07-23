// SIM-544 (JP-1) - pure unit tests for server/track-pack-lib.js. No socket, no
// DB, no fs: the hash/cache-key/validate math is exercised directly (mirrors
// how tests exercise runner-lib.js's validateSourceRunResult).

import { describe, it, expect } from "vitest";
import {
  computeContentHash,
  buildTrackPackCacheKey,
  computeStyleDigest,
  validateTrackPackPayload,
  TRACK_PACK_MAX_BLOCKS_BYTES,
} from "../server/track-pack-lib.js";

const TRACKS = ["industry_outreach_focused", "b2b_gtm_focused"];

describe("computeContentHash", () => {
  it("is deterministic and hex", () => {
    const a = computeContentHash(["resume.yaml bytes", "professional-experience.yaml bytes"]);
    const b = computeContentHash(["resume.yaml bytes", "professional-experience.yaml bytes"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any input part changes (the facts-edit invalidation rule)", () => {
    const before = computeContentHash(["resume v1", "prof-exp v1"]);
    const after = computeContentHash(["resume v2", "prof-exp v1"]);
    expect(after).not.toBe(before);
  });

  it("accepts a single non-array part too", () => {
    expect(computeContentHash("solo")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildTrackPackCacheKey", () => {
  const factsHash = computeContentHash(["x"]);

  it("builds `<track>:<factsHash>` for a known track + valid hash", () => {
    const r = buildTrackPackCacheKey({ track: TRACKS[0], factsHash }, TRACKS);
    expect(r.ok).toBe(true);
    expect(r.cacheKey).toBe(`${TRACKS[0]}:${factsHash}`);
  });

  it("refuses an unknown track", () => {
    const r = buildTrackPackCacheKey({ track: "not_a_real_track", factsHash }, TRACKS);
    expect(r.ok).toBe(false);
  });

  it("refuses a non-hex / malformed factsHash", () => {
    expect(buildTrackPackCacheKey({ track: TRACKS[0], factsHash: "not-hex!!" }, TRACKS).ok).toBe(false);
    expect(buildTrackPackCacheKey({ track: TRACKS[0], factsHash: "" }, TRACKS).ok).toBe(false);
    expect(buildTrackPackCacheKey({ track: TRACKS[0] }, TRACKS).ok).toBe(false);
  });

  it("a facts edit changes the hash, which changes the key -> only the edited track's packs go unreachable", () => {
    const h1 = computeContentHash(["resume v1"]);
    const h2 = computeContentHash(["resume v2"]);
    const k1 = buildTrackPackCacheKey({ track: TRACKS[0], factsHash: h1 }, TRACKS).cacheKey;
    const k2 = buildTrackPackCacheKey({ track: TRACKS[0], factsHash: h2 }, TRACKS).cacheKey;
    const other = buildTrackPackCacheKey({ track: TRACKS[1], factsHash: h1 }, TRACKS).cacheKey;
    expect(k1).not.toBe(k2);
    expect(other).not.toBe(k1); // a different track's key is untouched by track[0]'s facts edit
  });
});

describe("computeStyleDigest", () => {
  it("is deterministic and order-independent-safe input still hashes consistently for the SAME order", () => {
    const a = computeStyleDigest(["warm", "direct", "no-jargon"]);
    const b = computeStyleDigest(["warm", "direct", "no-jargon"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the style inputs change", () => {
    const a = computeStyleDigest(["warm", "direct"]);
    const b = computeStyleDigest(["formal", "concise"]);
    expect(a).not.toBe(b);
  });
});

describe("validateTrackPackPayload", () => {
  const factsHash = computeContentHash(["facts bytes"]);
  const validBody = () => ({
    track: TRACKS[0],
    factsHash,
    styleDigest: computeStyleDigest(["warm"]),
    blocks: { summaryBase: "Operations leader with 8 years...", heroStats: ["Cut cost 30%"] },
  });

  it("accepts a well-formed body and returns the derived cacheKey", () => {
    const v = validateTrackPackPayload(validBody(), TRACKS);
    expect(v.ok).toBe(true);
    expect(v.pack.cacheKey).toBe(`${TRACKS[0]}:${factsHash}`);
    expect(v.pack.blocks).toEqual(validBody().blocks);
  });

  it("refuses a non-object body", () => {
    expect(validateTrackPackPayload(null, TRACKS).ok).toBe(false);
    expect(validateTrackPackPayload([], TRACKS).ok).toBe(false);
    expect(validateTrackPackPayload("nope", TRACKS).ok).toBe(false);
  });

  it("refuses an unknown track", () => {
    const v = validateTrackPackPayload({ ...validBody(), track: "bogus" }, TRACKS);
    expect(v.ok).toBe(false);
  });

  it("refuses a missing/malformed blocks field", () => {
    expect(validateTrackPackPayload({ ...validBody(), blocks: undefined }, TRACKS).ok).toBe(false);
    expect(validateTrackPackPayload({ ...validBody(), blocks: "not an object" }, TRACKS).ok).toBe(false);
    expect(validateTrackPackPayload({ ...validBody(), blocks: [1, 2, 3] }, TRACKS).ok).toBe(false);
  });

  it("refuses blocks over the size cap", () => {
    const huge = { big: "x".repeat(TRACK_PACK_MAX_BLOCKS_BYTES + 1) };
    const v = validateTrackPackPayload({ ...validBody(), blocks: huge }, TRACKS);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/too large/);
  });

  it("tolerates a missing/non-string styleDigest by defaulting to empty (the concept is caller-inferred, never required to unblock a cache write)", () => {
    const v = validateTrackPackPayload({ ...validBody(), styleDigest: undefined }, TRACKS);
    expect(v.ok).toBe(true);
    expect(v.pack.styleDigest).toBe("");
  });
});
