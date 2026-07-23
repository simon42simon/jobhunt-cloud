// SIM-544 (JP-1) - pure unit tests for server/track-pack-lib.js. No socket, no
// DB, no fs: the cache-key/validate math is exercised directly (mirrors how
// tests exercise runner-lib.js's validateSourceRunResult). factsHash values
// used here are just arbitrary-but-valid hex strings - computing a REAL
// factsHash from stored facts is server/facts-lib.js's computeFactsHash,
// covered in tests/facts-lib.test.js.

import { describe, it, expect } from "vitest";
import { buildTrackPackCacheKey, computeStyleDigest, validateTrackPackPayload, TRACK_PACK_MAX_BLOCKS_BYTES } from "../server/track-pack-lib.js";
import { sha256Hex } from "../server/sync-lib.js";

const TRACKS = ["industry_outreach_focused", "b2b_gtm_focused"];
const hash = (s) => sha256Hex(s);

describe("buildTrackPackCacheKey", () => {
  const factsHash = hash("x");

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
    const h1 = hash("resume v1");
    const h2 = hash("resume v2");
    const k1 = buildTrackPackCacheKey({ track: TRACKS[0], factsHash: h1 }, TRACKS).cacheKey;
    const k2 = buildTrackPackCacheKey({ track: TRACKS[0], factsHash: h2 }, TRACKS).cacheKey;
    const other = buildTrackPackCacheKey({ track: TRACKS[1], factsHash: h1 }, TRACKS).cacheKey;
    expect(k1).not.toBe(k2);
    expect(other).not.toBe(k1); // a different track's key is untouched by track[0]'s facts edit
  });
});

describe("computeStyleDigest", () => {
  it("is deterministic for the same input", () => {
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

describe("validateTrackPackPayload(track, factsHash, body, tracks)", () => {
  const factsHash = hash("facts bytes");
  const validBody = () => ({
    styleDigest: computeStyleDigest(["warm"]),
    blocks: { summaryBase: "Operations leader with 8 years...", heroStats: ["Cut cost 30%"] },
  });

  it("accepts a well-formed body and returns the derived cacheKey (track + factsHash come from the CALLER, not the body)", () => {
    const v = validateTrackPackPayload(TRACKS[0], factsHash, validBody(), TRACKS);
    expect(v.ok).toBe(true);
    expect(v.pack.cacheKey).toBe(`${TRACKS[0]}:${factsHash}`);
    expect(v.pack.track).toBe(TRACKS[0]);
    expect(v.pack.factsHash).toBe(factsHash);
    expect(v.pack.blocks).toEqual(validBody().blocks);
  });

  it("refuses an unknown track (still validated - the URL param is client-supplied even though factsHash is not)", () => {
    const v = validateTrackPackPayload("bogus_track", factsHash, validBody(), TRACKS);
    expect(v.ok).toBe(false);
  });

  it("refuses a malformed factsHash", () => {
    expect(validateTrackPackPayload(TRACKS[0], "not-hex", validBody(), TRACKS).ok).toBe(false);
  });

  it("refuses a non-object body", () => {
    expect(validateTrackPackPayload(TRACKS[0], factsHash, null, TRACKS).ok).toBe(false);
    expect(validateTrackPackPayload(TRACKS[0], factsHash, [], TRACKS).ok).toBe(false);
    expect(validateTrackPackPayload(TRACKS[0], factsHash, "nope", TRACKS).ok).toBe(false);
  });

  it("refuses a missing/malformed blocks field", () => {
    expect(validateTrackPackPayload(TRACKS[0], factsHash, { ...validBody(), blocks: undefined }, TRACKS).ok).toBe(false);
    expect(validateTrackPackPayload(TRACKS[0], factsHash, { ...validBody(), blocks: "not an object" }, TRACKS).ok).toBe(false);
    expect(validateTrackPackPayload(TRACKS[0], factsHash, { ...validBody(), blocks: [1, 2, 3] }, TRACKS).ok).toBe(false);
  });

  it("refuses blocks over the size cap", () => {
    const huge = { big: "x".repeat(TRACK_PACK_MAX_BLOCKS_BYTES + 1) };
    const v = validateTrackPackPayload(TRACKS[0], factsHash, { ...validBody(), blocks: huge }, TRACKS);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/too large/);
  });

  it("tolerates a missing/non-string styleDigest by defaulting to empty (the concept is caller-inferred, never required to unblock a cache write)", () => {
    const v = validateTrackPackPayload(TRACKS[0], factsHash, { ...validBody(), styleDigest: undefined }, TRACKS);
    expect(v.ok).toBe(true);
    expect(v.pack.styleDigest).toBe("");
  });
});
