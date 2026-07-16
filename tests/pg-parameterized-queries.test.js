// RC-3 / SIM-87 I6 - MF-12 lock: PgStore uses PARAMETERIZED queries ONLY.
//
// The writable public demo is a live SQL-injection target, so guardian MF-12
// requires every value to cross as a bound parameter and the only interpolated SQL
// fragments to be column/table names drawn from CONSTANT whitelists. This test is a
// STRUCTURAL lock over server/pg-store.js so a future edit that concatenates a value
// into SQL fails the gate.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "pg-store.js"),
  "utf8",
);

// Every `this.pg.query(` first argument, capturing double-quoted strings AND
// (possibly multi-line) backtick templates, PLUS the source index right after the
// captured literal (so we can prove the literal is the WHOLE argument - not a
// `"..." + value` concatenation). The backtick body excludes an internal backtick,
// which none of the query templates contain, so the lazy match closes at the real
// template end.
function queryArgs() {
  const out = [];
  const re = /this\.pg\.query\(\s*(`[^`]*`|"[^"]*")/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({ arg: m[1], after: src.slice(re.lastIndex).replace(/^\s+/, "")[0] });
  }
  return out;
}

// The ONLY SQL fragments allowed to be interpolated into a query template - all
// constant-derived (column names built from the WRITABLE_COLUMN whitelist, the
// $n placeholder index, and the constant DATA_TABLES list). NEVER a client value.
const SAFE_INTERP = [/^sets\.join\(", "\)$/, /^i$/, /^DATA_TABLES\.join\(", "\)$/];

describe("PgStore parameterized-queries lock (MF-12)", () => {
  const args = queryArgs();

  it("finds the PgStore query calls", () => {
    expect(args.length).toBeGreaterThan(10);
  });

  it("no query argument concatenates a value with + (string-built SQL)", () => {
    // The captured literal must be the WHOLE first argument: the next token is the
    // arg separator `,` (params array) or the closing `)`, never `+`.
    for (const { arg, after } of args) {
      expect([",", ")"], `query arg not a single literal: ${arg.slice(0, 40)}...`).toContain(after);
    }
  });

  it("every interpolation inside a query template is a constant whitelist fragment", () => {
    for (const { arg } of args) {
      if (!arg.startsWith("`")) continue; // double-quoted -> no interpolation possible
      const interps = [...arg.matchAll(/\$\{([^}]*)\}/g)].map((mm) => mm[1].trim());
      for (const expr of interps) {
        const safe = SAFE_INTERP.some((re) => re.test(expr));
        expect(safe, `unexpected SQL interpolation \${${expr}} - values must be bound params, not interpolated`).toBe(true);
      }
    }
  });

  it("the interpolated column name derives ONLY from the WRITABLE_COLUMN whitelist", () => {
    // The `${col}` fragments live in the `sets` array; col must be sourced from the
    // constant map, never from client input.
    expect(/const\s+col\s*=\s*WRITABLE_COLUMN\[key\]/.test(src)).toBe(true);
    // and there is no other assignment to `col`
    const colAssigns = [...src.matchAll(/(?:const|let|var)\s+col\s*=/g)];
    expect(colAssigns.length).toBe(1);
  });
});
