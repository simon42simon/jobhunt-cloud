import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  APIFY_INPUT_PLACEHOLDER,
  APIFY_INPUT_STUB,
  SOURCE_TYPES,
  SOURCE_TYPE_LABEL,
  parseApifyInput,
  validateApifyDraft,
} from "../src/lib/sources";

// ---------------------------------------------------------------------------
// Apify discovery source - the Add-source form's apify branch (type:"apify").
// Pins the sources.ts vocab addition (type + label), the run-input JSON parser,
// and the draft validation rule (actorId required + input parses as a JSON
// object) that the form and these tests share (docs/proposals/
// 2026-07-06-apify-discovery-source.md §8). Ticket t-1783339605935.
// ---------------------------------------------------------------------------

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("sources.ts apify vocab", () => {
  it("SOURCE_TYPES includes 'apify' alongside the existing types", () => {
    expect(SOURCE_TYPES).toContain("apify");
    // additive - the existing two are untouched
    expect(SOURCE_TYPES).toContain("employer");
    expect(SOURCE_TYPES).toContain("board");
  });

  it("SOURCE_TYPE_LABEL maps 'apify' to a human label and still covers every type", () => {
    expect(SOURCE_TYPE_LABEL.apify).toBe("Apify");
    for (const t of SOURCE_TYPES) expect(SOURCE_TYPE_LABEL[t].length).toBeGreaterThan(0);
  });

  it("the prefilled input stub is itself a valid JSON object (so a new form is submittable as-is)", () => {
    const parsed = parseApifyInput(APIFY_INPUT_STUB);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toMatchObject({ location: "Toronto, ON", maxItems: 50 });
    // the compact placeholder parses too (it is guidance, not a value)
    expect(parseApifyInput(APIFY_INPUT_PLACEHOLDER).ok).toBe(true);
  });
});

describe("parseApifyInput (friendly JSON object parse, never throws)", () => {
  it("treats empty / whitespace as an empty object (a valid default run input)", () => {
    expect(parseApifyInput("")).toEqual({ ok: true, value: {} });
    expect(parseApifyInput("   \n  ")).toEqual({ ok: true, value: {} });
    expect(parseApifyInput(null)).toEqual({ ok: true, value: {} });
    expect(parseApifyInput(undefined)).toEqual({ ok: true, value: {} });
  });

  it("accepts a JSON object and returns the parsed value", () => {
    const r = parseApifyInput('{"position":"analyst","location":"Toronto, ON","maxItems":50}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ position: "analyst", location: "Toronto, ON", maxItems: 50 });
  });

  it("rejects malformed JSON with a friendly message (no throw)", () => {
    const r = parseApifyInput('{"position": "analyst",}'); // trailing comma
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/i);
  });

  it("rejects valid JSON that is not a plain object (array / scalar / null)", () => {
    for (const notObj of ['["a","b"]', "42", '"a string"', "true", "null"]) {
      const r = parseApifyInput(notObj);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/JSON object/i);
    }
  });
});

describe("validateApifyDraft (the apify branch of the form's draft validation)", () => {
  const ok = { name: "Indeed - Toronto", actorId: "misceres~indeed-scraper", inputText: APIFY_INPUT_STUB };

  it("accepts a name + actorId + a valid JSON object input", () => {
    expect(validateApifyDraft(ok)).toBeNull();
    // an empty input is a valid default too
    expect(validateApifyDraft({ ...ok, inputText: "" })).toBeNull();
  });

  it("requires a non-empty name", () => {
    expect(validateApifyDraft({ ...ok, name: "   " })).toBe("Name is required.");
  });

  it("requires a non-empty actorId", () => {
    expect(validateApifyDraft({ ...ok, actorId: "" })).toBe("Actor ID is required.");
    expect(validateApifyDraft({ ...ok, actorId: "   " })).toBe("Actor ID is required.");
  });

  it("rejects invalid JSON input", () => {
    const err = validateApifyDraft({ ...ok, inputText: "{ not json }" });
    expect(err).toMatch(/not valid JSON/i);
  });

  it("rejects a non-object JSON input (e.g. a bare array)", () => {
    const err = validateApifyDraft({ ...ok, inputText: '["a","b"]' });
    expect(err).toMatch(/JSON object/i);
  });
});

// --- wiring (static source checks, the a11y/instruction-proposals-ui idiom) --
describe("apify form + card wiring (static source checks)", () => {
  const form = read("../src/components/SourceFormDrawer.tsx");
  const card = read("../src/components/SourceCard.tsx");

  it("the form validates the apify branch via validateApifyDraft and keeps validateSourceDraft for the rest", () => {
    expect(form).toContain('validateApifyDraft({ name, actorId, inputText })');
    // non-apify path is byte-identical: still the exact starting-link rule call
    expect(form).toContain("validateSourceDraft({ editing, name, urls })");
  });

  it("the form swaps to Actor ID + Actor input (JSON) when Type = Apify", () => {
    expect(form).toContain('type === "apify"');
    expect(form).toContain("Actor input (JSON)");
    expect(form).toContain("aria-label=\"Actor ID\"");
  });

  it("the form submits type:apify with actorId + the parsed input object", () => {
    expect(form).toContain("actorId: actorId.trim()");
    expect(form).toContain("input: parsed.ok ? parsed.value : {}");
  });

  it("the card gates Run-now on the served apifyConfigured", () => {
    expect(card).toContain('source.type === "apify" && !source.apifyConfigured');
    expect(card).toContain("disabled={busyRun || running || apifyBlocked}");
    expect(card).toContain("Configure APIFY_TOKEN + enable Apify to run");
  });
});
