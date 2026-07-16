// RC-3 / SIM-87 I6 - forbidden-substrings guard (design 5.4 axis 3, guardian
// MF-11). Proves the demo dataset carries ZERO real-vault content, over THREE
// channels: the generated seed, the canned replay transcripts, and the pre-baked
// artifacts. A single case-insensitive hit fails the guard (and the gate).
//
// MF-11 also requires the forbidden LIST itself (which contains the owner's real
// name + real employers - it is PII) to stay OUT of the public repo. So:
//   - demo/forbidden.sample.json is committed: a PLACEHOLDER list of clearly-fake
//     terms, enough to exercise the guard in CI.
//   - the REAL list lives at demo/forbidden.local.json (gitignored) or at the path
//     in DEMO_FORBIDDEN_FILE, and is applied at demo build/reset time on the owner's
//     box. It never ships in the image / the clean-repo extraction.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url));

// Recursively collect every string value reachable from a value (dataset, dataset
// slice, or a parsed transcript). Buffers are decoded utf8 so artifact bytes are
// scanned as text.
export function collectStrings(value, out = []) {
  if (value == null) return out;
  if (Buffer.isBuffer(value)) {
    out.push(value.toString("utf8"));
    return out;
  }
  const t = typeof value;
  if (t === "string") {
    out.push(value);
    return out;
  }
  if (t === "number" || t === "boolean") return out;
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return out;
  }
  if (t === "object") {
    for (const k of Object.keys(value)) {
      collectStrings(k, out); // keys too (a stored key could carry a name)
      collectStrings(value[k], out);
    }
  }
  return out;
}

// Load the effective forbidden list: DEMO_FORBIDDEN_FILE > demo/forbidden.local.json
// (gitignored real list) > demo/forbidden.sample.json (committed placeholder). Each
// term is trimmed; blanks and comment lines (leading '#') are dropped. Returns
// { terms, source }.
export function loadForbiddenList(env = {}) {
  const candidates = [];
  if (env.DEMO_FORBIDDEN_FILE) candidates.push(env.DEMO_FORBIDDEN_FILE);
  candidates.push(path.join(DEMO_DIR, "forbidden.local.json"));
  candidates.push(path.join(DEMO_DIR, "forbidden.sample.json"));
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.terms) ? parsed.terms : [];
      const terms = list
        .map((s) => String(s || "").trim())
        .filter((s) => s && !s.startsWith("#"));
      return { terms, source: file };
    } catch {
      /* try the next candidate */
    }
  }
  return { terms: [], source: null };
}

// Scan a set of strings against a forbidden list (case-insensitive substring).
// Returns the array of hits [{ term, sample }] - empty means clean.
export function scanForbidden(strings, terms) {
  const hits = [];
  const lowered = strings.map((s) => String(s).toLowerCase());
  for (const term of terms) {
    const needle = String(term).toLowerCase();
    if (!needle) continue;
    for (let i = 0; i < lowered.length; i++) {
      if (lowered[i].includes(needle)) {
        hits.push({ term, sample: strings[i].slice(0, 80) });
        break; // one hit per term is enough to fail
      }
    }
  }
  return hits;
}

// The full guard over a demo dataset + any extra text channels (transcript lines,
// pre-baked artifact buffers). Returns { ok, hits, source, scanned }.
export function guardDemoData(dataset, extras = [], env = {}) {
  const { terms, source } = loadForbiddenList(env);
  const strings = collectStrings(dataset);
  for (const extra of extras) collectStrings(extra, strings);
  const hits = scanForbidden(strings, terms);
  return { ok: hits.length === 0, hits, source, scanned: strings.length };
}
