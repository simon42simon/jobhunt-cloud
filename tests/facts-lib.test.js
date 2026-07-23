// SIM-544 (JP-1) architecture correction - pure unit tests for
// server/facts-lib.js. No socket, no DB.

import { describe, it, expect } from "vitest";
import { FACTS_KINDS, isFactsKind, validateFactsDoc, computeFactsHash, FACTS_MAX_DOC_BYTES } from "../server/facts-lib.js";

describe("FACTS_KINDS / isFactsKind", () => {
  it("is exactly the facts trio docs/agent-pipeline.md names", () => {
    expect(FACTS_KINDS).toEqual(["resume", "professional_experience", "cover_letter"]);
  });

  it("isFactsKind accepts only the trio", () => {
    for (const k of FACTS_KINDS) expect(isFactsKind(k)).toBe(true);
    expect(isFactsKind("bogus")).toBe(false);
    expect(isFactsKind(null)).toBe(false);
    expect(isFactsKind(123)).toBe(false);
  });
});

describe("validateFactsDoc", () => {
  const doc = { title_line: "Operations Leader", summary_base: "8 years of..." };

  it("accepts a well-formed doc for a known kind", () => {
    const v = validateFactsDoc("resume", doc);
    expect(v.ok).toBe(true);
    expect(v.doc).toEqual(doc);
  });

  it("refuses an unknown kind", () => {
    expect(validateFactsDoc("bogus", doc).ok).toBe(false);
  });

  it("refuses a non-object body", () => {
    expect(validateFactsDoc("resume", null).ok).toBe(false);
    expect(validateFactsDoc("resume", []).ok).toBe(false);
    expect(validateFactsDoc("resume", "nope").ok).toBe(false);
  });

  it("refuses a doc over the size cap", () => {
    const huge = { big: "x".repeat(FACTS_MAX_DOC_BYTES + 1) };
    const v = validateFactsDoc("resume", huge);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/too large/);
  });
});

describe("computeFactsHash", () => {
  it("is deterministic for the same facts", () => {
    const facts = { resume: { a: 1 }, professional_experience: { b: 2 }, cover_letter: { c: 3 } };
    expect(computeFactsHash(facts)).toBe(computeFactsHash(facts));
    expect(computeFactsHash(facts)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when ANY one kind's doc changes (the facts-edit invalidation rule)", () => {
    const base = { resume: { a: 1 }, professional_experience: { b: 2 }, cover_letter: { c: 3 } };
    const editedResume = { ...base, resume: { a: 2 } };
    const editedProfExp = { ...base, professional_experience: { b: 3 } };
    const h0 = computeFactsHash(base);
    expect(computeFactsHash(editedResume)).not.toBe(h0);
    expect(computeFactsHash(editedProfExp)).not.toBe(h0);
  });

  it("is stable under key order (canonicalJson sorts keys)", () => {
    const a = computeFactsHash({ resume: { x: 1, y: 2 }, professional_experience: null, cover_letter: null });
    const b = computeFactsHash({ resume: { y: 2, x: 1 }, professional_experience: null, cover_letter: null });
    expect(a).toBe(b);
  });

  it("handles a partially-populated or entirely empty facts set without throwing (still hashable, just a different hash)", () => {
    const empty = computeFactsHash({});
    const partial = computeFactsHash({ resume: { a: 1 } });
    const full = computeFactsHash({ resume: { a: 1 }, professional_experience: { b: 2 }, cover_letter: { c: 3 } });
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
    expect(partial).not.toBe(empty);
    expect(full).not.toBe(partial);
  });

  it("treats a missing kind and an explicit null the same way", () => {
    expect(computeFactsHash({ resume: { a: 1 } })).toBe(computeFactsHash({ resume: { a: 1 }, professional_experience: null, cover_letter: null }));
  });
});
